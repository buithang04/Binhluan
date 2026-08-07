import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { decryptSecret, encryptSecret } from "@apm/crypto";
import {
  accountProfileUpdatePayloadSchema,
  createAccountSchema,
  normalizeTotpSecret,
} from "@apm/shared";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { ProfilesService } from "../profiles/profiles.service";
import {
  cacheAccountAvatarFromUrl,
  cacheUploadedAccountAvatar,
} from "./avatar-cache";

function tryDecrypt(payload: unknown): string | null {
  if (!payload) return null;
  try {
    return decryptSecret(payload as Uint8Array | Buffer);
  } catch {
    return null;
  }
}

function accountPublic<T extends { passwordEnc?: unknown; totpSecretEnc?: unknown | null }>(
  row: T,
) {
  const { passwordEnc, totpSecretEnc, ...safe } = row;
  const password = tryDecrypt(passwordEnc);
  const totpSecret = tryDecrypt(totpSecretEnc);
  return {
    ...safe,
    password: password ?? "",
    totpSecret: totpSecret ?? "",
    hasPassword: Boolean(passwordEnc),
    hasTotp: Boolean(totpSecretEnc),
  };
}

/** NFD không tách đ/Đ — phải map tay, nếu không "Địa chỉ" thành "iachi". */
function normFieldKey(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

function pickProfileField(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const norm = normFieldKey(key);
    for (const [k, v] of Object.entries(raw)) {
      if (normFieldKey(k) === norm && v != null && String(v).trim()) {
        return String(v).trim();
      }
    }
  }
  return null;
}

