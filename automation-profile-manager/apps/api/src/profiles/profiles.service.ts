import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createProfileSchema, enqueueTaskSchema, TaskCode } from "@apm/shared";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProxiesService } from "../proxies/proxies.service";
import { QueueService } from "../queue/queue.service";

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly proxies: ProxiesService,
    private readonly queue: QueueService,
  ) {}

  list() {
    return this.prisma.profile.findMany({
      orderBy: { browserIndex: "asc" },
      include: {
        account: { select: { id: true, email: true, status: true } },
        proxy: {
          select: {
            id: true,
            host: true,
            port: true,
            country: true,
            status: true,
            health: true,
          },
        },
      },
    });
  }

  async get(id: string) {
    const row = await this.prisma.profile.findUnique({
      where: { id },
      include: {
        account: { select: { id: true, email: true, status: true } },
        proxy: {
          select: {
            id: true,
            host: true,
            port: true,
            country: true,
            status: true,
            health: true,
          },
        },
        jobs: { take: 20, orderBy: { createdAt: "desc" } },
      },
    });
    if (!row) throw new NotFoundException("Profile not found");
    return row;
  }

  private async nextBrowserIndex(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
  ) {
    const agg = await tx.profile.aggregate({ _max: { browserIndex: true } });
    return (agg._max.browserIndex ?? 0) + 1;
  }

  async create(input: z.infer<typeof createProfileSchema>) {
    const data = createProfileSchema.parse(input);

    const account = await this.prisma.googleAccount.findUnique({
      where: { id: data.accountId },
    });
    if (!account) throw new NotFoundException("Account not found");

    const existing = await this.prisma.profile.findUnique({
      where: { accountId: data.accountId },
    });
    if (existing) throw new BadRequestException("Account already has a profile");

    // Sticky proxy optional (legacy). Mail mới không gắn proxy — proxy lấy lúc chạy job.
    if (data.proxyId) {
      await this.proxies.assertCanAssign(data.proxyId);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      if (data.proxyId) {
        const count = await tx.proxyAssignment.count({ where: { proxyId: data.proxyId } });
        const proxy = await tx.proxy.findUniqueOrThrow({ where: { id: data.proxyId } });
        if (count >= proxy.maxProfiles) {
          throw new BadRequestException("Proxy profile capacity exceeded");
        }
      }

      const browserIndex = await this.nextBrowserIndex(tx);

      const profile = await tx.profile.create({
        data: {
          accountId: data.accountId,
          proxyId: data.proxyId ?? null,
          browserIndex,
          browserAlive: false,
          browserProfilePath: `profiles/${data.accountId}`,
          cookiePath: `profiles/${data.accountId}/cookies.json`,
          localStoragePath: `profiles/${data.accountId}/localStorage.json`,
          cooldownMinutes: data.cooldownMinutes,
          timezone: data.timezone ?? null,
          language: data.language ?? null,
          userAgent: data.userAgent ?? null,
          viewport: data.viewport ?? undefined,
          status: "UNREADY",
          nextRun: new Date(),
        },
      });

      await tx.googleAccount.update({
        where: { id: data.accountId },
        data: { status: "UNREADY" },
      });

      if (data.proxyId) {
        await tx.proxyAssignment.create({
          data: { proxyId: data.proxyId, profileId: profile.id },
        });
      }

      return profile;
    });

    return this.get(created.id);
  }

  /** Tạo hồ sơ browser + LOGIN (không gắn proxy). Proxy chỉ lấy random khi chạy bình luận. */
  async autoAssign(
    accountId: string,
    cooldownMinutes = 60,
    opts: { openLogin?: boolean } = { openLogin: true },
  ) {
    const profile = await this.create({
      accountId,
      cooldownMinutes,
    });

    let loginJob: { jobRunId: string; leaseToken: string; taskCode: string } | null = null;
    if (opts.openLogin !== false) {
      loginJob = await this.enqueue(profile.id, { taskCode: "LOGIN" });
    }

    return { ...profile, loginJob };
  }

  /** Tạo profile cho mọi account chưa có — lần lượt; chỉ LOGIN cái đầu nếu openLogin. */
  async autoAssignUnassigned(cooldownMinutes = 60, openLogin = false) {
    const accounts = await this.prisma.googleAccount.findMany({
      where: { profile: null, status: { not: "DISABLED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true },
    });

    const assigned: Array<{
      accountId: string;
      email: string;
      profileId: string;
      proxyId: string | null;
      browserIndex: number;
      jobRunId?: string;
    }> = [];
    const failed: Array<{ accountId: string; email: string; error: string }> = [];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!;
      try {
        const openThis = openLogin && i === 0;
        const profile = await this.autoAssign(acc.id, cooldownMinutes, {
          openLogin: openThis,
        });
        assigned.push({
          accountId: acc.id,
          email: acc.email,
          profileId: profile.id,
          proxyId: profile.proxyId,
          browserIndex: profile.browserIndex,
          jobRunId: profile.loginJob?.jobRunId,
        });
      } catch (e) {
        failed.push({
          accountId: acc.id,
          email: acc.email,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      ok: true,
      assigned: assigned.length,
      failed: failed.length,
      rows: assigned,
      errors: failed,
      message: openLogin
        ? `Đã tạo ${assigned.length} hồ sơ — chỉ LOGIN 1 hồ sơ đầu (các cái còn lại bấm Mở lần lượt).`
        : `Đã tạo ${assigned.length} hồ sơ browser (chưa mở Chrome).`,
    };
  }

  async update(
    id: string,
    input: Partial<{
      proxyId: string;
      cooldownMinutes: number;
      status: "UNREADY" | "READY";
      timezone: string | null;
      language: string | null;
      userAgent: string | null;
    }>,
  ) {
    const profile = await this.get(id);

    if (input.proxyId && input.proxyId !== profile.proxyId) {
      await this.proxies.assertCanAssign(input.proxyId);
      await this.prisma.$transaction(async (tx) => {
        await tx.proxyAssignment.deleteMany({ where: { profileId: id } });
        await tx.proxyAssignment.create({
          data: { proxyId: input.proxyId!, profileId: id },
        });
        await tx.profile.update({
          where: { id },
          data: {
            proxyId: input.proxyId,
            cooldownMinutes: input.cooldownMinutes,
            status: input.status,
            timezone: input.timezone,
            language: input.language,
            userAgent: input.userAgent,
          },
        });
      });
      return this.get(id);
    }

    return this.prisma.profile.update({
      where: { id },
      data: {
        cooldownMinutes: input.cooldownMinutes,
        status: input.status,
        timezone: input.timezone,
        language: input.language,
        userAgent: input.userAgent,
      },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.profile.delete({ where: { id } });
    return { ok: true };
  }

  async enqueue(id: string, body: unknown) {
    const parsed = enqueueTaskSchema.parse(body ?? {});
    const { taskCode, payload } = parsed;
    if (taskCode === "MAPS_REVIEW" && !payload) {
      throw new BadRequestException("MAPS_REVIEW requires payload");
    }
    const profile = await this.get(id);
    if (profile.status === "DISABLED") {
      throw new BadRequestException("Profile is disabled");
    }
    if (profile.status === "RUNNING" || profile.status === "QUEUED") {
      throw new BadRequestException("Profile already queued/running");
    }

    const leaseToken = randomUUID();
    // LOGIN có captcha/verify — lease dài; task khác 5 phút
    const leaseMs =
      taskCode === "LOGIN" ? 45 * 60 * 1000 : 5 * 60 * 1000;
    const leaseUntil = new Date(Date.now() + leaseMs);

    const jobRun = await this.prisma.$transaction(async (tx) => {
      await tx.profile.update({
        where: { id },
        data: {
          status: "QUEUED",
          leaseToken,
          leaseUntil,
          currentTask: taskCode,
        },
      });
      return tx.jobRun.create({
        data: {
          profileId: id,
          taskCode,
          status: "PENDING",
          payload: payload
            ? (payload as unknown as Prisma.InputJsonValue)
            : undefined,
        },
      });
    });

    // MAPS_REVIEW: lock random proxy lúc enqueue (tách khỏi mail/profile)
    if (taskCode === "MAPS_REVIEW") {
      try {
        const proxy = await this.proxies.acquireRandomForJob(jobRun.id);
        await this.prisma.jobRun.update({
          where: { id: jobRun.id },
          data: { proxyId: proxy.id },
        });
      } catch (e) {
        // Rollback profile lease + job nếu không có proxy
        await this.prisma.$transaction([
          this.prisma.profile.update({
            where: { id },
            data: {
              status: profile.status === "READY" ? "READY" : "UNREADY",
              leaseToken: null,
              leaseUntil: null,
              currentTask: null,
            },
          }),
          this.prisma.jobRun.update({
            where: { id: jobRun.id },
            data: {
              status: "FAILED",
              finishedAt: new Date(),
              error: e instanceof Error ? e.message : String(e),
            },
          }),
        ]);
        throw e;
      }
    }

    await this.queue.enqueue({
      profileId: id,
      taskCode: taskCode as TaskCode,
      leaseToken,
      jobRunId: jobRun.id,
      payload: payload ?? null,
    });

    return { jobRunId: jobRun.id, leaseToken, taskCode };
  }

  /**
   * Smart open:
   * - Đã READY + browserAlive → chỉ focus
   * - Browser đang mở nhưng chưa READY (verify/captcha/…) → LOGIN lại để tự điền (reuse Chrome, không kill)
   * - Đang LOGIN còn lease → pending + focus
   * - else → enqueue LOGIN
   */
  async openBrowser(id: string) {
    const profile = await this.get(id);

    const fullyReady =
      profile.browserAlive &&
      profile.status === "READY" &&
      profile.account?.status === "READY";

    if (fullyReady) {
      try {
        await this.queue.enqueueFocusAndWait(id);
        return {
          ok: true,
          action: "focus" as const,
          profileId: id,
          browserIndex: profile.browserIndex,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/không còn mở|không có page|thất bại|timeout|timed out/i.test(msg)) {
          console.warn(
            `[profiles] focus failed #${profile.browserIndex}: ${msg} — fallback LOGIN`,
          );
        } else {
          throw e;
        }
      }
    }

    if (
      (profile.status === "QUEUED" || profile.status === "RUNNING") &&
      profile.currentTask === "LOGIN"
    ) {
      const leaseOk =
        profile.leaseUntil && new Date(profile.leaseUntil).getTime() > Date.now();
      // Chrome còn mở / lease còn → chỉ focus, KHÔNG re-enqueue (tránh kill cửa sổ đang login)
      if (leaseOk || profile.browserAlive) {
        if (!leaseOk && profile.browserAlive) {
          await this.prisma.profile.update({
            where: { id },
            data: { leaseUntil: new Date(Date.now() + 45 * 60 * 1000) },
          });
          console.warn(
            `[profiles] LOGIN #${profile.browserIndex} lease hết nhưng Chrome còn — gia hạn + focus`,
          );
        }
        await this.queue.enqueueFocusAndWait(id).catch(() => undefined);
        return {
          ok: true,
          action: "pending" as const,
          profileId: id,
          browserIndex: profile.browserIndex,
          currentTask: profile.currentTask,
        };
      }
      console.warn(
        `[profiles] stale LOGIN lease on #${profile.browserIndex} — re-enqueue`,
      );
    }

    // Hủy LOGIN cũ còn chờ — tránh 2 job tranh nhau kill/relaunch
    await this.queue.cancelForProfiles([id]).catch(() => undefined);

    const keepReady =
      profile.status === "READY" || profile.account?.status === "READY";
    await this.prisma.profile.update({
      where: { id },
      data: {
        leaseToken: null,
        leaseUntil: null,
        currentTask: null,
        status:
          profile.status === "DISABLED" || profile.status === "ERROR"
            ? "UNREADY"
            : keepReady
              ? "READY"
              : "UNREADY",
        // Giữ browserAlive nếu Chrome còn — LOGIN sẽ reuse pool / DevTools
        browserWorkerId: null,
      },
    });

    // Đưa cửa sổ lên ngay rồi chạy LOGIN (tự điền email/mk/2FA trên trang verify)
    if (profile.browserAlive) {
      await this.queue.enqueueFocus(id).catch(() => undefined);
    }

    const job = await this.enqueue(id, { taskCode: "LOGIN" });
    return {
      ...job,
      action: "login" as const,
      browserIndex: profile.browserIndex,
      resumed: Boolean(profile.browserAlive),
    };
  }

  /** Đưa cửa sổ Chrome lên màn hình — chờ worker focus xong. */
  async focusBrowser(id: string) {
    const profile = await this.get(id);
    try {
      await this.queue.enqueueFocusAndWait(id);
      return {
        ok: true,
        action: "focus" as const,
        profileId: id,
        browserIndex: profile.browserIndex,
        browserAlive: true,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Chrome không còn → mở lại bằng LOGIN
      if (/không còn mở|không có page/i.test(msg) || !profile.browserAlive) {
        return this.openBrowser(id);
      }
      throw e;
    }
  }

  async releaseLease(id: string) {
    const profile = await this.get(id);
    await this.prisma.profile.update({
      where: { id },
      data: {
        status: profile.account.status === "READY" ? "READY" : "UNREADY",
        leaseToken: null,
        leaseUntil: null,
        currentTask: null,
      },
    });
    return { ok: true };
  }

  /**
   * Dừng job QUEUED/RUNNING + xóa queue chờ.
   * Clear loginIssue RECAPTCHA/CHALLENGE để banner UI tắt.
   * Không đụng READY / lỗi cứng (sai mk, email…).
   */
  async stopJobs(input?: { profileIds?: string[]; all?: boolean }) {
    const all = Boolean(input?.all || !input?.profileIds?.length);
    const selectedIds = input?.profileIds?.filter(Boolean) ?? [];

    const runningProfiles = await this.prisma.profile.findMany({
      where: all
        ? { status: { in: ["QUEUED", "RUNNING"] } }
        : {
            id: { in: selectedIds },
            status: { in: ["QUEUED", "RUNNING"] },
          },
      select: {
        id: true,
        accountId: true,
        account: { select: { status: true, email: true } },
      },
    });

    const captchaAccounts = await this.prisma.googleAccount.findMany({
      where: {
        loginIssue: { in: ["RECAPTCHA", "CHALLENGE"] },
        ...(all ? {} : { profile: { id: { in: selectedIds } } }),
      },
      select: { id: true, email: true, profile: { select: { id: true } } },
    });

    const profileIds = new Set(runningProfiles.map((p) => p.id));
    for (const a of captchaAccounts) {
      if (a.profile?.id) profileIds.add(a.profile.id);
    }

    let ids = [...profileIds];
    if (all) {
      const waitingIds = await this.queue.listWaitingProfileIds();
      ids = [...new Set([...ids, ...waitingIds])];
    }

    const { removed } = await this.queue.cancelForProfiles(ids);

    if (ids.length) {
      await this.prisma.jobRun.updateMany({
        where: {
          profileId: { in: ids },
          status: { in: ["PENDING", "ACTIVE"] },
        },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: "Cancelled by admin",
        },
      });
    }

    for (const p of runningProfiles) {
      await this.prisma.profile.update({
        where: { id: p.id },
        data: {
          status: p.account.status === "READY" ? "READY" : "UNREADY",
          leaseToken: null,
          leaseUntil: null,
          currentTask: null,
        },
      });
    }

    const accountIds = [
      ...new Set([
        ...runningProfiles.map((p) => p.accountId),
        ...captchaAccounts.map((a) => a.id),
      ]),
    ];

    let clearedCaptcha = 0;
    if (accountIds.length) {
      const cleared = await this.prisma.googleAccount.updateMany({
        where: {
          id: { in: accountIds },
          loginIssue: { in: ["RECAPTCHA", "CHALLENGE"] },
        },
        data: { loginIssue: null },
      });
      clearedCaptcha = cleared.count;
    }

    if (!runningProfiles.length && !clearedCaptcha && !removed) {
      return {
        ok: true,
        stopped: 0,
        queueRemoved: 0,
        clearedCaptcha: 0,
        message: "Không có job / captcha đang chờ",
      };
    }

    return {
      ok: true,
      stopped: runningProfiles.length,
      clearedCaptcha,
      queueRemoved: removed,
      message: `Đã dừng ${runningProfiles.length} job, xóa ${removed} queue, tắt ${clearedCaptcha} cảnh báo captcha.`,
    };
  }
}
