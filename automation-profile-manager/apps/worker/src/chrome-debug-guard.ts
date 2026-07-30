/**
 * Debug + bảo vệ cửa sổ Chrome:
 * - Log stack mọi browser.close / page.close
 * - Chặn đóng khi đang MAPS / last-tab / tab Maps
 * - Watchdog: nếu cửa sổ bị ẨN (IsWindowVisible=false) → ShowWindow lại ngay
 *
 * CHROME_DEBUG mặc định bật. Tắt: CHROME_DEBUG=0
 */
import type { Browser, Page } from "puppeteer";
import { existsSync } from "fs";
import path from "path";

const DEBUG =
  (process.env.CHROME_DEBUG ?? "1").toLowerCase() !== "0" &&
  (process.env.CHROME_DEBUG ?? "1").toLowerCase() !== "false";

const ENSURE_VISIBLE_PS1 = path.resolve(
  __dirname,
  "../scripts/ensure-chrome-visible.ps1",
);

type CloseKind = "browser.close" | "page.close" | "forceClose" | "killChrome" | "unhide";

const recentActions: Array<{ at: number; kind: string; detail: string; stack: string }> =
  [];
const MAX_RECENT = 40;

let mapsGuardActive = false;
let closeGuardsInstalled = false;
const watchdogs = new Map<number, NodeJS.Timeout>();

function pushAction(kind: string, detail: string) {
  const stack = (new Error().stack || "").split("\n").slice(2, 12).join("\n");
  recentActions.push({ at: Date.now(), kind, detail, stack });
  if (recentActions.length > MAX_RECENT) recentActions.shift();
  if (DEBUG) {
    console.warn(`[chrome-guard] ${kind} ${detail}`);
    console.warn(`[chrome-guard] stack:\n${stack}`);
  }
}

export function setMapsChromeGuard(on: boolean) {
  mapsGuardActive = on;
  console.log(`[chrome-guard] mapsGuard=${on}`);
}

export function isMapsChromeGuardOn() {
  return mapsGuardActive;
}

export function dumpRecentChromeActions(limit = 8) {
  const rows = recentActions.slice(-limit);
  for (const r of rows) {
    console.warn(
      `[chrome-guard] recent ${new Date(r.at).toISOString()} ${r.kind} ${r.detail}\n${r.stack}`,
    );
  }
}

