import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ProxiesService, WebshareThrottledError } from "./proxies.service";

export type ProxySyncState = {
  provider: "homeproxy" | "webshare" | "none";
  enabled: boolean;
  intervalSec: number;
  mode: string;
  running: boolean;
  cooldownUntil: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastResult: {
    imported: number;
    updated: number;
    skipped: number;
    disabled?: number;
  } | null;
};

/** @deprecated alias */
export type WebshareSyncState = ProxySyncState;

@Injectable()
export class ProxiesSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProxiesSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cooldownUntil: Date | null = null;

  private lastStartedAt: Date | null = null;
  private lastFinishedAt: Date | null = null;
  private lastError: string | null = null;
  private lastResult: ProxySyncState["lastResult"] = null;

  constructor(private readonly proxies: ProxiesService) {}

  onModuleInit() {
    const provider = this.provider();
    if (provider === "none") {
      this.logger.log("Proxy auto-sync disabled (no HomeProxy/Webshare token)");
      return;
    }
    if (!this.isEnabled()) {
      this.logger.log(`${provider} auto-sync disabled`);
      return;
    }

    const intervalMs = this.intervalSec() * 1000;
    this.logger.log(
      `${provider} auto-sync every ${this.intervalSec()}s`,
    );

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): ProxySyncState & {
    hasApiToken: boolean;
    apiTokenHint: string | null;
    apiBaseUrl: string;
    merchantIdHint?: string | null;
  } {
    const provider = this.provider();
    const token =
      provider === "homeproxy"
        ? (process.env.HOMEPROXY_API_TOKEN || "").trim()
        : (process.env.WEBSHARE_API_TOKEN || "").trim();
    const hint =
      token.length >= 4 ? `…${token.slice(-4)}` : token ? "…***" : null;
    const merchantId = (process.env.HOMEPROXY_MERCHANT_ID || "").trim();

    return {
      provider,
      enabled: this.isEnabled() && !!token && provider !== "none",
      intervalSec: this.intervalSec(),
      mode: provider === "webshare" ? this.webshareMode() : "static",
      running: this.running,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: this.lastFinishedAt?.toISOString() ?? null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      hasApiToken: Boolean(token),
      apiTokenHint: hint,
      apiBaseUrl:
        provider === "homeproxy"
          ? (process.env.HOMEPROXY_API_BASE || "").trim() ||
            "https://api.homeproxy.vn/api/v1/users/proxies"
          : (process.env.WEBSHARE_API_BASE || "").trim() ||
            "https://proxy.webshare.io/api/v2/proxy/list/",
      merchantIdHint: merchantId
        ? `${merchantId.slice(0, 8)}…`
        : null,
    };
  }

  /** Ưu tiên HomeProxy khi có token. */
  private provider(): "homeproxy" | "webshare" | "none" {
    if ((process.env.HOMEPROXY_API_TOKEN || "").trim()) return "homeproxy";
    if ((process.env.WEBSHARE_API_TOKEN || "").trim()) return "webshare";
    return "none";
  }

  private isEnabled() {
    const provider = this.provider();
    if (provider === "homeproxy") {
      const raw = (process.env.HOMEPROXY_SYNC_ENABLED ?? "true").toLowerCase();
      return raw !== "false" && raw !== "0" && raw !== "off";
    }
    if (provider === "webshare") {
      const raw = (process.env.WEBSHARE_SYNC_ENABLED ?? "true").toLowerCase();
      return raw !== "false" && raw !== "0" && raw !== "off";
    }
    return false;
  }

  private intervalSec() {
    const provider = this.provider();
    const raw =
      provider === "homeproxy"
        ? process.env.HOMEPROXY_SYNC_INTERVAL_SEC || 120
        : process.env.WEBSHARE_SYNC_INTERVAL_SEC || 60;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 60;
  }

  private webshareMode(): "direct" | "backbone" {
    return process.env.WEBSHARE_SYNC_MODE === "backbone" ? "backbone" : "direct";
  }

  private async tick() {
    if (this.running) return;
    if (this.cooldownUntil && Date.now() < this.cooldownUntil.getTime()) {
      return;
    }

    const provider = this.provider();
    if (provider === "none" || !this.isEnabled()) return;

    this.running = true;
    this.lastStartedAt = new Date();
    try {
      if (provider === "homeproxy") {
        const result = await this.proxies.importFromHomeProxy({
          onlyStatic: true,
          disableOthers: true,
        });
        this.lastResult = {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
          disabled: result.disabled,
        };
        this.lastError = null;
        this.cooldownUntil = null;
        this.lastFinishedAt = new Date();
        this.logger.log(
          `HomeProxy sync ok +${result.imported} ~${result.updated} skip=${result.skipped} disabled=${result.disabled}`,
        );
      } else {
        const result = await this.proxies.importFromWebshare({
          mode: this.webshareMode(),
          onlyValid: false,
        });
        this.lastResult = {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
        };
        this.lastError = null;
        this.cooldownUntil = null;
        this.lastFinishedAt = new Date();
        this.logger.log(
          `Webshare sync ok +${result.imported} ~${result.updated} skip=${result.skipped}`,
        );
      }
    } catch (e) {
      this.lastFinishedAt = new Date();
      if (e instanceof WebshareThrottledError) {
        const wait = Math.max(15, e.retryAfterSec + 5);
        this.cooldownUntil = new Date(Date.now() + wait * 1000);
        this.lastError = e.message;
        this.logger.warn(
          `Webshare throttled — cooldown ${wait}s (until ${this.cooldownUntil.toISOString()})`,
        );
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError = msg;
        this.cooldownUntil = new Date(Date.now() + 30_000);
        this.logger.warn(`Proxy sync failed (${provider}): ${msg}`);
      }
    } finally {
      this.running = false;
    }
  }
}