function totpEncFromInput(totpSecret?: string | null) {
  if (totpSecret == null) return undefined;
  const n = normalizeTotpSecret(totpSecret);
  if (!n) return undefined;
  if (n.length < 16) {
    throw new BadRequestException(
      `Mã 2FA quá ngắn (${n.length} ký tự) — dán full secret Authenticator (tối thiểu 16 ký tự Base32), không phải mã 6 số.`,
    );
  }
  return encryptSecret(n) as any;
}
/** Resolve thư mục profile thật (worker lưu Chrome tại apps/worker/data/profiles). */
function resolveStorageDir() {
  const fromEnv = process.env.PROFILE_STORAGE_DIR || "./data/profiles";
  if (path.isAbsolute(fromEnv)) return fromEnv;
  const candidates = [
    path.resolve(process.cwd(), fromEnv),
    path.resolve(process.cwd(), "../worker/data/profiles"),
    path.resolve(process.cwd(), "../../apps/worker/data/profiles"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  async list() {
    const rows = await this.prisma.googleAccount.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        profile: {
          select: {
            id: true,
            status: true,
            nextRun: true,
            browserIndex: true,
            browserAlive: true,
            proxy: {
              select: { id: true, host: true, port: true, country: true },
            },
          },
        },
      },
    });
    // Ghép loginIssue (cột mới — raw nếu Prisma client chưa regenerate)
    const extras = await this.prisma.$queryRaw<
      Array<{
        id: string;
        loginIssue: string | null;
        desiredName: string | null;
        desiredAddress: string | null;
        desiredAvatarUrl: string | null;
        avatarLocalPath: string | null;
        profileSyncStatus: string | null;
        profileSyncError: string | null;
        profileSyncedAt: Date | null;
        googleName: string | null;
        googleAvatar: string | null;
      }>
    >`SELECT id, "loginIssue", "desiredName", "desiredAddress", "desiredAvatarUrl", "avatarLocalPath", "profileSyncStatus", "profileSyncError", "profileSyncedAt", "googleName", "googleAvatar" FROM "GoogleAccount"`;
    const extraById = new Map(extras.map((e) => [e.id, e]));
    return rows.map((r) => ({
      ...accountPublic(r),
      loginIssue: extraById.get(r.id)?.loginIssue ?? null,
      desiredName: extraById.get(r.id)?.desiredName ?? null,
      desiredAddress: extraById.get(r.id)?.desiredAddress ?? null,
      desiredAvatarUrl: extraById.get(r.id)?.desiredAvatarUrl ?? null,
      avatarLocalPath: extraById.get(r.id)?.avatarLocalPath ?? null,
      profileSyncStatus: extraById.get(r.id)?.profileSyncStatus ?? null,
      profileSyncError: extraById.get(r.id)?.profileSyncError ?? null,
      profileSyncedAt: extraById.get(r.id)?.profileSyncedAt ?? null,
      googleName: extraById.get(r.id)?.googleName ?? null,
      googleAvatar: extraById.get(r.id)?.googleAvatar ?? null,
    }));
  }

  async get(id: string) {
    const row = await this.prisma.googleAccount.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row) throw new NotFoundException("Account not found");
    return accountPublic(row);
  }

  async create(input: z.infer<typeof createAccountSchema>) {
    const data = createAccountSchema.parse(input);
    const totpSecretEnc = totpEncFromInput(data.totpSecret);
    return accountPublic(
      await this.prisma.googleAccount.create({
        data: {
          email: data.email.trim().toLowerCase(),
          passwordEnc: encryptSecret(data.password) as any,
          ...(totpSecretEnc ? { totpSecretEnc } : {}),
          recoveryEmail: data.recoveryEmail ?? null,
          recoveryPhone: data.recoveryPhone ?? null,
          status: data.status ?? "UNREADY",
        },
      }),
    );
  }

  /**
   * Import hàng loạt từ Excel/JSON: [{ email, password, recoveryEmail? }]
   * Trùng email → skip (không ghi đè mk trừ khi updateExisting=true).
   */
  async importMany(input: {
    accounts: Array<{
      email?: string;
      password?: string;
      recoveryEmail?: string | null;
      recoveryPhone?: string | null;
      totpSecret?: string | null;
      desiredName?: string | null;
      desiredAddress?: string | null;
      desiredAvatarUrl?: string | null;
      name?: string | null;
      address?: string | null;
      avatar?: string | null;
      avatarUrl?: string | null;
      /** aliases */
      "2fa"?: string | null;
      totp?: string | null;
      ten?: string | null;
      diachi?: string | null;
    }>;
    updateExisting?: boolean;
    autoAssignAfterImport?: boolean;
    /** Sau login thành công — enqueue đổi hồ sơ Google (mặc định tắt). */
    applyProfileAfterImport?: boolean;
  }) {
    const rows = Array.isArray(input?.accounts) ? input.accounts : [];
    if (!rows.length) {
      return { ok: false, created: 0, updated: 0, skipped: 0, errors: [{ row: 0, error: "Danh sách trống" }] };
    }
    if (rows.length > 2000) {
      return {
        ok: false,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [{ row: 0, error: "Tối đa 2000 dòng / lần import" }],
      };
    }

    const created: Array<{ id: string; email: string }> = [];
    const updated: Array<{ id: string; email: string }> = [];
    const skipped: Array<{ email: string; reason: string }> = [];
    const errors: Array<{ row: number; email?: string; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      const email = String(raw.email || "")
        .trim()
        .toLowerCase();
      const password = String(raw.password || "");
      const recoveryEmail = raw.recoveryEmail
        ? String(raw.recoveryEmail).trim().toLowerCase()
        : null;
      const recoveryPhone = raw.recoveryPhone ? String(raw.recoveryPhone).trim() : null;
      const totpRaw = String(
        raw.totpSecret || raw["2fa"] || raw.totp || "",
      ).trim();
      const desiredName =
        pickProfileField(raw as Record<string, unknown>, [
          "desiredName",
          "name",
          "ten",
        ]) || null;
      const desiredAddress =
        pickProfileField(raw as Record<string, unknown>, [
          "desiredAddress",
          "address",
          "diachi",
        ]) || null;
      const desiredAvatarUrl =
        pickProfileField(raw as Record<string, unknown>, [
          "desiredAvatarUrl",
          "avatarUrl",
          "avatar",
        ]) || null;
      const hasProfileDesired = Boolean(
        desiredName || desiredAddress || desiredAvatarUrl,
      );

      if (!email) {
        errors.push({ row: i + 1, error: "Thiếu email" });
        continue;
      }

      try {
        let totpSecretEnc: ReturnType<typeof totpEncFromInput>;
        totpSecretEnc = totpEncFromInput(totpRaw || null);

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ row: i + 1, email, error: "Email không hợp lệ" });
          continue;
        }

        const existing = await this.prisma.googleAccount.findUnique({ where: { email } });
        if (existing) {
          if (input.updateExisting) {
            if (password.length < 6) {
              errors.push({
                row: i + 1,
                email,
                error: "Cập nhật thất bại — mật khẩu tối thiểu 6 ký tự",
              });
              continue;
            }
            await this.prisma.googleAccount.update({
              where: { id: existing.id },
              data: {
                passwordEnc: encryptSecret(password) as any,
                ...(recoveryEmail ? { recoveryEmail } : {}),
                ...(recoveryPhone ? { recoveryPhone } : {}),
                ...(totpSecretEnc ? { totpSecretEnc } : {}),
                ...(desiredName ? { desiredName } : {}),
                ...(desiredAddress ? { desiredAddress } : {}),
                ...(desiredAvatarUrl ? { desiredAvatarUrl } : {}),
                ...(hasProfileDesired ? { profileSyncStatus: "PENDING" as const } : {}),
              },
            });
            if (desiredAvatarUrl) {
              try {
                const avatarLocalPath = await cacheAccountAvatarFromUrl(
                  existing.id,
                  desiredAvatarUrl,
                );
                await this.prisma.googleAccount.update({
                  where: { id: existing.id },
                  data: { avatarLocalPath },
                });
              } catch {
                /* avatar cache optional on import */
              }
            }
            updated.push({ id: existing.id, email });
          } else {
            skipped.push({ email, reason: "đã tồn tại" });
          }
          continue;
        }

        if (password.length < 6) {
          errors.push({ row: i + 1, email, error: "Mật khẩu tối thiểu 6 ký tự" });
          continue;
        }

        const parsed = createAccountSchema.parse({
          email,
          password,
          recoveryEmail,
          recoveryPhone,
          totpSecret: totpRaw || null,
        });

        const totpEnc = totpEncFromInput(parsed.totpSecret);
        const row = await this.prisma.googleAccount.create({
          data: {
            email: parsed.email.trim().toLowerCase(),
            passwordEnc: encryptSecret(password) as any,
            ...(totpEnc ? { totpSecretEnc: totpEnc } : {}),
            recoveryEmail: parsed.recoveryEmail ?? null,
            recoveryPhone: parsed.recoveryPhone ?? null,
            status: "UNREADY",
            ...(desiredName ? { desiredName } : {}),
            ...(desiredAddress ? { desiredAddress } : {}),
            ...(desiredAvatarUrl ? { desiredAvatarUrl } : {}),
            ...(hasProfileDesired ? { profileSyncStatus: "PENDING" as const } : {}),
          },
        });
        if (desiredAvatarUrl) {
          try {
            const avatarLocalPath = await cacheAccountAvatarFromUrl(
              row.id,
              desiredAvatarUrl,
            );
            await this.prisma.googleAccount.update({
              where: { id: row.id },
              data: { avatarLocalPath },
            });
          } catch {
            /* avatar cache optional on import */
          }
        }
        created.push({ id: row.id, email: row.email });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ row: i + 1, email, error: msg.slice(0, 200) });
      }
    }

    let autoAssigned = 0;
    const autoAssignErrors: Array<{ accountId: string; email: string; error: string }> = [];
    let profileQueued = 0;
    const profileQueueErrors: Array<{ accountId: string; email: string; error: string }> = [];

    if (input.autoAssignAfterImport && created.length > 0) {
      for (let i = 0; i < created.length; i++) {
        const acc = created[i]!;
        try {
          await this.profiles.autoAssign(acc.id, 60, { openLogin: true });
          autoAssigned += 1;
        } catch (e) {
          autoAssignErrors.push({
            accountId: acc.id,
            email: acc.email,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    if (input.applyProfileAfterImport) {
      const targets = [...created, ...updated];
      for (const acc of targets) {
        try {
          const row = await this.prisma.googleAccount.findUnique({
            where: { id: acc.id },
            include: { profile: true },
          });
          if (!row?.profile) continue;
          if (row.status !== "READY" && row.profile.status !== "READY") continue;
          if (
            !row.desiredName &&
            !row.desiredAddress &&
            !row.desiredAvatarUrl &&
            !row.avatarLocalPath
          ) continue;
          await this.enqueueProfileUpdate(acc.id);
          profileQueued += 1;
        } catch (e) {
          profileQueueErrors.push({
            accountId: acc.id,
            email: acc.email,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return {
      ok: true,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      errorCount: errors.length,
      createdIds: created,
      updatedIds: updated,
      skippedRows: skipped,
      errors,
      autoAssigned,
      autoAssignFailed: autoAssignErrors.length,
      autoAssignErrors: autoAssignErrors.slice(0, 20),
      profileQueued,
      profileQueueFailed: profileQueueErrors.length,
      profileQueueErrors: profileQueueErrors.slice(0, 20),
      message: `Import xong: +${created.length} mới, ${updated.length} cập nhật, ${skipped.length} bỏ qua, ${errors.length} lỗi${
        input.autoAssignAfterImport
          ? ` · Auto-gán hồ sơ: ${autoAssigned}/${created.length}`
          : ""
      }${
        input.applyProfileAfterImport
          ? ` · Đổi hồ sơ Google: ${profileQueued} acc`
          : ""
      }`,
    };
  }

  /** Chuẩn bị payload + enqueue ACCOUNT_PROFILE_UPDATE cho 1 account READY. */
  async enqueueProfileUpdate(accountId: string) {
    const row = await this.prisma.googleAccount.findUnique({
      where: { id: accountId },
      include: { profile: true },
    });
    if (!row) throw new NotFoundException("Account not found");
    if (!row.profile) {
      throw new BadRequestException("Account chưa có Chrome profile — gán hồ sơ trước");
    }
    if (row.status !== "READY" || row.profile.status !== "READY") {
      throw new BadRequestException("Account chưa READY — đăng nhập Google trước");
    }
    if (
      !row.desiredName &&
      !row.desiredAddress &&
      !row.desiredAvatarUrl &&
      !row.avatarLocalPath
    ) {
      throw new BadRequestException("Không có tên/địa chỉ/avatar mong muốn");
    }

    let avatarLocalPath = row.avatarLocalPath;
    if (row.desiredAvatarUrl) {
      try {
        avatarLocalPath = await cacheAccountAvatarFromUrl(accountId, row.desiredAvatarUrl);
        await this.prisma.googleAccount.update({
          where: { id: accountId },
          data: { avatarLocalPath },
        });
      } catch (e) {
        throw new BadRequestException(
          `Tải avatar thất bại: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const payload = accountProfileUpdatePayloadSchema.parse({
      accountId,
      desiredName: row.desiredName,
      desiredAddress: row.desiredAddress,
      avatarLocalPath,
    });

    await this.prisma.googleAccount.update({
      where: { id: accountId },
      data: {
        profileSyncStatus: "SYNCING",
        profileSyncError: null,
      },
    });

    return this.profiles.enqueue(row.profile.id, {
      taskCode: "ACCOUNT_PROFILE_UPDATE",
      payload,
    });
  }

  /** Enqueue đổi hồ sơ Google hàng loạt — 1 acc / lần (client gọi tuần tự). */
  async bulkEnqueueProfileUpdate(accountIds: string[]) {
    const ids = [...new Set(accountIds.map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) {
      throw new BadRequestException("Danh sách account trống");
    }
    if (ids.length > 200) {
      throw new BadRequestException("Tối đa 200 account / lần");
    }

    const queued: Array<{ accountId: string; email: string; jobRunId: string }> = [];
    const errors: Array<{ accountId: string; email?: string; error: string }> = [];

    for (const accountId of ids) {
      const row = await this.prisma.googleAccount.findUnique({
        where: { id: accountId },
        select: { email: true },
      });
      try {
        const out = await this.enqueueProfileUpdate(accountId);
        queued.push({
          accountId,
          email: row?.email ?? accountId,
          jobRunId: out.jobRunId,
        });
      } catch (e) {
        errors.push({
          accountId,
          email: row?.email,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      ok: true,
      queued: queued.length,
      failed: errors.length,
      queuedRows: queued,
      errors: errors.slice(0, 50),
    };
  }

  /** Lưu tên / địa chỉ mong muốn hàng loạt (gán hồ sơ từ Excel, chưa chạy Google). */
  async bulkSetDesiredProfile(
    items: Array<{
      accountId?: string;
      desiredName?: string | null;
      desiredAddress?: string | null;
    }>,
  ) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) throw new BadRequestException("Danh sách hồ sơ trống");
    if (rows.length > 500) {
      throw new BadRequestException("Tối đa 500 hồ sơ / lần");
    }

    const updated: Array<{ accountId: string; email: string }> = [];
    const errors: Array<{ accountId?: string; error: string }> = [];

    for (const item of rows) {
      const accountId = String(item?.accountId || "").trim();
      if (!accountId) {
        errors.push({ error: "Thiếu accountId" });
        continue;
      }
      const desiredName = item.desiredName?.trim() || null;
      const desiredAddress = item.desiredAddress?.trim() || null;
      if (!desiredName && !desiredAddress) {
        errors.push({ accountId, error: "Không có tên / địa chỉ" });
        continue;
      }
      try {
        const row = await this.prisma.googleAccount.update({
          where: { id: accountId },
          data: {
            desiredName,
            desiredAddress,
            profileSyncStatus: "PENDING",
            profileSyncError: null,
            profileSyncedAt: null,
          },
          select: { id: true, email: true },
        });
        updated.push({ accountId: row.id, email: row.email });
      } catch (e) {
        errors.push({
          accountId,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
      }
    }

    return {
      ok: true,
      updated: updated.length,
      failed: errors.length,
      updatedRows: updated,
      errors: errors.slice(0, 50),
      message: `Đã lưu hồ sơ cho ${updated.length} tài khoản${
        errors.length ? `, ${errors.length} lỗi` : ""
      }`,
    };
  }

  /** Enqueue quét hồ sơ Google (name + avatar) cho 1 account READY. */
  async enqueueScanGoogleProfile(accountId: string) {
    const row = await this.prisma.googleAccount.findUnique({
      where: { id: accountId },
      include: { profile: true },
    });
    if (!row) throw new NotFoundException("Account not found");
    if (!row.profile) {
      throw new BadRequestException("Account chưa có Chrome profile — gán hồ sơ trước");
    }
    if (row.status !== "READY" || row.profile.status !== "READY") {
      throw new BadRequestException("Account chưa READY — đăng nhập Google trước");
    }
    const payload = { accountId };
    return this.profiles.enqueue(row.profile.id, {
      taskCode: "SCAN_GOOGLE_PROFILE",
      payload,
    });
  }

  /** Enqueue quét hồ sơ Google hàng loạt — 1 acc / lần (client gọi tuần tự). */
  async bulkEnqueueScanGoogleProfile(accountIds: string[]) {
    const ids = [...new Set(accountIds.map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) {
      throw new BadRequestException("Danh sách account trống");
    }
    if (ids.length > 200) {
      throw new BadRequestException("Tối đa 200 account / lần");
    }

    const queued: Array<{ accountId: string; email: string; jobRunId: string }> = [];
    const errors: Array<{ accountId: string; email?: string; error: string }> = [];

    for (const accountId of ids) {
      const row = await this.prisma.googleAccount.findUnique({
        where: { id: accountId },
        select: { email: true, status: true, profile: { select: { status: true } } },
      });
      try {
        const out = await this.enqueueScanGoogleProfile(accountId);
        queued.push({
          accountId,
          email: row?.email ?? accountId,
          jobRunId: out.jobRunId,
        });
      } catch (e) {
        errors.push({
          accountId,
          email: row?.email,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      ok: true,
      queued: queued.length,
      failed: errors.length,
      queuedRows: queued,
      errors: errors.slice(0, 50),
    };
  }

  /** Nhận ảnh local dạng base64 từ Admin và gắn làm avatar mong muốn. */
  async uploadAvatar(
    accountId: string,
    input: { fileName?: string; dataBase64?: string },
  ) {
    const account = await this.prisma.googleAccount.findUnique({
      where: { id: accountId },
      select: { id: true, email: true },
    });
    if (!account) throw new NotFoundException("Account not found");

    const encoded = String(input?.dataBase64 || "").trim();
    if (!encoded) throw new BadRequestException("Thiếu dữ liệu file avatar");
    if (encoded.length > 11_200_000) {
      throw new BadRequestException("File avatar > 8MB");
    }

    let data: Buffer;
    try {
      data = Buffer.from(encoded, "base64");
    } catch {
      throw new BadRequestException("Dữ liệu file avatar không hợp lệ");
    }
    if (!data.length || data.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new BadRequestException("Dữ liệu base64 không hợp lệ");
    }

    try {
      const avatarLocalPath = await cacheUploadedAccountAvatar(accountId, data);
      await this.prisma.googleAccount.update({
        where: { id: accountId },
        data: {
          avatarLocalPath,
          // File upload trực tiếp được ưu tiên; không tải lại URL cũ khi enqueue.
          desiredAvatarUrl: null,
          profileSyncStatus: "PENDING",
          profileSyncError: null,
          profileSyncedAt: null,
        },
      });
      return {
        ok: true,
        accountId,
        email: account.email,
        fileName: String(input.fileName || "").slice(0, 255),
        size: data.length,
        message: `Đã lưu avatar cho ${account.email}`,
      };
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  async update(id: string, input: Partial<z.infer<typeof createAccountSchema>>) {
    const prev = await this.prisma.googleAccount.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!prev) throw new NotFoundException("Account not found");

    const nextEmail = input.email?.trim().toLowerCase();
    const emailChanged = Boolean(nextEmail && nextEmail !== prev.email.toLowerCase());

    let totpSecretEnc: ReturnType<typeof totpEncFromInput>;
    try {
      totpSecretEnc =
        input.totpSecret != null && String(input.totpSecret).trim()
          ? totpEncFromInput(input.totpSecret)
          : undefined;
    } catch (e) {
      throw e;
    }

    const updated = await this.prisma.googleAccount.update({
      where: { id },
      data: {
        ...(input.email != null ? { email: input.email } : {}),
        ...(input.recoveryEmail !== undefined
          ? { recoveryEmail: input.recoveryEmail }
          : {}),
        ...(input.recoveryPhone !== undefined
          ? { recoveryPhone: input.recoveryPhone }
          : {}),
        ...(emailChanged
          ? { status: "UNREADY" }
          : input.status != null
            ? { status: input.status }
            : {}),
        ...(input.password ? { passwordEnc: encryptSecret(input.password) as any } : {}),
        ...(totpSecretEnc ? { totpSecretEnc } : {}),
      },
      include: { profile: true },
    });

    if (emailChanged && prev.profile) {
      // Đổi email = profile Chrome mới (tránh session Gmail cũ → loop account↔login)
      await this.rotateBrowserProfile(prev.profile).catch(() => undefined);
    }

    const pub = accountPublic(updated);
    return {
      ...pub,
      emailChanged,
      message: emailChanged
        ? "Đã đổi email — đã tạo Chrome profile sạch. Bấm Mở để đăng nhập email mới."
        : totpSecretEnc
          ? `Đã lưu mã 2FA cho ${pub.email}`
          : undefined,
    };
  }

  /**
   * Gắn path Chrome mới + UNREADY. Thư mục cũ xóa best-effort (tránh giữ session email trước).
   */
  private async rotateBrowserProfile(profile: {
    id: string;
    accountId: string;
    browserProfilePath: string;
    cookiePath: string;
    localStoragePath: string | null;
  }) {
    const stamp = Date.now().toString(36);
    const nextDir = `profiles/${profile.accountId}-${stamp}`;
    const oldDir = profile.browserProfilePath;

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: {
        browserProfilePath: nextDir,
        cookiePath: `${nextDir}/cookies.json`,
        localStoragePath: `${nextDir}/localStorage.json`,
        status: "UNREADY",
        browserAlive: false,
        browserWorkerId: null,
        leaseToken: null,
        leaseUntil: null,
        currentTask: null,
      },
    });

    const storage = resolveStorageDir();
    const absOld = path.resolve(storage, oldDir);
    if (existsSync(absOld)) {
      // Không block response nếu Chrome còn lock file
      void rm(absOld, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** API nội bộ / nút reset: buộc profile Chrome sạch cho account đang stuck. */
  async resetBrowserProfile(id: string) {
    const row = await this.prisma.googleAccount.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row) throw new NotFoundException("Account not found");
    if (!row.profile) {
      return { ok: true, message: "Account chưa có profile Chrome" };
    }
    await this.prisma.googleAccount.update({
      where: { id },
      data: { status: "UNREADY" },
    });
    await this.rotateBrowserProfile(row.profile);
    return {
      ok: true,
      emailChanged: false,
      message: "Đã làm mới Chrome profile — bấm Mở browser để login lại.",
    };
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.googleAccount.delete({ where: { id } });
    return { ok: true };
  }
}
