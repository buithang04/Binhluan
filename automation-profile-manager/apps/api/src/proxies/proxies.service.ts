import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { decryptSecret, encryptSecret } from "@apm/crypto";
import { createProxySchema } from "@apm/shared";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

type WebshareProxy = {
  id?: string;
  username?: string;
  password?: string;
  proxy_address?: string;
  port?: number;
  valid?: boolean;
  country_code?: string;
  city_name?: string;
  last_verification?: string;
};

type WebshareListResponse = {
  count?: number;
  next?: string | null;
  results?: WebshareProxy[];
};

export class WebshareThrottledError extends Error {
  constructor(
    public readonly retryAfterSec: number,
    message: string,
  ) {
    super(message);
    this.name = "WebshareThrottledError";
  }
}

function parseRetryAfterSec(status: number, body: string, header?: string | null) {
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  const m = body.match(/available in\s+(\d+)\s+seconds?/i);
  if (m) return Number(m[1]);
  return status === 429 ? 60 : 0;
}

@Injectable()
export class ProxiesService {
  constructor(private readonly prisma: PrismaService) {}

  private toPublic(row: {
    id: string;
    host: string;
    port: number;
    usernameEnc: Buffer | Uint8Array | null;
    passwordEnc: Buffer | Uint8Array | null;
    protocol: string;
    country: string | null;
    city: string | null;
    note: string | null;
    maxProfiles: number;
    status: string;
    health: string;
    lastCheckedAt: Date | null;
    lockedUntil?: Date | null;
    lockedByJobId?: string | null;
    cooldownUntil?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    _count?: { assignments: number };
  }) {
    let username: string | null = null;
    let password: string | null = null;
    try {
      if (row.usernameEnc) username = decryptSecret(row.usernameEnc);
      if (row.passwordEnc) password = decryptSecret(row.passwordEnc);
    } catch {
      username = null;
      password = null;
    }
    const { usernameEnc: _u, passwordEnc: _p, _count, ...rest } = row;
    const now = Date.now();
    const locked =
      row.lockedUntil != null && new Date(row.lockedUntil).getTime() > now;
    const cooling =
      row.cooldownUntil != null && new Date(row.cooldownUntil).getTime() > now;
    return {
      ...rest,
      username,
      password,
      currentProfiles: _count?.assignments ?? 0,
      locked,
      cooling,
      available: !locked && !cooling && row.status === "ACTIVE" && row.health === "WORKING",
    };
  }

  private static MAPS_COOLDOWN_KEY = "maps_proxy_cooldown_minutes";

