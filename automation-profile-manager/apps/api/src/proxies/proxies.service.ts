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
import {
  HOMEPROXY_PRESET,
  PROXY_IMPORT_SETTING_KEY,
  WEBSHARE_PRESET,
  applyCurlToConfig,
  asString,
  fillSecretsFromEnv,
  getByPath,
  maskHeaders,
  withBuiltCurl,
  type ProxyImportConfig,
} from "./proxy-import.util";
import { request as httpsRequest } from "https";
import { ProxyAgent, fetch as undiciFetch } from "undici";

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

  async getImportConfig(): Promise<{
    config: ProxyImportConfig;
    curlPreview: string;
    headersMasked: Record<string, string>;
    presets: { id: string; name: string }[];
  }> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: PROXY_IMPORT_SETTING_KEY },
    });
    let config: ProxyImportConfig = { ...HOMEPROXY_PRESET };
    if (row?.value) {
      try {
        config = {
          ...HOMEPROXY_PRESET,
          ...(JSON.parse(row.value) as ProxyImportConfig),
        };
      } catch {
        /* keep preset */
      }
    }
    config = fillSecretsFromEnv(withBuiltCurl(config));
    return {
      config,
      curlPreview: config.curl,
      headersMasked: maskHeaders(config.headers),
      presets: [
        { id: "homeproxy", name: HOMEPROXY_PRESET.name },
        { id: "webshare", name: WEBSHARE_PRESET.name },
      ],
    };
  }

  async setImportConfig(input: {
    curl?: string;
    config?: Partial<ProxyImportConfig>;
    preset?: "homeproxy" | "webshare";
    /** Form fields: url + auth token + merchant id (không cần dán cả cURL). */
    url?: string;
    authorization?: string;
    merchantId?: string;
  }) {
    let config: ProxyImportConfig = (await this.getImportConfig()).config;

    if (input.preset === "homeproxy") {
      config = fillSecretsFromEnv({ ...HOMEPROXY_PRESET });
    } else if (input.preset === "webshare") {
      config = fillSecretsFromEnv({ ...WEBSHARE_PRESET });
    }

    if (input.config) {
      config = {
        ...config,
        ...input.config,
        headers: input.config.headers ?? config.headers,
      };
    }

    if (input.url?.trim()) {
      config = { ...config, url: input.url.trim() };
    }

    const headers = { ...config.headers };
    if (input.authorization?.trim()) {
      const a = input.authorization.trim();
      headers.Authorization = /^(Bearer|Token)\s+/i.test(a)
        ? a
        : `Bearer ${a}`;
    }
    if (input.merchantId !== undefined) {
      const mid = input.merchantId.trim();
      if (mid) headers["x-merchant-id"] = mid;
      else delete headers["x-merchant-id"];
    }
    config = { ...config, headers };

    if (input.curl != null && String(input.curl).trim()) {
      config = applyCurlToConfig(config, String(input.curl));
    }

    config = withBuiltCurl(config);

    if (!config.url?.trim()) {
      throw new BadRequestException("Thiếu URL trong cấu hình import");
    }

    await this.prisma.systemSetting.upsert({
      where: { key: PROXY_IMPORT_SETTING_KEY },
      create: { key: PROXY_IMPORT_SETTING_KEY, value: JSON.stringify(config) },
      update: { value: JSON.stringify(config) },
    });

    return this.getImportConfig();
  }

  /** Sync proxy từ cấu hình cURL/JSON path đã lưu. */
  async importFromConfig(opts?: { disableOthers?: boolean }) {
    const { config } = await this.getImportConfig();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let disabled = 0;
    const errors: string[] = [];
    const seen = new Set<string>();

    let page = 1;
    while (page <= 100) {
      const url = new URL(config.url);
      if (config.pageParam) url.searchParams.set(config.pageParam, String(page));
      if (config.limitParam && !url.searchParams.has(config.limitParam)) {
        url.searchParams.set(config.limitParam, "100");
      }

      const res = await fetch(url, {
        method: config.method || "GET",
        headers: config.headers || {},
        body:
          config.method !== "GET" && config.body
            ? config.body
            : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new BadRequestException(
          `Import API lỗi ${res.status}: ${text.slice(0, 300)}`,
        );
      }

      const json = (await res.json()) as unknown;
      const listRaw = config.listPath
        ? getByPath(json, config.listPath)
        : json;
      const list = Array.isArray(listRaw) ? listRaw : [];
      if (!list.length) break;

      for (const item of list) {
        if (config.filterPath && config.filterEquals) {
          const fv = String(getByPath(item, config.filterPath) ?? "").toLowerCase();
          const want = config.filterEquals.toLowerCase();
          if (fv !== want && !fv.includes(want)) {
            skipped += 1;
            continue;
          }
        }
        if (config.onlyValidPath && config.onlyValidEquals) {
          const v = getByPath(item, config.onlyValidPath);
          const want = config.onlyValidEquals.toLowerCase();
          const ok =
            want === "true"
              ? v === true || v === "true" || v === 1
              : String(v ?? "").toLowerCase() === want;
          if (!ok) {
            skipped += 1;
            continue;
          }
        }

        const host = asString(getByPath(item, config.hostPath));
        const port = Number(getByPath(item, config.portPath));
        if (!host || !Number.isFinite(port) || port <= 0) {
          skipped += 1;
          continue;
        }

        const username = asString(getByPath(item, config.usernamePath));
        const password = asString(getByPath(item, config.passwordPath));
        const protocolRaw = (
          asString(getByPath(item, config.protocolPath)) || "http"
        ).toLowerCase();
        const protocol =
          protocolRaw === "socks5" || protocolRaw === "https"
            ? protocolRaw
            : "http";
        const country = asString(getByPath(item, config.countryPath));
        const city = asString(getByPath(item, config.cityPath));
        const extId = asString(getByPath(item, config.idPath)) || `${host}:${port}`;
        const notePrefix = config.notePrefix || "import";

        try {
          const existing = await this.prisma.proxy.findUnique({
            where: { host_port: { host, port } },
          });
          const payload = {
            protocol,
            country: country?.toUpperCase() || (notePrefix === "homeproxy" ? "VN" : null),
            city,
            note: `${notePrefix}:${extId}`,
            maxProfiles: 10,
            status: "ACTIVE" as const,
            health: "WORKING" as const,
            lastCheckedAt: new Date(),
            usernameEnc: username ? (encryptSecret(username) as any) : null,
            passwordEnc: password ? (encryptSecret(password) as any) : null,
          };
          seen.add(`${host}:${port}`);
          if (existing) {
            await this.prisma.proxy.update({ where: { id: existing.id }, data: payload });
            updated += 1;
          } else {
            await this.prisma.proxy.create({ data: { host, port, ...payload } });
            imported += 1;
          }
        } catch (e) {
          skipped += 1;
          errors.push(
            `${host}:${port} — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const hasNext = config.hasNextPath
        ? getByPath(json, config.hasNextPath)
        : false;
      const cont =
        hasNext === true ||
        (typeof hasNext === "string" && hasNext.length > 0) ||
        (typeof hasNext === "number" && hasNext > 0);
      if (!cont) break;
      page += 1;
    }

    const disableOthers = opts?.disableOthers ?? config.disableOthers;
    if (disableOthers) {
      const others = await this.prisma.proxy.findMany({
        where: {
          status: "ACTIVE",
          NOT: { note: { startsWith: `${config.notePrefix || "import"}:` } },
        },
        select: { id: true, host: true, port: true },
      });
      for (const o of others) {
        if (seen.has(`${o.host}:${o.port}`)) continue;
        await this.prisma.proxy.update({
          where: { id: o.id },
          data: { status: "DISABLED" },
        });
        disabled += 1;
      }
    }

    return { imported, updated, skipped, disabled, errors: errors.slice(0, 20) };
  }

  /**
   * Test proxy giống gate đăng bài:
   * 1) Auth + lấy exit IP qua proxy
   * 2) Exit IP ≠ IP máy
   * 3) (deep) mở Google Maps qua proxy
   * Cập nhật health/lastCheckedAt.
   */
  async testConnection(
    input: {
      id?: string;
      host?: string;
      port?: number;
      username?: string | null;
      password?: string | null;
      protocol?: string;
      deep?: boolean;
    },
  ) {
    let host = input.host?.trim();
    let port = input.port;
    let username = input.username ?? null;
    let password = input.password ?? null;
    let protocol = (input.protocol || "http").toLowerCase();
    let proxyId = input.id;

    if (proxyId) {
      const row = await this.prisma.proxy.findUnique({ where: { id: proxyId } });
      if (!row) throw new NotFoundException("Proxy not found");
      host = row.host;
      port = row.port;
      protocol = row.protocol || "http";
      try {
        username = row.usernameEnc ? decryptSecret(row.usernameEnc) : null;
        password = row.passwordEnc ? decryptSecret(row.passwordEnc) : null;
      } catch {
        throw new BadRequestException("Không giải mã được user/pass proxy");
      }
    }

    if (!host || !port) {
      throw new BadRequestException("Cần host:port hoặc id proxy");
    }
    if (!username || !password) {
      throw new BadRequestException(
        `Proxy ${host}:${port} thiếu user/pass — không test được (giống gate Maps)`,
      );
    }

    const started = Date.now();
    const directIp = await fetchPublicIpDirect().catch(() => null);
    let exitIp: string | null = null;
    let mapsOk: boolean | null = null;
    let mapsStatus: number | null = null;
    let error: string | null = null;

    try {
      exitIp = await fetchPublicIpViaProxy({
        host,
        port,
        username,
        password,
        protocol,
      });
      if (!exitIp) throw new Error("Proxy không trả exit IP");
      if (directIp && exitIp === directIp) {
        throw new Error(
          `Exit IP trùng IP máy (${exitIp}) — Chrome/Maps sẽ bị chặn như gate đăng bài`,
        );
      }
      if (input.deep !== false) {
        const maps = await fetchUrlViaProxy({
          host,
          port,
          username,
          password,
          protocol,
          url: "https://www.google.com/maps",
        });
        mapsStatus = maps.status;
        mapsOk = maps.status > 0 && maps.status < 400;
        if (!mapsOk) {
          throw new Error(`Maps qua proxy lỗi HTTP ${maps.status}`);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const ok = !error && Boolean(exitIp);
    const ms = Date.now() - started;

    if (proxyId) {
      await this.prisma.proxy.update({
        where: { id: proxyId },
        data: {
          health: ok ? "WORKING" : "FAILED",
          lastCheckedAt: new Date(),
        },
      });
    }

    return {
      ok,
      host: `${host}:${port}`,
      proxyId: proxyId ?? null,
      directIp,
      exitIp,
      mapsOk,
      mapsStatus,
      ms,
      error,
      message: ok
        ? `OK — exit ${exitIp}${mapsOk ? " · Maps OK" : ""} (giống gate đăng bài)`
        : `FAIL — ${error}`,
    };
  }

  async testMany(ids?: string[], deep = true) {
    const rows = ids?.length
      ? await this.prisma.proxy.findMany({ where: { id: { in: ids } } })
      : await this.prisma.proxy.findMany({
          where: { status: "ACTIVE" },
          orderBy: { host: "asc" },
          take: 50,
        });

    const results: Awaited<ReturnType<ProxiesService["testConnection"]>>[] = [];
    for (const row of rows) {
      const r = await this.testConnection({ id: row.id, deep });
      results.push(r);
    }
    const ok = results.filter((x) => x.ok).length;
    return { ok, fail: results.length - ok, total: results.length, results };
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

  /**
   * Import proxy tĩnh từ HomeProxy.
   * Docs: https://app.homeproxy.vn/tai-lieu-api
   * List: GET /api/v1/users/proxies (Bearer + x-merchant-id)
   */
  async importFromHomeProxy(input?: {
    apiToken?: string;
    merchantId?: string;
    maxProfiles?: number;
    /** Chỉ lấy Static (bỏ xoay). Mặc định true. */
    onlyStatic?: boolean;
    /** Disable proxy không phải HomeProxy (vd. Webshare cũ). */
    disableOthers?: boolean;
  }) {
    const token = (
      input?.apiToken ||
      process.env.HOMEPROXY_API_TOKEN ||
      ""
    ).trim();
    if (!token) {
      throw new BadRequestException(
        "Thiếu HomeProxy API token. Thêm HOMEPROXY_API_TOKEN vào .env hoặc gửi apiToken trong body.",
      );
    }

    const merchantId = (
      input?.merchantId ||
      process.env.HOMEPROXY_MERCHANT_ID ||
      ""
    ).trim();
    const maxProfiles = input?.maxProfiles ?? 10;
    const onlyStatic = input?.onlyStatic !== false;
    const disableOthers = input?.disableOthers !== false;

    const base =
      (process.env.HOMEPROXY_API_BASE || "").trim() ||
      "https://api.homeproxy.vn/api/v1";
    const listUrl = `${base.replace(/\/$/, "")}/users/proxies`;

    let page = 1;
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let disabled = 0;
    const errors: string[] = [];
    const seenHostPorts = new Set<string>();

    while (page <= 100) {
      const url = new URL(listUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", "100");

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (merchantId) headers["x-merchant-id"] = merchantId;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        const text = await res.text();
        throw new BadRequestException(
          `HomeProxy API lỗi ${res.status}: ${text.slice(0, 300)}`,
        );
      }

      const data = (await res.json()) as HomeProxyListResponse;
      const results = data.data || [];
      if (!results.length) break;

      const now = Date.now();

      for (const item of results) {
        const p = item.proxy;
        if (!p) {
          skipped += 1;
          continue;
        }

        const slug = (
          p.ipaddress?.categorytype?.slug ||
          p.ipaddress?.categorytype?.name ||
          ""
        ).toLowerCase();
        const isStatic = slug === "static" || slug.includes("tinh");
        if (onlyStatic && !isStatic) {
          skipped += 1;
          continue;
        }

        const host = (p.ipaddress?.domain || p.ipaddress?.ip || "").trim();
        const port = Number(p.port);
        if (!host || !Number.isFinite(port) || port <= 0) {
          skipped += 1;
          continue;
        }

        const expiredAt =
          typeof item.expiredAt === "number"
            ? item.expiredAt
            : item.expiredAt
              ? Date.parse(String(item.expiredAt))
              : NaN;
        const expired = Number.isFinite(expiredAt) && expiredAt < now;

        const protocolRaw = (
          item.protocol ||
          p.protocol ||
          "http"
        ).toLowerCase();
        const protocol =
          protocolRaw === "socks5" || protocolRaw === "https"
            ? protocolRaw
            : "http";

        const noteId = item.code || p.id || p.matchCode || `${host}:${port}`;
        const location = p.ipaddress?.location || null;
        const provider = p.ipaddress?.provider || null;

        try {
          const existing = await this.prisma.proxy.findUnique({
            where: { host_port: { host, port } },
          });

          const payload = {
            protocol,
            country: "VN",
            city: location,
            note: `homeproxy:${noteId}${provider ? `:${provider}` : ""}`,
            maxProfiles,
            status: expired ? ("DISABLED" as const) : ("ACTIVE" as const),
            health: expired ? ("FAILED" as const) : ("WORKING" as const),
            lastCheckedAt: new Date(),
            usernameEnc: p.username
              ? (encryptSecret(p.username) as any)
              : null,
            passwordEnc: p.password
              ? (encryptSecret(String(p.password)) as any)
              : null,
          };

          seenHostPorts.add(`${host}:${port}`);

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

      if (!data.hasNextPage) break;
      page += 1;
    }

    if (disableOthers) {
      const others = await this.prisma.proxy.findMany({
        where: {
          status: "ACTIVE",
          OR: [{ note: { startsWith: "webshare:" } }, { note: "webshare" }],
        },
        select: { id: true, host: true, port: true },
      });
      for (const o of others) {
        if (seenHostPorts.has(`${o.host}:${o.port}`)) continue;
        await this.prisma.proxy.update({
          where: { id: o.id },
          data: { status: "DISABLED" },
        });
        disabled += 1;
      }
    }

    return {
      imported,
      updated,
      skipped,
      disabled,
      errors: errors.slice(0, 20),
    };
  }
}

function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

async function fetchPublicIpDirect(): Promise<string | null> {
  try {
    const body = await fetchText("https://api.ipify.org?format=json");
    const m = body.match(/"ip"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

type ProxyTunnel = {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol?: string;
};

async function fetchViaHttpProxy(
  proxy: ProxyTunnel,
  targetUrl: string,
  timeoutMs = 25_000,
): Promise<{ status: number; body: string }> {
  const scheme = (proxy.protocol || "http").toLowerCase() === "https" ? "https" : "http";
  const proxyUrl = `${scheme}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
  const agent = new ProxyAgent(proxyUrl);
  try {
    const res = await undiciFetch(targetUrl, {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "*/*", "User-Agent": "binhluan-proxy-test/1.0" },
      redirect: "follow",
    });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

async function fetchPublicIpViaProxy(proxy: ProxyTunnel): Promise<string> {
  const { body } = await fetchViaHttpProxy(
    proxy,
    "https://api.ipify.org?format=json",
  );
  const m = body.match(/"ip"\s*:\s*"([^"]+)"/);
  if (!m?.[1]) throw new Error(`ipify body: ${body.slice(0, 80)}`);
  return m[1];
}

async function fetchUrlViaProxy(
  proxy: ProxyTunnel & { url: string },
): Promise<{ status: number }> {
  const { status } = await fetchViaHttpProxy(proxy, proxy.url);
  return { status };
}

type HomeProxyListResponse = {
  data?: HomeProxyOrderProxy[];
  total?: number;
  hasNextPage?: boolean;
};

type HomeProxyOrderProxy = {
  code?: string;
  protocol?: string;
  expiredAt?: number | string;
  status?: { name?: string };
  proxy?: {
    id?: string;
    matchCode?: string;
    username?: string;
    password?: string;
    protocol?: string;
    port?: number;
    ipaddress?: {
      domain?: string;
      ip?: string;
      location?: string;
      provider?: string;
      categorytype?: { name?: string; slug?: string };
    };
  };
};
