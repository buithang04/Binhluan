import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ProxiesService, WebshareThrottledError } from "./proxies.service";

export type WebshareSyncState = {
  enabled: boolean;
  intervalSec: number;
  mode: "direct" | "backbone";
  running: boolean;
  cooldownUntil: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastResult: {
    imported: number;
    updated: number;
    skipped: number;
  } | null;
};

@Injectable()
export class ProxiesSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProxiesSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cooldownUntil: Date | null = null;

  private lastStartedAt: Date | null = null;
  private lastFinishedAt: Date | null = null;
  private lastError: string | null = null;
  private lastResult: WebshareSyncState["lastResult"] = null;

  constructor(private readonly proxies: ProxiesService) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log("Webshare auto-sync disabled");
      return;
    }
    if (!process.env.WEBSHARE_API_TOKEN?.trim()) {
      this.logger.warn(
        "Webshare auto-sync bật nhưng thiếu WEBSHARE_API_TOKEN — bỏ qua",
      );
      return;
    }

    const intervalMs = this.intervalSec() * 1000;
    this.logger.log(
      `Webshare auto-sync every ${this.intervalSec()}s (mode=${this.mode()})`,
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

  getStatus(): WebshareSyncState {
    return {
      enabled: this.isEnabled() && !!process.env.WEBSHARE_API_TOKEN?.trim(),
      intervalSec: this.intervalSec(),
      mode: this.mode(),
      running: this.running,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: this.lastFinishedAt?.toISOString() ?? null,
      lastError: this.lastError,
      lastResult: this.lastResult,
    };
  }

  private isEnabled() {
    const raw = (process.env.WEBSHARE_SYNC_ENABLED ?? "true").toLowerCase();
    return raw !== "false" && raw !== "0" && raw !== "off";
  }

  /** Webshare free API dễ bị 429 nếu < ~60s — mặc định 60. */
  private intervalSec() {
    const n = Number(process.env.WEBSHARE_SYNC_INTERVAL_SEC || 60);
    return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 60;
  }

  private mode(): "direct" | "backbone" {
    return process.env.WEBSHARE_SYNC_MODE === "backbone" ? "backbone" : "direct";
  }

  private async tick() {
    if (this.running) return;
    if (this.cooldownUntil && Date.now() < this.cooldownUntil.getTime()) {
      return;
    }

    this.running = true;
    this.lastStartedAt = new Date();
    try {
      const result = await this.proxies.importFromWebshare({
        mode: this.mode(),
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
        // backoff ngắn khi lỗi khác
        this.cooldownUntil = new Date(Date.now() + 30_000);
        this.logger.warn(`Webshare sync failed: ${msg}`);
      }
    } finally {
      this.running = false;
    }
  }
}