  async getMapsCooldownMinutes() {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: ProxiesService.MAPS_COOLDOWN_KEY },
    });
    const n = row ? Number(row.value) : 60;
    const cooldownMinutes =
      Number.isFinite(n) && n >= 0 ? Math.min(10080, Math.floor(n)) : 60;
    return { cooldownMinutes };
  }

  async setMapsCooldownMinutes(minutes: number) {
    const cooldownMinutes = Math.max(
      0,
      Math.min(10080, Math.floor(Number(minutes) || 0)),
    );
    await this.prisma.systemSetting.upsert({
      where: { key: ProxiesService.MAPS_COOLDOWN_KEY },
      create: {
        key: ProxiesService.MAPS_COOLDOWN_KEY,
        value: String(cooldownMinutes),
      },
      update: { value: String(cooldownMinutes) },
    });
    return { cooldownMinutes };
  }

  async list() {
    const rows = await this.prisma.proxy.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { assignments: true } } },
    });
    return rows.map((row) => this.toPublic(row));
  }

  async get(id: string) {
    const row = await this.prisma.proxy.findUnique({
      where: { id },
      include: { _count: { select: { assignments: true } } },
    });
    if (!row) throw new NotFoundException("Proxy not found");
    return this.toPublic(row);
  }

  async capacity(id: string) {
    const proxy = await this.get(id);
    return {
      proxyId: id,
      maxProfiles: proxy.maxProfiles,
      currentProfiles: proxy.currentProfiles,
      remaining: Math.max(0, proxy.maxProfiles - proxy.currentProfiles),
    };
  }

  async assertCanAssign(proxyId: string) {
    const cap = await this.capacity(proxyId);
    if (cap.remaining <= 0) {
      throw new ConflictException("Proxy profile capacity exceeded");
    }
    return cap;
  }

  /** Chọn proxy ACTIVE + WORKING còn slot (ít profile nhất trước). Legacy sticky — giữ cho tương thích. */
  async pickAvailableProxy() {
    const rows = await this.prisma.proxy.findMany({
      where: { status: "ACTIVE", health: "WORKING" },
      include: { _count: { select: { assignments: true } } },
      orderBy: { createdAt: "asc" },
    });
    const available = rows
      .filter((p) => p._count.assignments < p.maxProfiles)
      .sort((a, b) => a._count.assignments - b._count.assignments);
    return available[0] ?? null;
  }

  /**
   * Queue runtime: random 1 proxy không bị lock + hết cooldown.
   * Dùng atomic updateMany để tránh 2 job lấy cùng proxy khi chạy song song.
   */
  async acquireRandomForJob(
    jobRunId: string,
    lockMinutes = 30,
    preferredProxyId?: string | null,
  ) {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + lockMinutes * 60_000);

    // Sticky: ưu tiên proxy cũ — bỏ qua cooldown (cùng profile retry MAPS không
    // được đổi proxy kẻo worker phải kill Chrome đang mở Maps).
    if (preferredProxyId) {
      const sticky = await this.prisma.proxy.updateMany({
        where: {
          id: preferredProxyId,
          status: "ACTIVE",
          health: "WORKING",
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
          lockedUntil: lockUntil,
          lockedByJobId: jobRunId,
          cooldownUntil: null,
        },
      });
      if (sticky.count === 1) {
        console.log(
          `[proxies] sticky proxy ${preferredProxyId.slice(0, 8)}… for job ${jobRunId.slice(0, 8)}…`,
        );
        return this.prisma.proxy.findUniqueOrThrow({
          where: { id: preferredProxyId },
        });
      }
    }

    const candidates = await this.prisma.proxy.findMany({
      where: {
        status: "ACTIVE",
        health: "WORKING",
        AND: [
          { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
          { OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: now } }] },
        ],
      },
      select: { id: true },
    });
    if (!candidates.length) {
      throw new BadRequestException(
        "Không còn proxy trống (đang lock hoặc cooldown). Thêm proxy / chờ cooldown.",
      );
    }

    // Shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }

    for (const c of candidates) {
      const updated = await this.prisma.proxy.updateMany({
        where: {
          id: c.id,
          status: "ACTIVE",
          health: "WORKING",
          AND: [
            { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
            { OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: now } }] },
          ],
        },
        data: {
          lockedUntil: lockUntil,
          lockedByJobId: jobRunId,
        },
      });
      if (updated.count === 1) {
        return this.prisma.proxy.findUniqueOrThrow({ where: { id: c.id } });
      }
    }

    throw new BadRequestException(
      "Không chiếm được proxy (race). Thử lại sau vài giây.",
    );
  }

  /** Giải phóng lock + đặt cooldown sau khi job xong. */
  async releaseAfterJob(
    proxyId: string,
    opts: { jobRunId?: string; cooldownMinutes?: number } = {},
  ) {
    const fromSetting =
      opts.cooldownMinutes == null
        ? (await this.getMapsCooldownMinutes()).cooldownMinutes
        : opts.cooldownMinutes;
    const cooldownMinutes = Math.max(0, fromSetting);
    const now = new Date();
    const cooldownUntil =
      cooldownMinutes > 0
        ? new Date(now.getTime() + cooldownMinutes * 60_000)
        : null;

    await this.prisma.proxy.updateMany({
      where: {
        id: proxyId,
        ...(opts.jobRunId ? { lockedByJobId: opts.jobRunId } : {}),
      },
      data: {
        lockedUntil: null,
        lockedByJobId: null,
        cooldownUntil,
      },
    });
    return { ok: true, cooldownUntil };
  }

  async create(input: z.infer<typeof createProxySchema>) {
    const data = createProxySchema.parse(input);
    const created = await this.prisma.proxy.create({
      data: {
        host: data.host,
        port: data.port,
        protocol: data.protocol,
        country: data.country ?? null,
        city: data.city ?? null,
        note: data.note ?? null,
        maxProfiles: data.maxProfiles,
        status: data.status ?? "ACTIVE",
        health: data.health ?? "UNKNOWN",
        usernameEnc: data.username ? (encryptSecret(data.username) as any) : null,
        passwordEnc: data.password ? (encryptSecret(data.password) as any) : null,
      },
      include: { _count: { select: { assignments: true } } },
    });
    return this.toPublic(created);
  }

  async update(id: string, input: Partial<z.infer<typeof createProxySchema>>) {
    await this.get(id);
    const updated = await this.prisma.proxy.update({
      where: { id },
      data: {
        host: input.host,
        port: input.port,
        protocol: input.protocol,
        country: input.country,
        city: input.city,
        note: input.note,
        maxProfiles: input.maxProfiles,
        status: input.status,
        health: input.health,
        ...(input.username !== undefined
          ? {
              usernameEnc: input.username
                ? (encryptSecret(input.username) as any)
                : null,
            }
          : {}),
        ...(input.password !== undefined
          ? {
              passwordEnc: input.password
                ? (encryptSecret(input.password) as any)
                : null,
            }
          : {}),
      },
      include: { _count: { select: { assignments: true } } },
    });
    return this.toPublic(updated);
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.proxy.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Import proxies from Webshare official API (not dashboard scraping).
   * Docs: https://apidocs.webshare.io/proxy-list/list
   */
  async importFromWebshare(input?: {
    apiToken?: string;
    mode?: "direct" | "backbone";
    maxProfiles?: number;
    onlyValid?: boolean;
  }) {
    const token = (input?.apiToken || process.env.WEBSHARE_API_TOKEN || "").trim();
    if (!token) {
      throw new BadRequestException(
        "Thiếu Webshare API token. Thêm WEBSHARE_API_TOKEN vào .env hoặc gửi apiToken trong body.",
      );
    }

    const mode = input?.mode || "direct";
    const maxProfiles = input?.maxProfiles ?? 10;
    const onlyValid = input?.onlyValid !== false;

    let page = 1;
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    while (page <= 100) {
      const base =
        (process.env.WEBSHARE_API_BASE || "").trim() ||
        "https://proxy.webshare.io/api/v2/proxy/list/";
      const url = new URL(base.endsWith("/") ? base : `${base}/`);
      // Nếu base đã có query sẵn thì vẫn set mode/page
      url.searchParams.set("mode", mode);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", "100");

      const res = await fetch(url, {
        headers: { Authorization: `Token ${token}` },
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429) {
          const retryAfterSec = parseRetryAfterSec(
            res.status,
            text,
            res.headers.get("retry-after"),
          );
          throw new WebshareThrottledError(
            retryAfterSec,
            `Webshare rate limit — thử lại sau ${retryAfterSec}s`,
          );
        }
        throw new BadRequestException(
          `Webshare API lỗi ${res.status}: ${text.slice(0, 300)}`,
        );
      }

      const data = (await res.json()) as WebshareListResponse;
      const results = data.results || [];
      if (!results.length) break;

      for (const item of results) {
        const host = item.proxy_address?.trim();
        const port = Number(item.port);
        if (!host || !Number.isFinite(port)) {
          skipped += 1;
          continue;
        }
        if (onlyValid && item.valid === false) {
          skipped += 1;
          continue;
        }

        try {
          const existing = await this.prisma.proxy.findUnique({
            where: { host_port: { host, port } },
          });

          const lastCheckedAt = item.last_verification
            ? new Date(item.last_verification)
            : new Date();
          const isValid =
            item.valid === true ||
            item.valid === undefined ||
            (item.valid as unknown) === "true";

          const payload = {
            protocol: "http" as const,
            country: item.country_code?.toUpperCase() || null,
            city: item.city_name || null,
            note: item.id ? `webshare:${item.id}` : "webshare",
            maxProfiles,
            status: "ACTIVE" as const,
            health: isValid ? ("WORKING" as const) : ("FAILED" as const),
            lastCheckedAt: Number.isNaN(lastCheckedAt.getTime())
              ? new Date()
              : lastCheckedAt,
            usernameEnc: item.username
              ? (encryptSecret(item.username) as any)
              : null,
            passwordEnc: item.password
              ? (encryptSecret(item.password) as any)
              : null,
          };

          if (existing) {
            await this.prisma.proxy.update({
              where: { id: existing.id },
              data: payload,
            });
            updated += 1;
          } else {
            await this.prisma.proxy.create({
              data: { host, port, ...payload },
            });
            imported += 1;
          }
        } catch (e) {
          skipped += 1;
          errors.push(
            `${host}:${port} — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (!data.next) break;
      page += 1;
    }

    return { imported, updated, skipped, errors: errors.slice(0, 20) };
  }
}
