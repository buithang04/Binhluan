import type { Browser, Page } from "puppeteer";

export type LiveBrowserSession = {
  profileId: string;
  browserIndex: number;
  browser: Browser;
  page: Page;
  proxyId: string;
  cookiePath: string;
  /** Path user-data-dir tương đối — nếu DB đổi path (đổi email/reset) thì không tái dùng pool. */
  browserProfilePath?: string;
  openedAt: Date;
  markedReady?: boolean;
  /** Email Google gắn profile — dùng late-ready verify. */
  accountEmail?: string;
  /** Đang chạy job LOGIN — late-ready không được goto (tránh loop account↔login). */
  loginInProgress?: boolean;
  /** Đang MAPS_REVIEW — không auto-dismiss / navigate trên browser này. */
  mapsReviewInProgress?: boolean;
  /** PID Chrome (để focus đúng cửa sổ khi nhiều profile). */
  pid?: number;
  /** Chrome đang launch với --proxy-server hay không (mode A: LOGIN=false, job sau=true). */
  proxyEnabled?: boolean;
  /** User/pass proxy — gắn lại cho mọi tab (authenticate là per-page). */
  proxyAuth?: { username: string; password: string } | null;
};

type DisconnectHandler = (session: LiveBrowserSession) => void | Promise<void>;

/** Pool Chrome sống theo profileId + browserIndex — dùng cho LOGIN keep-alive & job sau. */
class BrowserPool {
  private byProfile = new Map<string, LiveBrowserSession>();
  private byIndex = new Map<number, string>();
  private onDisconnect: DisconnectHandler | null = null;

  setDisconnectHandler(handler: DisconnectHandler) {
    this.onDisconnect = handler;
  }

  get(profileId: string) {
    return this.byProfile.get(profileId) ?? null;
  }

  getByIndex(browserIndex: number) {
    const profileId = this.byIndex.get(browserIndex);
    return profileId ? this.get(profileId) : null;
  }

  list() {
    return [...this.byProfile.values()].map((s) => ({
      profileId: s.profileId,
      browserIndex: s.browserIndex,
      proxyId: s.proxyId,
      openedAt: s.openedAt.toISOString(),
      connected: s.browser.connected,
      markedReady: Boolean(s.markedReady),
    }));
  }

  /** Mọi session đang giữ (kể cả flags MAPS/LOGIN). */
  allSessions(): LiveBrowserSession[] {
    return [...this.byProfile.values()];
  }

  async register(session: LiveBrowserSession) {
    const existing = this.byProfile.get(session.profileId);
    // Đã có session CDP sống khác — không thay (tránh soft-reclaim/focus cướp LOGIN)
    if (
      existing &&
      existing.browser !== session.browser &&
      existing.browser.connected
    ) {
      console.warn(
        `[browser-pool] skip register #${session.browserIndex} — session CDP còn sống (loginInProgress=${Boolean(existing.loginInProgress)})`,
      );
      try {
        session.browser.disconnect();
      } catch {
        /* ignore */
      }
      return;
    }
    await this.release(session.profileId, false);
    this.byProfile.set(session.profileId, session);
    this.byIndex.set(session.browserIndex, session.profileId);

    session.browser.on("disconnected", () => {
      const cur = this.byProfile.get(session.profileId);
      if (cur?.browser === session.browser) {
        this.byProfile.delete(session.profileId);
        this.byIndex.delete(session.browserIndex);
        console.log(
          `[browser-pool] disconnected index=#${session.browserIndex} profile=${session.profileId}`,
        );
        void this.onDisconnect?.(session);
      }
    });

    console.log(
      `[browser-pool] registered index=#${session.browserIndex} profile=${session.profileId} (alive=${this.byProfile.size})`,
    );
  }

  /**
   * Gỡ khỏi pool.
   * closeBrowser=false: chỉ gỡ map.
   * closeBrowser=true (mặc định keep-alive): chỉ disconnect CDP — KHÔNG tắt Chrome.
   * kill=true: tắt hẳn Chrome.
   * forceClose=true: đóng cửa sổ qua CDP (dùng khi ĐỔI PROXY có chủ đích — cookie giữ trong profile).
   */
  async release(
    profileId: string,
    closeBrowser = true,
    opts?: { kill?: boolean; forceClose?: boolean },
  ) {
    const cur = this.byProfile.get(profileId);
    if (!cur) return;
    this.byProfile.delete(profileId);
    this.byIndex.delete(cur.browserIndex);
    if (!closeBrowser) return;
    if (!cur.browser.connected) return;

    if (opts?.forceClose || (opts?.kill && process.env.ALLOW_CHROME_KILL === "1")) {
      // Đang MAPS: cấm kill/OS terminate (tránh "vào Maps rồi tắt").
      // forceClose vẫn ĐƯỢC phép — dùng có chủ đích khi đổi proxy trước khi vào Maps.
      if (cur.mapsReviewInProgress && !opts?.forceClose) {
        console.warn(
          `[browser-pool] chặn kill #${cur.browserIndex} — đang MAPS_REVIEW`,
        );
        try {
          cur.browser.disconnect();
        } catch {
          /* ignore */
        }
        return;
      }
      if (cur.mapsReviewInProgress && opts?.forceClose) {
        console.warn(
          `[browser-pool] forceClose #${cur.browserIndex} dù đang MAPS_REVIEW (đổi-proxy có chủ đích)`,
        );
      }
      console.log(
        `[browser-pool] đóng Chrome #${cur.browserIndex} (${opts?.forceClose ? "đổi-proxy" : "kill"})`,
      );
      try {
        // Dynamic import tránh circular; chỉ log
        const { logChromeCloseIntent } = await import("./chrome-debug-guard.js");
        logChromeCloseIntent(
          opts?.forceClose ? "forceClose" : "killChrome",
          `#${cur.browserIndex} profile=${profileId}`,
        );
      } catch {
        /* ignore */
      }
      await cur.browser.close().catch(() => undefined);
      return;
    }
    if (opts?.kill) {
      console.warn(
        `[browser-pool] bỏ qua kill #${cur.browserIndex} — chỉ disconnect CDP (never-kill)`,
      );
    }
    // Keep-alive / never-kill: ngắt CDP thôi — Chrome cửa sổ vẫn mở
    try {
      cur.browser.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export const browserPool = new BrowserPool();
