import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { decryptSecret, encryptSecret } from "@apm/crypto";
import { createAccountSchema, normalizeTotpSecret } from "@apm/shared";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

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
      Array<{ id: string; loginIssue: string | null }>
    >`SELECT id, "loginIssue" FROM "GoogleAccount"`;
    const issueById = new Map(extras.map((e) => [e.id, e.loginIssue]));
    return rows.map((r) => ({
      ...accountPublic(r),
      loginIssue: issueById.get(r.id) ?? null,
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
      /** aliases */
      "2fa"?: string | null;
      totp?: string | null;
    }>;
    updateExisting?: boolean;
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
      const totpSecretEnc = totpEncFromInput(totpRaw || null);

      if (!email) {
        errors.push({ row: i + 1, error: "Thiếu email" });
        continue;
      }

      try {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push({ row: i + 1, email, error: "Email không hợp lệ" });
          continue;
        }

        const existing = await this.prisma.googleAccount.findUnique({ where: { email } });
        if (existing) {
          if (input.updateExisting && password.length >= 6) {
            await this.prisma.googleAccount.update({
              where: { id: existing.id },
              data: {
                passwordEnc: encryptSecret(password) as any,
                ...(recoveryEmail ? { recoveryEmail } : {}),
                ...(recoveryPhone ? { recoveryPhone } : {}),
                ...(totpSecretEnc ? { totpSecretEnc } : {}),
              },
            });
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
          },
        });
        created.push({ id: row.id, email: row.email });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ row: i + 1, email, error: msg.slice(0, 200) });
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
      message: `Import xong: +${created.length} mới, ${updated.length} cập nhật, ${skipped.length} bỏ qua, ${errors.length} lỗi`,
    };
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