export async function ensureChromeWindowVisible(
  rootPid: number,
  reason: string,
): Promise<{ ok: boolean; wasHidden: boolean; detail: string }> {
  if (!(rootPid > 0)) {
    return { ok: false, wasHidden: false, detail: "no-pid" };
  }
  if (!existsSync(ENSURE_VISIBLE_PS1)) {
    return { ok: false, wasHidden: false, detail: "missing-ps1" };
  }
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ENSURE_VISIBLE_PS1,
        "-RootPid",
        String(Number(rootPid)),
      ],
      { timeout: 12_000, windowsHide: true, encoding: "utf8" },
    );
    const detail =
      String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    const wasHidden = /wasHidden=True/i.test(detail);
    const ok = /nowVis=True/i.test(detail) || /wasHidden=False.*nowVis=True/i.test(detail);
    if (wasHidden) {
      console.error(
        `[chrome-guard] CỬA SỔ BỊ ẨN → đã ShowWindow lại (pid=${rootPid}, reason=${reason}) ${detail}`,
      );
      dumpRecentChromeActions(6);
      pushAction("unhide", `pid=${rootPid} reason=${reason} ${detail}`);
    } else if (DEBUG) {
      console.log(
        `[chrome-guard] window-ok pid=${rootPid} reason=${reason} ${detail}`,
      );
    }
    return { ok: ok || /nowVis=True/i.test(detail), wasHidden, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[chrome-guard] ensureVisible fail pid=${rootPid}: ${msg.slice(0, 180)}`,
    );
    return { ok: false, wasHidden: false, detail: msg.slice(0, 120) };
  }
}

export function startChromeWindowWatchdog(
  rootPid: number,
  label: string,
  intervalMs = 1500,
) {
  stopChromeWindowWatchdog(rootPid);
  if (!(rootPid > 0)) return;
  console.log(`[chrome-guard] watchdog START pid=${rootPid} label=${label}`);
  const timer = setInterval(() => {
    void ensureChromeWindowVisible(rootPid, `watchdog:${label}`);
  }, intervalMs);
  // Unref so watchdog không giữ process sống khi worker tắt
  timer.unref?.();
  watchdogs.set(rootPid, timer);
  void ensureChromeWindowVisible(rootPid, `watchdog-start:${label}`);
}

export function stopChromeWindowWatchdog(rootPid?: number) {
  if (rootPid && rootPid > 0) {
    const t = watchdogs.get(rootPid);
    if (t) {
      clearInterval(t);
      watchdogs.delete(rootPid);
      console.log(`[chrome-guard] watchdog STOP pid=${rootPid}`);
    }
    return;
  }
  for (const [pid, t] of watchdogs) {
    clearInterval(t);
    console.log(`[chrome-guard] watchdog STOP pid=${pid}`);
  }
  watchdogs.clear();
}

/** Gắn guard từ instance thật (Puppeteer không export class Browser/Page ổn định). */
export function installChromeCloseGuardsOnBrowser(browser: Browser) {
  if (closeGuardsInstalled) return;
  closeGuardsInstalled = true;

  try {
    const proto = Object.getPrototypeOf(browser) as Browser;
    const origClose = proto.close.bind(proto);
    // Patch trên prototype của instance
    const bProto = Object.getPrototypeOf(browser) as {
      close: (this: Browser) => Promise<void>;
    };
    const rawClose = bProto.close;
    bProto.close = async function guardedBrowserClose(this: Browser) {
      pushAction(
        "browser.close",
        `mapsGuard=${mapsGuardActive} connected=${this.connected}`,
      );
      if (mapsGuardActive && process.env.ALLOW_CHROME_KILL !== "1") {
        console.error(
          `[chrome-guard] CHẶN browser.close — đang MAPS (ALLOW_CHROME_KILL=1 chỉ khi đổi proxy cố ý)`,
        );
        dumpRecentChromeActions(5);
        return;
      }
      return rawClose.apply(this);
    };
    void origClose;
  } catch (e) {
    console.warn(`[chrome-guard] không patch Browser.close:`, e);
  }

  void (async () => {
    try {
      const pages = await browser.pages();
      const sample = pages.find((p) => !p.isClosed());
      if (!sample) {
        console.warn(`[chrome-guard] chưa có page để patch Page.close — sẽ thử lại lần connect sau`);
        closeGuardsInstalled = false;
        return;
      }
      const pProto = Object.getPrototypeOf(sample) as {
        close: (this: Page, options?: { runBeforeUnload?: boolean }) => Promise<void>;
      };
      const rawPageClose = pProto.close;
      pProto.close = async function guardedPageClose(
        this: Page,
        options?: { runBeforeUnload?: boolean },
      ) {
        let url = "";
        try {
          url = this.url();
        } catch {
          /* ignore */
        }
        let pageCount = -1;
        try {
          pageCount = (await this.browser().pages()).filter((p) => !p.isClosed())
            .length;
        } catch {
          /* ignore */
        }
        pushAction(
          "page.close",
          `mapsGuard=${mapsGuardActive} pages=${pageCount} url=${url.slice(0, 100)}`,
        );
        if (mapsGuardActive) {
          console.error(
            `[chrome-guard] CHẶN page.close khi MAPS — url=${url.slice(0, 80)}`,
          );
          return;
        }
        if (/google\.(com|com\.\w+)\/maps/i.test(url)) {
          console.error(
            `[chrome-guard] CHẶN page.close tab Maps — url=${url.slice(0, 80)}`,
          );
          return;
        }
        if (pageCount >= 0 && pageCount <= 1) {
          console.error(
            `[chrome-guard] CHẶN page.close — tab CUỐI (tránh ẩn/mất cửa sổ)`,
          );
          dumpRecentChromeActions(5);
          return;
        }
        return rawPageClose.apply(this, [options]);
      };
      console.log(
        `[chrome-guard] close-guards installed (CHROME_DEBUG=${DEBUG ? "on" : "off"})`,
      );
    } catch (e) {
      console.warn(`[chrome-guard] không patch Page.close:`, e);
      closeGuardsInstalled = false;
    }
  })();
}

export function logChromeCloseIntent(kind: CloseKind, detail: string) {
  pushAction(kind, detail);
}

export function chromeGuardEnabled() {
  return DEBUG;
}
