import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { decryptSecret } from "@apm/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LiveEventsService } from "../events/live-events.service";
import {
  loadAssignmentPlaceContext,
  upsertProfilePlaceReviewTx,
} from "./profile-place-review";
import { ProxiesService } from "../proxies/proxies.service";

@Injectable()
export class InternalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveEventsService,
    private readonly proxies: ProxiesService,
  ) {}

  /** Cooldown sau MAPS — cấu hình tại Admin → Proxy (SystemSetting). */
  private async mapsProxyCooldownMinutes(): Promise<number> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: "maps_proxy_cooldown_minutes" },
    });
    const n = row ? Number(row.value) : 60;
    if (!Number.isFinite(n) || n < 0) return 60;
    return Math.min(10080, Math.floor(n));
  }

  /** Giải phóng proxy lock. Chỉ đặt cooldown khi đăng Maps thành công. */
  private async releaseJobProxy(
    job:
      | {
          id: string;
          proxyId: string | null;
          taskCode: string;
          payload: unknown;
        }
      | null
      | undefined,
    opts?: { applyCooldown?: boolean },
  ) {
    if (!job?.proxyId || job.taskCode !== "MAPS_REVIEW") return;
    const applyCooldown = opts?.applyCooldown === true;
    const cooldownMinutes = applyCooldown
      ? await this.mapsProxyCooldownMinutes()
      : 0;
    const now = new Date();
    await this.prisma.proxy.updateMany({
      where: { id: job.proxyId, lockedByJobId: job.id },
      data: {
        lockedUntil: null,
        lockedByJobId: null,
        cooldownUntil:
          cooldownMinutes > 0
            ? new Date(now.getTime() + cooldownMinutes * 60_000)
            : null,
      },
    });
  }

  /** MAPS: proxy tunnel/auth fail → đánh FAILED, lock proxy khác cho cùng job ACTIVE. */
  async reswapJobProxy(input: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    failedProxyId?: string;
  }) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: input.profileId },
    });
    if (!profile || profile.leaseToken !== input.leaseToken) {
      throw new BadRequestException("Invalid lease");
    }

    const job = await this.prisma.jobRun.findUnique({
      where: { id: input.jobRunId },
      include: { proxy: true },
    });
    if (!job || job.profileId !== profile.id) {
      throw new BadRequestException("Job not found");
    }
    if (job.status !== "ACTIVE") {
      throw new BadRequestException("Job not active");
    }
    if (job.taskCode !== "MAPS_REVIEW") {
      throw new BadRequestException("Not a MAPS job");
    }

    const failedId = input.failedProxyId || job.proxyId;
    if (failedId) {
      await this.prisma.proxy.updateMany({
        where: { id: failedId, lockedByJobId: job.id },
        data: {
          lockedUntil: null,
          lockedByJobId: null,
          health: "FAILED",
          lastCheckedAt: new Date(),
        },
      });
    } else {
      await this.releaseJobProxy(job, { applyCooldown: false });
    }

    const proxy = await this.proxies.acquireRandomForJob(job.id, 30, null);
    await this.prisma.jobRun.update({
      where: { id: job.id },
      data: { proxyId: proxy.id },
    });

    return {
      proxy: {
        id: proxy.id,
        host: proxy.host,
        port: proxy.port,
        protocol: proxy.protocol,
        username: proxy.usernameEnc ? decryptSecret(proxy.usernameEnc) : null,
        password: proxy.passwordEnc ? decryptSecret(proxy.passwordEnc) : null,
      },
    };
  }

  async claim(input: { profileId: string; leaseToken: string; jobRunId: string; workerId: string }) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: input.profileId },
      include: {
        account: true,
      },
    });
    if (!profile) throw new NotFoundException("Profile not found");
    if (profile.leaseToken !== input.leaseToken) {
      throw new BadRequestException("Lease token mismatch");
    }

    const jobRun = await this.prisma.jobRun.findUnique({
      where: { id: input.jobRunId },
      include: { proxy: true },
    });
    if (!jobRun || jobRun.profileId !== profile.id) {
      throw new BadRequestException("Job not found for profile");
    }
    // Job đã finalize (auto-recover/reset) — job BullMQ cũ không được chạy lại
    if (
      jobRun.status === "FAILED" ||
      jobRun.status === "COMPLETED" ||
      jobRun.status === "DEAD"
    ) {
      throw new BadRequestException("Job already finalized");
    }

    await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { id: profile.id },
        data: { status: "RUNNING", currentTask: profile.currentTask },
      }),
      this.prisma.jobRun.update({
        where: { id: input.jobRunId },
        data: {
          status: "ACTIVE",
          workerId: input.workerId,
          startedAt: new Date(),
        },
      }),
    ]);

    if (jobRun.taskCode === "MAPS_REVIEW") {
      const payload = (jobRun.payload ?? {}) as { assignmentId?: string };
      if (payload.assignmentId) {
        await this.prisma.reviewAssignment
          .update({
            where: { id: payload.assignmentId },
            data: { status: "RUNNING", apmJobRunId: jobRun.id },
          })
          .catch(() => undefined);
      }
    }

    if (jobRun.taskCode === "MAPS_DELETE_REVIEW") {
      const payload = (jobRun.payload ?? {}) as { assignmentId?: string };
      if (payload.assignmentId) {
        await this.prisma.reviewAssignment
          .update({
            where: { id: payload.assignmentId },
            data: {
              // Giữ COMPLETED — chỉ báo đang xóa
              apmJobRunId: jobRun.id,
              error: "Đang xóa trên Maps…",
            },
          })
          .catch(() => undefined);
      }
    }

    const jobProxy = jobRun.proxy;

    return {
      profile: {
        id: profile.id,
        browserIndex: profile.browserIndex,
        browserAlive: profile.browserAlive,
        browserProfilePath: profile.browserProfilePath,
        cookiePath: profile.cookiePath,
        localStoragePath: profile.localStoragePath,
        timezone: profile.timezone,
        language: profile.language,
        userAgent: profile.userAgent,
        viewport: profile.viewport,
        cooldownMinutes: profile.cooldownMinutes,
        currentTask: profile.currentTask,
      },
      account: {
        id: profile.account.id,
        email: profile.account.email,
        password: decryptSecret(profile.account.passwordEnc),
        totpSecret: profile.account.totpSecretEnc
          ? decryptSecret(profile.account.totpSecretEnc)
          : null,
        recoveryEmail: profile.account.recoveryEmail,
        status: profile.account.status,
      },
      /** LOGIN: null. MAPS_REVIEW: proxy đã lock random lúc enqueue. */
      proxy: jobProxy
        ? {
            id: jobProxy.id,
            host: jobProxy.host,
            port: jobProxy.port,
            protocol: jobProxy.protocol,
            username: jobProxy.usernameEnc
              ? decryptSecret(jobProxy.usernameEnc)
              : null,
            password: jobProxy.passwordEnc
              ? decryptSecret(jobProxy.passwordEnc)
              : null,
          }
        : null,
      job: {
        id: jobRun.id,
        taskCode: jobRun.taskCode,
        payload: jobRun.payload,
      },
    };
  }

  async abortCheck(input: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
  }) {
    const [profile, job] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: input.profileId },
        select: { leaseToken: true, status: true },
      }),
      this.prisma.jobRun.findUnique({
        where: { id: input.jobRunId },
        select: { status: true },
      }),
    ]);
    if (!profile) return { abort: true, reason: "profile_gone" };
    if (profile.leaseToken !== input.leaseToken) {
      return { abort: true, reason: "lease_cleared" };
    }
    if (job && (job.status === "FAILED" || job.status === "COMPLETED" || job.status === "DEAD")) {
      return { abort: true, reason: `job_${job.status.toLowerCase()}` };
    }
    return { abort: false };
  }

  async complete(input: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    browserVersion?: string;
    result?: Record<string, unknown>;
    /** Giữ Chrome sống sau job (LOGIN). */
    browserAlive?: boolean;
    workerId?: string;
    /** Đánh dấu account/profile READY sau login thành công. */
    markReady?: boolean;
    /** Mã lỗi login để UI Status (EMAIL_NOT_FOUND / WRONG_PASSWORD / RECAPTCHA…). */
    loginIssue?: string | null;
  }) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: input.profileId },
      include: { account: { select: { id: true, status: true } } },
    });
    if (!profile || profile.leaseToken !== input.leaseToken) {
      throw new BadRequestException("Invalid lease");
    }

    const now = new Date();
    const job = await this.prisma.jobRun.findUnique({ where: { id: input.jobRunId } });
    const durationMs = job?.startedAt ? now.getTime() - job.startedAt.getTime() : null;
    const skipCooldown =
      job?.taskCode === "BROWSER_CHECK" ||
      job?.taskCode === "LOGIN" ||
      job?.taskCode === "MAPS_REVIEW" ||
      job?.taskCode === "MAPS_DELETE_REVIEW";
    const nextRun = skipCooldown
      ? now
      : new Date(now.getTime() + profile.cooldownMinutes * 60_000);

    const markReady = input.markReady === true;
    const browserAlive = input.browserAlive === true;
    const accountWasReady = profile.account.status === "READY";
    // Giữ READY nếu late-ready đã set trước khi complete (tránh race ghi đè UNREADY)
    const alreadyReady = profile.status === "READY" || accountWasReady;

    // LOGIN OK → READY. Giữ READY nếu browserEvent/late-ready đã set trước complete
    // (tránh race: ready xong CDP disconnect → complete ghi đè UNREADY).
    // MAPS_DELETE_REVIEW cố ý tắt Chrome — luôn giữ READY để không phá đăng bài sau.
    const profileStatus =
      markReady || alreadyReady || job?.taskCode === "MAPS_DELETE_REVIEW"
        ? "READY"
        : "UNREADY";

    await this.prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id: profile.id },
        data: {
          status: profileStatus,
          lastRun: now,
          nextRun,
          leaseToken: null,
          leaseUntil: null,
          currentTask: null,
          browserVersion: input.browserVersion,
          browserAlive,
          browserWorkerId: browserAlive ? input.workerId ?? null : null,
          // Proxy chỉ thuộc JobRun — browser/profile mặc định IP máy
          ...(job?.taskCode === "MAPS_REVIEW" ? { proxyId: null } : {}),
        },
      });

      if (profileStatus === "READY") {
        await tx.googleAccount.update({
          where: { id: profile.accountId },
          data: {
            status: "READY",
            ...(markReady ? { lastLogin: now } : {}),
          },
        });
        await tx.$executeRaw`
          UPDATE "GoogleAccount" SET "loginIssue" = NULL, "updatedAt" = NOW()
          WHERE id = ${profile.accountId}
        `;
      } else if (profile.account.status !== "DISABLED") {
        const issue =
          typeof input.loginIssue === "string" && input.loginIssue.trim()
            ? input.loginIssue.trim().slice(0, 64)
            : input.loginIssue === null
              ? null
              : undefined;
        await tx.googleAccount.update({
          where: { id: profile.accountId },
          data: { status: "UNREADY" },
        });
        if (issue !== undefined) {
          if (issue) {
            await tx.$executeRaw`
              UPDATE "GoogleAccount"
              SET "loginIssue" = ${issue}, "updatedAt" = NOW()
              WHERE id = ${profile.accountId}
            `;
          } else {
            await tx.$executeRaw`
              UPDATE "GoogleAccount" SET "loginIssue" = NULL, "updatedAt" = NOW()
              WHERE id = ${profile.accountId}
            `;
          }
        }
      }

      await tx.jobRun.update({
        where: { id: input.jobRunId },
        data: {
          status: "COMPLETED",
          finishedAt: now,
          durationMs: durationMs ?? undefined,
          result: (input.result as object) ?? undefined,
        },
      });

      if (job?.taskCode === "MAPS_REVIEW") {
        const payload = (job.payload ?? {}) as { assignmentId?: string };
        const assignmentId = payload.assignmentId;
        const reviewLinkRaw =
          typeof input.result?.reviewLink === "string"
            ? input.result.reviewLink.trim()
            : "";
        const looksLikeMapsReview =
          !!reviewLinkRaw &&
          !/gstatic\.com|\/_\/mss\/|boq-one-google|\.(css|js)(\?|$)/i.test(
            reviewLinkRaw,
          ) &&
          !(/\/maps\/contrib\/\d+\/reviews\/?(\?|$)/i.test(reviewLinkRaw) &&
            !/!1s|cid=|place/i.test(reviewLinkRaw)) &&
          /maps\/reviews|\/maps\/contrib\/\d+.+|local\/reviews|review\/data|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(
            reviewLinkRaw,
          );
        const reviewLink = looksLikeMapsReview
          ? reviewLinkRaw.startsWith("http")
            ? reviewLinkRaw
            : reviewLinkRaw.startsWith("/")
              ? `https://www.google.com${reviewLinkRaw}`
              : null
          : null;
        if (assignmentId) {
          await tx.reviewAssignment.update({
            where: { id: assignmentId },
            data: {
              status: "COMPLETED",
              ...(reviewLink ? { reviewLink } : {}),
              error: null,
              apmJobRunId: input.jobRunId,
            },
          });
          try {
            const ctx = await loadAssignmentPlaceContext(
              this.prisma,
              assignmentId,
            );
            if (ctx?.assignment.apmProfileId) {
              await upsertProfilePlaceReviewTx(tx, {
                profileId: ctx.assignment.apmProfileId,
                accountEmail: ctx.assignment.profileEmail ?? "",
                placeKey: ctx.placeKey,
                placeName: ctx.project.brandName,
                googleMapsUrl: ctx.project.googleMapsUrl,
                resolvedUrl: ctx.project.resolvedUrl,
                stars: ctx.assignment.stars,
                reviewText: ctx.assignment.reviewText,
                reviewLink,
                assignmentId,
                projectId: ctx.project.id,
                source: "POSTED",
                visibility: reviewLink ? "UNKNOWN" : "VISIBLE",
              });
            }
          } catch (ledgerErr) {
            console.warn(
              "[internal] ledger upsert failed (review still COMPLETED):",
              ledgerErr instanceof Error ? ledgerErr.message : ledgerErr,
            );
          }
          const plan = await tx.reviewAssignment.findUnique({
            where: { id: assignmentId },
            select: { planId: true },
          });
          if (plan) {
            const remaining = await tx.reviewAssignment.count({
              where: {
                planId: plan.planId,
                status: { in: ["PENDING", "QUEUED", "RUNNING"] },
              },
            });
            const failed = await tx.reviewAssignment.count({
              where: { planId: plan.planId, status: "FAILED" },
            });
            if (remaining === 0) {
              await tx.reviewPlan.update({
                where: { id: plan.planId },
                data: { status: failed > 0 ? "FAILED" : "DONE" },
              });
            }
          }
        }
      }

      if (job?.taskCode === "MAPS_DELETE_REVIEW") {
        const payload = (job.payload ?? {}) as { assignmentId?: string };
        const assignmentId = payload.assignmentId;
        const deletedOk =
          input.result?.ok === true ||
          input.result?.alreadyGone === true ||
          input.result?.deleted === true;
        if (assignmentId && deletedOk) {
          try {
            const ctx = await loadAssignmentPlaceContext(
              this.prisma,
              assignmentId,
            );
            // Đánh dấu sổ cái DELETED — mail được đăng lại place (không chặn)
            if (ctx?.assignment.apmProfileId && ctx.placeKey) {
              await upsertProfilePlaceReviewTx(tx, {
                profileId: ctx.assignment.apmProfileId,
                accountEmail: ctx.assignment.profileEmail ?? "",
                placeKey: ctx.placeKey,
                placeName: ctx.project.brandName,
                googleMapsUrl: ctx.project.googleMapsUrl,
                resolvedUrl: ctx.project.resolvedUrl,
                stars: ctx.assignment.stars,
                reviewText: ctx.assignment.reviewText,
                reviewLink: ctx.assignment.reviewLink,
                assignmentId,
                projectId: ctx.project.id,
                source: "POSTED",
                visibility: "DELETED",
              });
            }
          } catch (ledgerErr) {
            console.warn(
              "[internal] delete ledger mark failed:",
              ledgerErr instanceof Error ? ledgerErr.message : ledgerErr,
            );
          }
          // Giữ dòng trong kế hoạch — báo đã xóa
          await tx.reviewAssignment.update({
            where: { id: assignmentId },
            data: {
              status: "SKIPPED",
              error: "Đã xóa trên Maps",
              apmJobRunId: input.jobRunId,
            },
          });
        } else if (assignmentId) {
          const detail =
            typeof input.result?.detail === "string"
              ? input.result.detail
              : "Xóa review thất bại";
          await tx.reviewAssignment.update({
            where: { id: assignmentId },
            data: {
              error: `Xóa thất bại: ${detail}`.slice(0, 2000),
              apmJobRunId: input.jobRunId,
            },
          });
        }
      }
    });

    // DELETE không dùng proxy — không cooldown proxy
    await this.releaseJobProxy(job, {
      applyCooldown: job?.taskCode !== "MAPS_DELETE_REVIEW",
    });

    return { ok: true, nextRun, browserIndex: profile.browserIndex, browserAlive, markReady, status: profileStatus };
  }

  async fail(input: {
    profileId: string;
    leaseToken: string;
    jobRunId: string;
    error: string;
    stacktrace?: string;
    disableProfile?: boolean;
    browserAlive?: boolean;
    workerId?: string;
  }) {
    const profile = await this.prisma.profile.findUnique({ where: { id: input.profileId } });
    if (!profile || profile.leaseToken !== input.leaseToken) {
      throw new BadRequestException("Invalid lease");
    }

    const now = new Date();
    const job = await this.prisma.jobRun.findUnique({ where: { id: input.jobRunId } });
    const durationMs = job?.startedAt ? now.getTime() - job.startedAt.getTime() : null;
    const nextRun = new Date(now.getTime() + profile.cooldownMinutes * 60_000);
    const browserAlive = input.browserAlive === true;
    /** Lỗi Chrome/CDP tạm — không phải mất session login → giữ READY + cho đăng lại. */
    const chromeTransient =
      /Start-Process Chrome failed|Chrome executable not found|devtools|waitForDevTools|ECONNREFUSED|spawn.*chrome|cmd-fallback|Connection closed|Target closed|Session closed|Protocol error|WebSocket is not open|Navigating frame was detached|Execution context was destroyed|browser has disconnected|Browser\.disconnected|net::ERR_|timeout.*chrome|Chrome kẹt|launch conflict/i.test(
        input.error,
      );
    const keepReady =
      !input.disableProfile &&
      ((job?.taskCode === "MAPS_REVIEW" &&
        browserAlive &&
        (profile.status === "READY" ||
          profile.status === "RUNNING" ||
          profile.status === "QUEUED")) ||
        (job?.taskCode === "MAPS_REVIEW" && chromeTransient) ||
        // DELETE cố ý tắt Chrome — account vẫn READY để đăng bài sau
        (job?.taskCode === "MAPS_DELETE_REVIEW" &&
          (profile.status === "READY" ||
            profile.status === "RUNNING" ||
            profile.status === "QUEUED" ||
            chromeTransient)) ||
        (job?.taskCode === "LOGIN" && chromeTransient && profile.status === "READY"));

    await this.prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id: profile.id },
        data: {
          status: input.disableProfile ? "ERROR" : keepReady ? "READY" : "UNREADY",
          lastRun: now,
          nextRun,
          leaseToken: null,
          leaseUntil: null,
          currentTask: null,
          browserAlive: keepReady ? browserAlive : browserAlive,
          browserWorkerId: browserAlive ? input.workerId ?? null : null,
          ...(job?.taskCode === "MAPS_REVIEW" ? { proxyId: null } : {}),
        },
      });
      await tx.googleAccount.update({
        where: { id: profile.accountId },
        data: {
          status: input.disableProfile ? "ERROR" : keepReady ? "READY" : "UNREADY",
        },
      });
      await tx.jobRun.update({
        where: { id: input.jobRunId },
        data: {
          status: "FAILED",
          finishedAt: now,
          durationMs: durationMs ?? undefined,
          error: input.error.slice(0, 2000),
          stacktrace: input.stacktrace?.slice(0, 8000),
          retryCount: { increment: 1 },
        },
      });

      if (job?.taskCode === "MAPS_REVIEW") {
        const payload = (job.payload ?? {}) as { assignmentId?: string };
        if (payload.assignmentId) {
          const transientChrome = chromeTransient;
          await tx.reviewAssignment.update({
            where: { id: payload.assignmentId },
            data: transientChrome
              ? {
                  status: "PENDING",
                  // Giữ lỗi ngắn để UI biết; tick sau sẽ đăng lại (đừng FAILED)
                  error: `Tạm lỗi Chrome — sẽ tự thử lại: ${input.error}`.slice(0, 2000),
                  apmJobRunId: null,
                  // Đưa lại vào cửa sổ lịch nếu vừa bị Connection closed
                  scheduledAt: now,
                }
              : {
                  status: "FAILED",
                  error: input.error.slice(0, 2000),
                  apmJobRunId: input.jobRunId,
                },
          });
          if (/ALREADY_REVIEWED_AT_PLACE/i.test(input.error)) {
            try {
              const ctx = await loadAssignmentPlaceContext(
                this.prisma,
                payload.assignmentId,
              );
              if (ctx?.assignment.apmProfileId) {
                await upsertProfilePlaceReviewTx(tx, {
                  profileId: ctx.assignment.apmProfileId,
                  accountEmail: ctx.assignment.profileEmail ?? "",
                  placeKey: ctx.placeKey,
                  placeName: ctx.project.brandName,
                  googleMapsUrl: ctx.project.googleMapsUrl,
                  resolvedUrl: ctx.project.resolvedUrl,
                  stars: ctx.assignment.stars,
                  reviewText: ctx.assignment.reviewText,
                  assignmentId: payload.assignmentId,
                  projectId: ctx.project.id,
                  source: "DETECTED_ABORT",
                  visibility: "VISIBLE",
                });
              }
            } catch (ledgerErr) {
              console.warn(
                "[internal] ledger on ALREADY_REVIEWED failed:",
                ledgerErr instanceof Error ? ledgerErr.message : ledgerErr,
              );
            }
          }
          const planId = (
            await tx.reviewAssignment.findUnique({
              where: { id: payload.assignmentId },
              select: { planId: true },
            })
          )?.planId;
          if (planId) {
            const remaining = await tx.reviewAssignment.count({
              where: {
                planId,
                status: { in: ["PENDING", "QUEUED", "RUNNING"] },
              },
            });
            if (remaining === 0) {
              await tx.reviewPlan.update({
                where: { id: planId },
                data: { status: "FAILED" },
              });
            }
          }
        }
      }

      if (job?.taskCode === "MAPS_DELETE_REVIEW") {
        const payload = (job.payload ?? {}) as { assignmentId?: string };
        if (payload.assignmentId) {
          await tx.reviewAssignment.update({
            where: { id: payload.assignmentId },
            data: {
              // Giữ COMPLETED — báo lỗi xóa
              error: `Xóa thất bại: ${input.error}`.slice(0, 2000),
              apmJobRunId: input.jobRunId,
            },
          });
        }
      }
    });

    // Fail / abort: nhả lock, KHÔNG cooldown — chưa đăng thành công thì không giữ proxy
    await this.releaseJobProxy(job, { applyCooldown: false });

    return { ok: true };
  }

  /** Worker báo browser index đã mở / đóng / đã login → READY. */
  async browserEvent(input: {
    profileId: string;
    workerId: string;
    event: "opened" | "closed" | "ready";
    browserVersion?: string;
  }) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: input.profileId },
    });
    if (!profile) throw new NotFoundException("Profile not found");

    if (input.event === "opened") {
      await this.prisma.profile.update({
        where: { id: profile.id },
        data: {
          browserAlive: true,
          browserWorkerId: input.workerId,
          browserVersion: input.browserVersion,
        },
      });
      const account = await this.prisma.googleAccount.findUnique({
        where: { id: profile.accountId },
        select: { email: true },
      });
      this.live.push({
        type: "browser.opened",
        message: `Browser #${profile.browserIndex} đã mở — ${account?.email || profile.id}`,
        profileId: profile.id,
        browserIndex: profile.browserIndex,
        email: account?.email,
        status: "UNREADY",
      });
      return { ok: true, browserIndex: profile.browserIndex, status: profile.status };
    }

    if (input.event === "closed") {
      // Chrome tắt ≠ mất session: nếu đã READY thì chỉ tắt alive, giữ READY để Mở lại nhanh
      const keepReady = profile.status === "READY";
      const nextStatus =
        profile.status === "DISABLED" ? "DISABLED" : keepReady ? "READY" : "UNREADY";
      await this.prisma.$transaction([
        this.prisma.profile.update({
          where: { id: profile.id },
          data: {
            status: nextStatus,
            browserAlive: false,
            browserWorkerId: null,
          },
        }),
        this.prisma.googleAccount.update({
          where: { id: profile.accountId },
          data: {
            status:
              profile.status === "DISABLED"
                ? "DISABLED"
                : keepReady
                  ? "READY"
                  : "UNREADY",
          },
        }),
      ]);
      const account = await this.prisma.googleAccount.findUnique({
        where: { id: profile.accountId },
        select: { email: true },
      });
      this.live.push({
        type: "browser.closed",
        message: `Browser #${profile.browserIndex} đã tắt — ${account?.email || profile.id}${keepReady ? " (giữ READY)" : " → UNREADY"}`,
        profileId: profile.id,
        browserIndex: profile.browserIndex,
        email: account?.email,
        status: nextStatus,
      });
      return { ok: true, browserIndex: profile.browserIndex, status: nextStatus };
    }

    // ready = đã login trên browser sống
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { id: profile.id },
        data: {
          status: "READY",
          browserAlive: true,
          browserWorkerId: input.workerId,
          browserVersion: input.browserVersion,
          lastRun: now,
        },
      }),
      this.prisma.googleAccount.update({
        where: { id: profile.accountId },
        data: { status: "READY", lastLogin: now },
      }),
    ]);
    await this.prisma.$executeRaw`
      UPDATE "GoogleAccount" SET "loginIssue" = NULL, "updatedAt" = NOW()
      WHERE id = ${profile.accountId}
    `;
    const account = await this.prisma.googleAccount.findUnique({
      where: { id: profile.accountId },
      select: { email: true },
    });
    this.live.push({
      type: "browser.ready",
      message: `Browser #${profile.browserIndex} READY — ${account?.email || profile.id}`,
      profileId: profile.id,
      browserIndex: profile.browserIndex,
      email: account?.email,
      status: "READY",
    });

    return { ok: true, browserIndex: profile.browserIndex, status: "READY" };
  }

  /** Worker restart → clear cờ alive (giữ keepProfileIds đã reclaim). */
  async resetBrowserAlive(
    workerId?: string,
    all = false,
    keepProfileIds: string[] = [],
  ) {
    const keep = new Set(keepProfileIds);
    const where = all
      ? { browserAlive: true }
      : workerId
        ? { browserAlive: true, OR: [{ browserWorkerId: workerId }, { browserWorkerId: null }] }
        : { browserAlive: true };

    const candidates = await this.prisma.profile.findMany({
      where,
      select: { id: true, accountId: true, status: true },
    });
    const toClear = candidates.filter((p) => !keep.has(p.id));

    if (toClear.length) {
      // Chỉ tắt cờ alive — không đạp READY (session cookie vẫn còn trên disk)
      await this.prisma.profile.updateMany({
        where: { id: { in: toClear.map((p) => p.id) } },
        data: {
          browserAlive: false,
          browserWorkerId: null,
        },
      });
      this.live.push({
        type: "info",
        message: `Đã clear ${toClear.length} browser alive giả (worker restart / sync)`,
      });
    }

    return { ok: true, cleared: toClear.length, kept: keep.size };
  }

  async listProfilesForReclaim() {
    const rows = await this.prisma.profile.findMany({
      where: { status: { not: "DISABLED" } },
      select: {
        id: true,
        browserIndex: true,
        browserProfilePath: true,
        cookiePath: true,
        proxyId: true,
        account: { select: { email: true } },
      },
      orderBy: { browserIndex: "asc" },
    });
    return { profiles: rows };
  }

  /** Worker cập nhật lỗi login realtime (UI Status). */
  async setLoginIssue(input: {
    profileId: string;
    workerId: string;
    issue: string | null;
  }) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: input.profileId },
      select: { accountId: true, account: { select: { status: true } } },
    });
    if (!profile) throw new NotFoundException("Profile not found");
    if (profile.account.status === "DISABLED") {
      return { ok: true, skipped: true };
    }
    const issue =
      input.issue == null || input.issue === ""
        ? null
        : String(input.issue).trim().slice(0, 64);

    // Raw SQL — tránh phụ thuộc Prisma client regenerate khi DLL đang bị process lock
    if (issue) {
      await this.prisma.$executeRaw`
        UPDATE "GoogleAccount"
        SET "loginIssue" = ${issue}, status = 'UNREADY', "updatedAt" = NOW()
        WHERE id = ${profile.accountId}
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE "GoogleAccount"
        SET "loginIssue" = NULL, "updatedAt" = NOW()
        WHERE id = ${profile.accountId}
      `;
    }
    return { ok: true, issue };
  }

  /**
   * Đồng bộ alive theo CDP thật của worker.
   * Có trong list → alive. Không còn (user đã tắt Chrome) → off (giữ READY).
   */
  async syncAliveBrowsers(workerId: string, aliveProfileIds: string[]) {
    const alive = new Set(aliveProfileIds);

    // Tắt mọi profile đang gắn worker này (hoặc worker null) mà không còn trong list
    const claimed = await this.prisma.profile.findMany({
      where: {
        browserAlive: true,
        OR: [{ browserWorkerId: workerId }, { browserWorkerId: null }],
      },
      select: { id: true },
    });
    const toClear = claimed.filter((row) => !alive.has(row.id)).map((row) => row.id);
    if (toClear.length) {
      await this.prisma.profile.updateMany({
        where: { id: { in: toClear } },
        data: { browserAlive: false, browserWorkerId: null },
      });
    }

    if (alive.size) {
      await this.prisma.profile.updateMany({
        where: { id: { in: [...alive] } },
        data: { browserAlive: true, browserWorkerId: workerId },
      });
    }

    return { ok: true, cleared: toClear.length, alive: alive.size };
  }
}
