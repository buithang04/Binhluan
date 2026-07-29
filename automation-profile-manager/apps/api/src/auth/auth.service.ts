import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "crypto";
import { hashPassword, verifyPassword } from "@apm/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { Role } from "@prisma/client";

/** Refresh token chỉ hết khi không refresh (idle). Mặc định 24h. */
const REFRESH_IDLE_MS =
  Number(process.env.SESSION_IDLE_HOURS || 24) * 60 * 60 * 1000;

const MAX_FAILED_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);
/** USER: giữ tối đa N refresh token; ADMIN: chỉ 1 thiết bị (xóa hết khi login mới). */
const MAX_REFRESH_TOKENS_PER_USER = 5;

function accessPayload(user: {
  id: string;
  email: string;
  role: Role;
  sessionVersion: number;
}) {
  const base = { sub: user.id, email: user.email, role: user.role };
  if (user.role === Role.ADMIN) {
    return { ...base, sv: user.sessionVersion };
  }
  return base;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(
    email: string,
    password: string,
    opts?: { service?: boolean },
  ) {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.isActive) {
      throw new ForbiddenException("Account disabled");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new ForbiddenException(`Account locked. Try again in ${mins} minute(s).`);
    }

    if (!verifyPassword(password, user.passwordHash)) {
      const attempts = user.failedLoginAttempts + 1;
      const lockedUntil =
        attempts >= MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
          : null;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil,
        },
      });
      throw new UnauthorizedException("Invalid credentials");
    }

    // Re-hash legacy SHA256 passwords to bcrypt on successful login
    const needsRehash = !user.passwordHash.startsWith("$2");
    if (needsRehash) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hashPassword(password) },
      });
    }

    // service=true: job server (dispatch) — KHÔNG bump sessionVersion / KHÔNG xóa refresh
    // (tránh đá phiên Admin đang mở trên trình duyệt mỗi khi đăng bài / mở browser).
    const isService = opts?.service === true;
    const bumpAdminSession = user.role === Role.ADMIN && !isService;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(bumpAdminSession ? { sessionVersion: { increment: 1 } } : {}),
      },
    });

    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    // ADMIN browser login: chỉ 1 thiết bị — xóa refresh cũ. Service giữ nguyên.
    if (bumpAdminSession) {
      await this.prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    }

    const accessToken = await this.jwt.signAsync(accessPayload(fresh));

    const refreshRaw = randomBytes(48).toString("hex");
    const tokenHash = createHash("sha256").update(refreshRaw).digest("hex");
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_IDLE_MS),
      },
    });

    // USER: giữ tối đa N refresh token
    if (user.role !== Role.ADMIN) {
      const stale = await this.prisma.refreshToken.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        skip: MAX_REFRESH_TOKENS_PER_USER,
        select: { id: true },
      });
      if (stale.length) {
        await this.prisma.refreshToken.deleteMany({
          where: { id: { in: stale.map((t) => t.id) } },
        });
      }
    }

    return {
      accessToken,
      refreshToken: refreshRaw,
      user: {
        id: fresh.id,
        email: fresh.email,
        name: fresh.name,
        role: fresh.role,
        sessionVersion: fresh.sessionVersion,
      },
    };
  }

  async refresh(refreshToken: string) {
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token invalid");
    }
    if (!stored.user.isActive) {
      throw new ForbiddenException("Account disabled");
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { expiresAt: new Date(Date.now() + REFRESH_IDLE_MS) },
    });

    const accessToken = await this.jwt.signAsync(accessPayload(stored.user));
    return { accessToken };
  }

  async logout(refreshToken: string) {
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
    return { ok: true };
  }

  hash(password: string) {
    return hashPassword(password);
  }
}
