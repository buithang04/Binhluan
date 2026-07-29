import { hostname } from "os";
import { existsSync } from "fs";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import { config as loadEnv } from "dotenv";
import net from "net";
import { spawn } from "child_process";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import puppeteer, { Browser } from "puppeteer";
import { QUEUE_PROFILE_TASKS, QUEUE_BROWSER_CONTROL, ProfileTaskJob, BrowserControlJob, mapsReviewPayloadSchema } from "@apm/shared";
import { browserPool } from "./browser-pool";
import { HumanCursor } from "./humanize";
import { applyStealth } from "./stealth";
import { postMapsReview } from "./maps-review";
import {
  attachProxyAuthToPage,
  assertProxyBeforeMaps,
  bindProxyAuthToBrowser,
  proxyAuthDebug,
} from "./proxy-auth.js";
import {
  pageLooksLikeTotpChallenge,
  tryAutoFillGoogleTotp,
} from "./totp-login.js";

// Load apps/worker/.env trước khi đọc token (tránh lệch INTERNAL_API_TOKEN với API)
loadEnv({ path: path.resolve(__dirname, "../.env") });

const FOCUS_CHROME_PS1 = path.resolve(__dirname, "../scripts/focus-chrome-window.ps1");
const maximizedBrowsers = new WeakSet<Browser>();

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:4000/api";
const INTERNAL_TOKEN =
  process.env.INTERNAL_API_TOKEN ||
  (process.env.NODE_ENV === "production" ? "" : "dev-internal-token-local-only");
if (!INTERNAL_TOKEN) {
  throw new Error("INTERNAL_API_TOKEN is required in production");
}
const STORAGE_DIR = process.env.PROFILE_STORAGE_DIR || "./data/profiles";
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1));
/** Startup reclaim: 0 = không tự mở Chrome mới khi restart (tránh nhảy cửa sổ). */
const RECLAIM_RELAUNCH_MAX = Math.max(0, Number(process.env.WORKER_RECLAIM_RELAUNCH_MAX || 0));
const WORKER_ID = process.env.WORKER_ID || `worker-${hostname()}`;
/** LOGIN: giữ Chrome sống sau khi đăng nhập (không đóng). */
const KEEP_BROWSER_ALIVE = (process.env.WORKER_KEEP_BROWSER_ALIVE ?? "true").toLowerCase() !== "false";
/** Tạm tắt proxy khi mở browser/login — bật lại khi cần automation qua proxy. */
const USE_PROXY = (process.env.WORKER_USE_PROXY ?? "false").toLowerCase() === "true";
/**
 * Mode A (mặc định):
 * - LOGIN: không proxy (IP máy) → tạo session trên thiết bị
 * - Job/task sau (YouTube… phía user): dùng proxy sticky đã gán profile khi WORKER_USE_PROXY=true
 * WORKER_LOGIN_USE_PROXY=true chỉ khi muốn login cũng qua proxy (mode B).
 */
const LOGIN_USE_PROXY =
  (process.env.WORKER_LOGIN_USE_PROXY ?? "false").toLowerCase() === "true";
const TASK_USE_PROXY = USE_PROXY;
/** Kết nối Chrome đang mở sẵn (remote debugging), ví dụ: http://127.0.0.1:9222 */
const CDP_URL = (process.env.WORKER_CDP_URL || "").trim();
/** Mỗi browser tối đa N tab — đóng tab thừa (giữ tab đang dùng). */
const MAX_TABS_PER_BROWSER = Math.max(1, Number(process.env.WORKER_MAX_TABS || 3));
const tabLimiterAttached = new WeakSet<Browser>();
let softReclaimBusy = false;
/** Profile đang LOGIN/MAPS — cấm soft-reclaim/focus CDP connect (tránh cướp session → Chrome tắt). */
const busyProfileIds = new Set<string>();

/** Chrome thường / Beta trên máy — không dùng Chromium test của Puppeteer. */
function resolveChromeExecutable(): { executablePath?: string; channel?: "chrome" | "chrome-beta" | "chrome-dev" | "chrome-canary" } {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    return { executablePath: fromEnv };
  }

  const channel = (process.env.WORKER_CHROME_CHANNEL || "chrome").toLowerCase();
  const candidates: Record<string, string[]> = {
    chrome: [
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ],
    "chrome-beta": [
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome Beta", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome Beta", "Application", "chrome.exe"),
    ],
    "chrome-dev": [
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome Dev", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome Dev", "Application", "chrome.exe"),
    ],
    "chrome-canary": [
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome SxS", "Application", "chrome.exe"),
    ],
  };

  const paths = candidates[channel] || candidates.chrome;
  for (const p of paths) {
    if (p && existsSync(p)) return { executablePath: p };
  }

  // Fallback: để Puppeteer tự tìm Chrome cài sẵn theo channel
  if (channel === "chrome-beta" || channel === "chrome-dev" || channel === "chrome-canary") {
    return { channel };
  }
  return { channel: "chrome" };
}

const CHROME_LAUNCH = resolveChromeExecutable();
console.log(
  `[worker] Using browser: ${CHROME_LAUNCH.executablePath || CHROME_LAUNCH.channel || "puppeteer-default"} | loginProxy=${LOGIN_USE_PROXY ? "ON" : "OFF"} | taskProxy=${TASK_USE_PROXY ? "ON" : "OFF"} | cdp=${CDP_URL || "off"}`,
);

async function api<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": INTERNAL_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Internal API ${route} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

type ClaimPayload = {
  profile: {
    id: string;
    browserIndex: number;
    browserAlive: boolean;
    browserProfilePath: string;
    cookiePath: string;
    localStoragePath: string | null;
    userAgent: string | null;
    viewport: { width: number; height: number } | null;
    currentTask: string | null;
  };
  account: {
    id: string;
    email: string;
    password: string;
    totpSecret?: string | null;
    recoveryEmail?: string | null;
    status?: string;
  };
  proxy: {
    id: string;
    host: string;
    port: number;
    protocol: string;
    username: string | null;
    password: string | null;
  } | null;
  job?: {
    id: string;
    taskCode: string;
    payload?: Record<string, unknown> | null;
  };
};

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function loadCookies(cookieFile: string) {
  try {
    const raw = await readFile(cookieFile, "utf8");
    return JSON.parse(raw) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function saveCookies(page: Awaited<ReturnType<Browser["newPage"]>>, cookieFile: string) {
  const cookies = await page.cookies();
  await ensureDir(path.dirname(cookieFile));
  await writeFile(cookieFile, JSON.stringify(cookies, null, 2), "utf8");
}

async function saveWebStorage(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  storagePath: string | null | undefined,
) {
  if (!storagePath) return;
  const file = path.resolve(STORAGE_DIR, storagePath);
  try {
    // Không dùng nested function trong evaluate — tsx/esbuild inject `__name` → ReferenceError trong Chrome
    const data = await page.evaluate(`(() => {
      const outLocal = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) outLocal[k] = localStorage.getItem(k) || "";
      }
      const outSession = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) outSession[k] = sessionStorage.getItem(k) || "";
      }
      return {
        localStorage: outLocal,
        sessionStorage: outSession,
        origin: location.origin,
      };
    })()`);
    await ensureDir(path.dirname(file));
    await writeFile(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.warn("[worker] saveWebStorage skipped:", e instanceof Error ? e.message : e);
  }
}

async function restoreWebStorage(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  storagePath: string | null | undefined,
) {
  if (!storagePath) return;
  const file = path.resolve(STORAGE_DIR, storagePath);
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      localStorage?: Record<string, string>;
      sessionStorage?: Record<string, string>;
    };
    await page.evaluate(
      // string form tránh tsx inject __name vào nested callbacks
      `(payload) => {
        try {
          const ls = payload.localStorage || {};
          const ss = payload.sessionStorage || {};
          for (const k of Object.keys(ls)) localStorage.setItem(k, ls[k]);
          for (const k of Object.keys(ss)) sessionStorage.setItem(k, ss[k]);
        } catch (e) {}
      }`,
      raw,
    );
  } catch {
    /* no file yet */
  }
}

async function verifyExitIp(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await page
    .goto("https://api.ipify.org?format=json", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    .catch(() => undefined);
  const ip = await page
    .evaluate(() => {
      try {
        return (JSON.parse(document.body?.innerText || "{}") as { ip?: string }).ip || null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  console.log(`[worker] exit IP: ${ip || "unknown"}`);
  return ip;
}

async function retryOperation<T>(fn: () => Promise<T>, retries = 3, label = "op"): Promise<T> {
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`[worker] ${label} retry ${i + 1}/${retries}:`, e);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

function proxyServer(proxy: NonNullable<ClaimPayload["proxy"]>) {
  // Chỉ host:port — user/pass proxy gắn qua CDP (tránh popup "Sign in" nhầm với Google)
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

function chromeLaunchArgs(withProxy: boolean, proxy: ClaimPayload["proxy"], debugPort?: number) {
  const args: string[] = [
    "--start-maximized",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    // Ẩn bubble "Restore pages? / Chrome didn't shut down correctly"
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    // Không throttle khi cửa sổ mất focus / bị che — tránh treo đến khi user click
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
    // Port cố định khi spawn detached; 0 khi puppeteer.launch
    `--remote-debugging-port=${debugPort && debugPort > 0 ? debugPort : 0}`,
  ];
  if (process.platform === "linux") {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (withProxy && proxy) {
    args.push(`--proxy-server=${proxyServer(proxy)}`);
    // Chặn WebRTC lộ IP LAN/máy thật dù HTTP đi qua proxy
    args.push(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    );
  }
  return args;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Cannot allocate debug port"));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForDevToolsPort(port: number, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isDevToolsReachable(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome DevTools :${port} không sẵn sàng sau ${timeoutMs}ms`);
}

/**
 * Trước launch: đánh dấu profile thoát sạch để Chrome không hiện "Restore pages?".
 * (Worker restart / kill process để lại exit_type=Crashed.)
 */
async function markChromeCleanExit(userDataDir: string) {
  const { unlink } = await import("fs/promises");
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  try {
    let prefs: Record<string, unknown> = {};
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(await readFile(prefsPath, "utf8")) as Record<string, unknown>;
    }
    const profile =
      prefs.profile && typeof prefs.profile === "object"
        ? (prefs.profile as Record<string, unknown>)
        : {};
    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    prefs.profile = profile;
    const sessions =
      prefs.sessions && typeof prefs.sessions === "object"
        ? (prefs.sessions as Record<string, unknown>)
        : {};
    delete sessions.crashed_last_session;
    prefs.sessions = sessions;
    await ensureDir(path.dirname(prefsPath));
    await writeFile(prefsPath, JSON.stringify(prefs), "utf8");
  } catch (e) {
    console.warn("[worker] markChromeCleanExit Preferences failed:", e);
  }

  const variationsPath = path.join(userDataDir, "Variations");
  try {
    await writeFile(
      variationsPath,
      JSON.stringify({
        "user_experience_metrics.stability.exited_cleanly": true,
        variations_crash_streak: 0,
      }),
      "utf8",
    );
  } catch {
    /* ignore */
  }

  for (const name of [
    "Default/Last Session",
    "Default/Last Tabs",
    "Default/Current Session",
    "Default/Current Tabs",
  ]) {
    const f = path.join(userDataDir, name);
    if (existsSync(f)) {
      await unlink(f).catch(() => undefined);
    }
  }
}

/**
 * Mở Chrome detached (không phụ thuộc process worker).
 * Worker restart / tsx watch → Chrome vẫn sống; nối lại qua CDP.
 * Trả về browser + pid spawn để focus cửa sổ (puppeteer.connect không có process()).
 */
async function launchBrowser(
  claim: ClaimPayload,
  opts?: { useProxy?: boolean },
): Promise<{ browser: Browser; pid?: number }> {
  if (CDP_URL) {
    console.log(`[worker] connectOverCDP ${CDP_URL} profile=#${claim.profile.browserIndex}`);
    const browser = await puppeteer.connect({
      browserURL: CDP_URL,
      defaultViewport: null,
    });
    return { browser };
  }

  const userDataDir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
  await ensureDir(userDataDir);
  const alivePid = await resolveChromePidByProfileDir(userDataDir).catch(() => null);
  if (!alivePid) {
    await markChromeCleanExit(userDataDir);
  }

  const withProxy = Boolean(opts?.useProxy && claim.proxy);
  console.log(
    `[worker] launch browser #${claim.profile.browserIndex} proxy=${withProxy && claim.proxy ? `${claim.proxy.host}:${claim.proxy.port}` : "OFF"} (detached)`,
  );

  const exe =
    CHROME_LAUNCH.executablePath ||
    path.join(
      process.env["PROGRAMFILES"] || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
  if (!existsSync(exe)) {
    throw new Error(`Chrome executable not found: ${exe}`);
  }

  const port = await findFreePort();
  const args = [
    ...chromeLaunchArgs(withProxy, claim.proxy, port),
    `--user-data-dir=${userDataDir}`,
  ];

  const child = spawn(exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  const spawnPid = child.pid;
  console.log(
    `[worker] Chrome spawned detached #${claim.profile.browserIndex} pid=${spawnPid ?? "?"} debug=:${port}`,
  );

  try {
    await waitForDevToolsPort(port);
  } catch (e) {
    if (spawnPid) {
      try {
        process.kill(spawnPid);
      } catch {
        /* ignore */
      }
    }
    await killChromeUsingProfileDir(userDataDir);
    throw e;
  }

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });

  if (withProxy && claim.proxy) {
    await bindProxyAuthToBrowser(browser, claim.proxy);
    console.log(
      `[worker] launch #${claim.profile.browserIndex} proxy auth ${proxyAuthDebug(claim.proxy)}`,
    );
  }

  const pid =
    spawnPid ||
    (await resolveChromePidByProfileDir(userDataDir).catch(() => undefined));
  return { browser, pid: pid || undefined };
}

/**
 * Lấy Chrome cho profile: pool → CDP reconnect (Chrome còn mở) → launch → kill+relaunch.
 * Tránh lỗi "The browser is already running for userDataDir".
 * Nếu pool/orphan khác chế độ proxy với yêu cầu → đóng rồi launch lại (cùng user-data-dir).
 */
async function connectOrLaunchBrowser(
  claim: ClaimPayload,
  opts?: { useProxy?: boolean },
): Promise<{ browser: Browser; reused: boolean; mode: string; pid?: number }> {
  const wantProxy = opts?.useProxy ?? TASK_USE_PROXY;
  const live = browserPool.get(claim.profile.id);
  if (live?.browser.connected) {
    const pathMismatch =
      live.browserProfilePath &&
      live.browserProfilePath !== claim.profile.browserProfilePath;
    const emailMismatch =
      live.accountEmail &&
      live.accountEmail.toLowerCase() !== claim.account.email.toLowerCase();
    // --proxy-server cố định lúc launch: đổi host/port bắt buộc kill + launch lại
    const wantProxyId = wantProxy && claim.proxy ? claim.proxy.id : "none";
    const liveProxyId = live.proxyEnabled ? live.proxyId || "none" : "none";
    const proxyMismatch =
      Boolean(live.proxyEnabled) !== wantProxy ||
      (wantProxy && liveProxyId !== wantProxyId);
    if (pathMismatch || emailMismatch || proxyMismatch) {
      const proxyLabel =
        wantProxy && claim.proxy
          ? `${claim.proxy.host}:${claim.proxy.port}`
          : "OFF";
      console.log(
        `[worker] #${claim.profile.browserIndex} pool stale (path/email/proxy) — đóng Chrome cũ rồi launch mới (proxy=${proxyLabel}${wantProxy && liveProxyId !== wantProxyId ? ` was=${liveProxyId.slice(0, 8)}` : ""})`,
      );
      await browserPool.release(claim.profile.id, true, { kill: true });
      const staleDir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
      await killChromeUsingProfileDir(staleDir);
    } else {
      return { browser: live.browser, reused: true, mode: "pool", pid: live.pid };
    }
  }

  if (CDP_URL) {
    const launched = await launchBrowser(claim, { useProxy: wantProxy });
    return { browser: launched.browser, reused: false, mode: "cdp-env", pid: launched.pid };
  }

  const userDataDir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
  await ensureDir(userDataDir);

  if (profileDirInUse(userDataDir)) {
    // Orphan không proxy: chỉ reconnect khi cũng không cần proxy (LOGIN).
    // Job cần proxy → kill + launch lại cùng profile + --proxy-server.
    if (!wantProxy) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = await readDevToolsPort(userDataDir);
        if (port && (await isDevToolsReachable(port))) {
          try {
            const browser = await puppeteer.connect({
              browserURL: `http://127.0.0.1:${port}`,
              defaultViewport: null,
            });
            if (wantProxy && claim.proxy) {
              await bindProxyAuthToBrowser(browser, claim.proxy);
            }
            const pid = await resolveChromePidByProfileDir(userDataDir);
            console.log(
              `[worker] reconnect #${claim.profile.browserIndex} via DevTools :${port} (${claim.account.email})`,
            );
            return { browser, reused: true, mode: "devtools", pid };
          } catch (e) {
            console.warn(
              `[worker] DevTools reconnect #${claim.profile.browserIndex} attempt ${attempt + 1} failed:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    console.log(
      `[worker] #${claim.profile.browserIndex} profile dir locked — kill orphan Chrome rồi launch lại (proxy=${wantProxy ? "ON" : "OFF"})`,
    );
    await killChromeUsingProfileDir(userDataDir);
    await new Promise((r) => setTimeout(r, 800));
  }

  try {
    const launched = await launchBrowser(claim, { useProxy: wantProxy });
    return { browser: launched.browser, reused: false, mode: "launch", pid: launched.pid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already running|user data directory is already in use/i.test(msg)) {
      console.warn(`[worker] launch conflict #${claim.profile.browserIndex}: ${msg}`);
      await killChromeUsingProfileDir(userDataDir);
      await new Promise((r) => setTimeout(r, 1000));
      const launched = await launchBrowser(claim, { useProxy: wantProxy });
      return {
        browser: launched.browser,
        reused: false,
        mode: "kill-relaunch",
        pid: launched.pid,
      };
    }
    throw e;
  }
}

async function ensureLiveProxyAuth(live: {
  browser: Browser;
  page: Awaited<ReturnType<Browser["newPage"]>>;
  proxyEnabled?: boolean;
  proxyAuth?: { username: string; password: string } | null;
}) {
  if (!live.proxyEnabled || !live.proxyAuth) return;
  await bindProxyAuthToBrowser(live.browser, live.proxyAuth);
}

/** Đóng tab thừa — giữ keepPage + các tab mới nhất, tối đa MAX_TABS_PER_BROWSER. */
async function enforceMaxTabs(
  browser: Browser,
  keepPage?: Awaited<ReturnType<Browser["newPage"]>> | null,
) {
  const open = (await browser.pages()).filter((p) => !p.isClosed());
  if (open.length <= MAX_TABS_PER_BROWSER) return;

  const keep = new Set<Awaited<ReturnType<Browser["newPage"]>>>();
  if (keepPage && !keepPage.isClosed()) keep.add(keepPage);
  for (const p of [...open].reverse()) {
    if (keep.size >= MAX_TABS_PER_BROWSER) break;
    keep.add(p);
  }
  for (const p of open) {
    if (keep.has(p)) continue;
    await p.close().catch(() => undefined);
  }
}

/** Gắn listener: tab mới vượt quá giới hạn → đóng ngay. */
function attachTabLimiter(browser: Browser) {
  if (tabLimiterAttached.has(browser)) return;
  tabLimiterAttached.add(browser);
  browser.on("targetcreated", (target) => {
    if (target.type() !== "page") return;
    void (async () => {
      try {
        const page = await target.page();
        await enforceMaxTabs(browser, page);
      } catch {
        /* ignore */
      }
    })();
  });
}

async function setupPage(browser: Browser, claim: ClaimPayload, opts?: { useProxy?: boolean }) {
  attachTabLimiter(browser);
  await enforceMaxTabs(browser);
  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  // Tái dùng tab có sẵn — chỉ newPage khi chưa có tab (tránh phình > 3 tab)
  const page =
    pages[0] ||
    (await browser.newPage());
  await enforceMaxTabs(browser, page);
  await applyStealth(page);

  // UA: chỉ override nếu khớp Chrome major với browser thật — tránh fingerprint lệch
  if (claim.profile.userAgent) {
    const realUa = await page.evaluate(() => navigator.userAgent);
    const wantMajor = claim.profile.userAgent.match(/Chrome\/(\d+)/)?.[1];
    const realMajor = realUa.match(/Chrome\/(\d+)/)?.[1];
    if (wantMajor && realMajor && wantMajor === realMajor) {
      await page.setUserAgent(claim.profile.userAgent);
    } else {
      console.log(
        `[worker] skip profile.userAgent (major ${wantMajor || "?"} ≠ browser ${realMajor || "?"}) — giữ UA Chrome thật`,
      );
    }
  }
  // Viewport: chỉ set khi có config; null = cửa sổ maximized (fingerprint tự nhiên hơn)
  if (claim.profile.viewport) await page.setViewport(claim.profile.viewport);
  const useProxy = opts?.useProxy ?? USE_PROXY;
  if (useProxy && claim.proxy) {
    const ok = await bindProxyAuthToBrowser(browser, claim.proxy);
    if (!ok) {
      throw new Error(
        `Không gắn được proxy auth cho #${claim.profile.browserIndex} (${claim.proxy.host}:${claim.proxy.port})`,
      );
    }
  }
  return page;
}

async function runHealthcheck(claim: ClaimPayload) {
  const cookieFile = path.resolve(STORAGE_DIR, claim.profile.cookiePath);
  const live = browserPool.get(claim.profile.id);
  const wantProxy = TASK_USE_PROXY;
  // Không tự launch Chrome mới — scheduler HEALTHCHECK chỉ kiểm tra cửa sổ đang mở
  // (tránh thỉnh thoảng nhảy ra 1 browser khi user không bấm Mở)
  if (!live?.browser.connected) {
    console.log(
      `[worker] HEALTHCHECK #${claim.profile.browserIndex} skip — Chrome chưa mở (không tự launch)`,
    );
    return {
      browserVersion: "n/a",
      result: {
        ok: true,
        skipped: true,
        reason: "browser_not_open",
        browserIndex: claim.profile.browserIndex,
      },
    };
  }
  const reuse = Boolean(live.proxyEnabled) === wantProxy;
  if (!reuse) {
    console.log(
      `[worker] HEALTHCHECK #${claim.profile.browserIndex} skip — Chrome đang mode proxy khác (không relaunch)`,
    );
    return {
      browserVersion: "n/a",
      result: {
        ok: true,
        skipped: true,
        reason: "proxy_mode_mismatch",
        browserIndex: claim.profile.browserIndex,
      },
    };
  }
  const browser = live.browser;

  try {
    const page =
      live.page && !live.page.isClosed()
        ? live.page
        : await setupPage(browser, claim, { useProxy: wantProxy });
    if (!live.page || live.page.isClosed()) {
      live.page = page;
    }

    await enforceMaxTabs(browser, page);
    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await saveCookies(page, cookieFile);

    const browserVersion = await browser.version();
    return {
      browserVersion,
      result: {
        ok: true,
        reusedBrowser: true,
        browserIndex: claim.profile.browserIndex,
        url: page.url(),
        title: await page.title(),
        proxy: claim.proxy
          ? `${claim.proxy.host}:${claim.proxy.port}`
          : "OFF",
        browserAlive: true,
      },
    };
  } catch (err) {
    // Không đóng Chrome vì healthcheck lỗi
    throw err;
  }
}

/** URL login sạch — tránh continue=chrome-untrusted:// (gây Google Error 400). */
const GOOGLE_ACCOUNT_URL = "https://myaccount.google.com/";
const GOOGLE_LOGIN_URL =
  "https://accounts.google.com/v3/signin/identifier?continue=" +
  encodeURIComponent(GOOGLE_ACCOUNT_URL) +
  "&flowName=GlifWebSignIn&flowEntry=ServiceLogin&hl=vi";

function isSignInPage(url: string) {
  const u = url.toLowerCase();
  return (
    u.includes("/signin") ||
    u.includes("identifier") ||
    u.includes("challenge") ||
    u.includes("accountchooser") ||
    u.includes("servicelogin") ||
    u.includes("flowname=glifwebsignin") ||
    u.includes("/rejected")
  );
}

/** Chrome NTP / one-google-bar tạo continue hỏng → Google 400. */
function isBrokenGoogleUrl(url: string) {
  const u = url.toLowerCase();
  return (
    u.includes("chrome-untrusted://") ||
    u.includes("chrome://new-tab") ||
    (u.includes("servicelogin") && u.includes("paramsencoded")) ||
    (u.includes("continue=") && u.includes("chrome-"))
  );
}

async function pageLooksLikeGoogle400(page: Awaited<ReturnType<Browser["newPage"]>>) {
  const title = await page.title().catch(() => "");
  if (/error\s*400|400\s*error|bad request/i.test(title)) return true;
  const text = await page
    .evaluate(
      `() => (document.body && document.body.innerText ? document.body.innerText.slice(0, 500) : "")`,
    )
    .catch(() => "");
  return /400\.\s*that|malformed|cannot process the request/i.test(String(text));
}

async function gotoCleanGoogleLogin(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await page
    .goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90_000 })
    .catch(() => undefined);
}

async function ensureNotBrokenGooglePage(page: Awaited<ReturnType<Browser["newPage"]>>) {
  const url = page.url();
  if (isBrokenGoogleUrl(url) || (await pageLooksLikeGoogle400(page))) {
    console.warn(`[worker] broken Google URL → clean login: ${url.slice(0, 120)}`);
    await gotoCleanGoogleLogin(page);
    return true;
  }
  return false;
}

/** Video selfie / interstitial chưa tính READY hoàn tất. */
function isPendingGoogleInterstitial(url: string) {
  const u = url.toLowerCase();
  return (
    u.includes("video-verification") ||
    u.includes("speedbump") ||
    u.includes("gds.google.com") ||
    u.includes("myaccount.google.com/interstitials")
  );
}

/** Chỉ coi là đã login khi đã vào trang tài khoản — không match nhầm signin / video selfie. */
function looksLoggedIn(url: string) {
  const u = url.toLowerCase();
  if (isSignInPage(u)) return false;
  if (isPendingGoogleInterstitial(u)) return false;
  return (
    u.includes("myaccount.google.com") ||
    u.includes("mail.google.com") ||
    u.includes("drive.google.com") ||
    /accounts\.google\.com\/b\/\d+/.test(u) ||
    u.includes("google.com/account")
  );
}

async function hasGoogleSessionCookies(page: Awaited<ReturnType<Browser["newPage"]>>) {
  const cookies = await page.cookies().catch(() => []);
  const sessionNames = new Set([
    "SID",
    "HSID",
    "SSID",
    "LSID",
    "__Secure-1PSID",
    "__Secure-3PSID",
  ]);
  return cookies.some(
    (c) => (c.domain || "").includes("google.") && sessionNames.has(c.name),
  );
}

async function pageMentionsEmail(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  email: string,
) {
  const needle = email.trim().toLowerCase();
  if (!needle) return false;
  const hit = await page
    .evaluate((e) => {
      const t = (document.body?.innerText || "").toLowerCase();
      return t.includes(e);
    }, needle)
    .catch(() => false);
  return hit;
}

/** Đã vào trang tài khoản thật (không dựa cookie lẻ — tránh READY giả). */
async function isLoggedIn(page: Awaited<ReturnType<Browser["newPage"]>>) {
  const url = page.url();
  if (isBrokenGoogleUrl(url) || (await pageLooksLikeGoogle400(page))) return false;
  if (isSignInPage(url)) return false;
  if (isPendingGoogleInterstitial(url)) return false;
  return looksLoggedIn(url);
}

/**
 * Xác nhận đã login đúng email trên myaccount.
 * Cookie đơn thuần không đủ → tránh báo READY khi chỉ thấy Error 400 / NTP.
 */
async function verifyGoogleSession(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  email: string,
  human?: HumanCursor,
) {
  await ensureNotBrokenGooglePage(page);
  await page
    .goto(GOOGLE_ACCOUNT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    .catch(() => undefined);
  await human?.pause(600, 1200);
  await dismissGooglePrompts(page, human, undefined).catch(() => undefined);
  await ensureNotBrokenGooglePage(page);

  const url = page.url();
  if (isBrokenGoogleUrl(url) || (await pageLooksLikeGoogle400(page))) {
    return { ok: false, reason: "google_400" as const };
  }
  if (isSignInPage(url) || isPendingGoogleInterstitial(url)) {
    return { ok: false, reason: "signin_or_challenge" as const };
  }
  if (!url.toLowerCase().includes("myaccount.google.com")) {
    return { ok: false, reason: "not_on_myaccount" as const };
  }

  const emailOk = await pageMentionsEmail(page, email);
  // Bắt buộc thấy email trên trang — đúng “có hồ sơ tài khoản”
  if (!emailOk) {
    return { ok: false, reason: "email_not_on_page" as const };
  }
  return {
    ok: true as const,
    emailMatched: true,
    reason: "matched" as const,
  };
}

/**
 * Đưa tab về trang hồ sơ Google (myaccount) + bấm bubble Chrome "Continue as …".
 * Dùng sau login / focus / khi Chrome bị kéo sang example.com.
 * quiet=true: không bringToFront (tránh nhảy sang cửa sổ account khác).
 */
async function ensureOnGoogleAccountProfile(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  human?: HumanCursor,
  opts?: { forceGoto?: boolean; quiet?: boolean; chromePid?: number },
) {
  if (page.isClosed()) return false;
  const browser = page.browser();
  const chromePid = opts?.chromePid ?? browser.process()?.pid;

  // Bubble native Chrome (Continue as …) — chỉ trong cây process của đúng Chrome này
  for (let i = 0; i < 3; i++) {
    const native = await clickChromeNativeContinueAs(chromePid).catch(() => null);
    if (native) {
      console.log(`[worker] dismissed Chrome bubble: ${native}`);
      if (human) await human.pause(500, 1000);
      else await new Promise((r) => setTimeout(r, 700));
    } else break;
  }
  await dismissGooglePrompts(page, human, browser).catch(() => undefined);

  const url = page.url().toLowerCase();
  const onProfile =
    url.includes("myaccount.google.com") && !isPendingGoogleInterstitial(url);
  if (!onProfile || opts?.forceGoto) {
    if (!opts?.quiet) {
      console.log(`[worker] mở hồ sơ Google → ${GOOGLE_ACCOUNT_URL}`);
    }
    await page
      .goto(GOOGLE_ACCOUNT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      .catch(() => undefined);
    if (human) await human.pause(600, 1200);
    else await new Promise((r) => setTimeout(r, 800));
    await dismissGooglePrompts(page, human, browser).catch(() => undefined);
    const native2 = await clickChromeNativeContinueAs(chromePid).catch(() => null);
    if (native2) console.log(`[worker] dismissed Chrome bubble: ${native2}`);
  }

  if (!opts?.quiet) {
    await page.bringToFront().catch(() => undefined);
  }
  return page.url().toLowerCase().includes("myaccount.google.com");
}

/**
 * Click nút native Chrome (bubble "Continue as …") qua UI Automation — Windows.
 * Nếu có chromePid: chỉ bấm trong cửa sổ thuộc process tree đó (không đụng Chrome account khác).
 */
async function clickChromeNativeContinueAs(chromePid?: number): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const pidNum = chromePid && Number(chromePid) > 0 ? Number(chromePid) : 0;
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Pid {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$rootPid = ${pidNum}
$allow = @()
if ($rootPid -gt 0) {
  function Get-DescendantPids([int]$id) {
    $all = @($id)
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object {
      $all += Get-DescendantPids ([int]$_.ProcessId)
    }
    return $all
  }
  $allow = @(Get-DescendantPids $rootPid | Select-Object -Unique)
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$btnType = [System.Windows.Automation.ControlType]::Button
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $btnType)
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
foreach ($b in $buttons) {
  try {
    $name = $b.Current.Name
    if ($name -match '(?i)^Continue as\\b' -or $name -match '(?i)Use Chrome without an account' -or $name -match '(?i)^Tiếp tục với\\b') {
      if ($allow.Count -gt 0) {
        $ok = $false
        try {
          $hwnd = 0
          $walk = $b
          while ($walk -ne $null) {
            if ($walk.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') {
              $hwnd = $walk.Current.NativeWindowHandle; break
            }
            $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($walk)
          }
          if ($hwnd) {
            $procId = 0
            [void][Win32Pid]::GetWindowThreadProcessId([IntPtr]$hwnd, [ref]$procId)
            if ($allow -contains $procId) { $ok = $true }
          }
        } catch {}
        if (-not $ok) { continue }
      }
      $pat = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pat.Invoke()
      Write-Output $name
      exit 0
    }
  } catch {}
}
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8_000, windowsHide: true, encoding: "utf8" },
    );
    const name = String(stdout || "").trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Nút bỏ qua / hủy interstitial Google (recovery options, video selfie, …).
 * KHÔNG gồm Lưu / Tiếp tục / Save — tránh lưu SĐT recovery.
 */
const SKIP_PROMPT_SOURCE = `
  const priority = [
    /^continue as\\b/i,
    /use chrome without an account/i,
    /^(huỷ|hủy|cancel)$/i,
    /không cảm ơn/i,
    /^no thanks$/i,
    /remind me later/i,
    /để sau/i,
    /^maybe later$/i,
    /^not now$/i,
    /^skip( for now)?$/i,
    /^bỏ qua$/i,
    /^(đóng|close|dismiss)$/i,
  ];
  function labelOf(n) {
    const el = n;
    return (
      el.getAttribute?.("aria-label") ||
      el.getAttribute?.("data-tooltip") ||
      el.textContent ||
      el.value ||
      ""
    )
      .replace(/\\s+/g, " ")
      .trim();
  }
  function isVisible(n) {
    const el = n;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }
  const clickables = Array.from(
    document.querySelectorAll(
      "button, div[role='button'], span[role='button'], a[role='button'], a, input[type='button'], input[type='submit']",
    ),
  ).filter(isVisible);
  for (const re of priority) {
    const el = clickables.find((n) => {
      const t = labelOf(n);
      return re.test(t) && t.length < 120;
    });
    if (el) {
      el.click();
      return labelOf(el).slice(0, 80) || "clicked";
    }
  }
  // Text nằm trong span con (Material) — bấm button/cha gần nhất
  const leaves = Array.from(document.querySelectorAll("span, div, button, a")).filter(isVisible);
  for (const re of priority) {
    const leaf = leaves.find((n) => {
      const t = labelOf(n);
      return re.test(t) && t.length < 40;
    });
    if (leaf) {
      const target = leaf.closest("button, [role='button'], a") || leaf;
      target.click();
      return labelOf(leaf).slice(0, 80) || "clicked";
    }
  }
  return null;
`;

/** Bấm trong 1 page: Huỷ / Bỏ qua / Để sau / Continue as … */
async function clickPromptInPage(
  page: Awaited<ReturnType<Browser["newPage"]>>,
): Promise<string | null> {
  return page.evaluate(`(() => { ${SKIP_PROMPT_SOURCE} })()`) as Promise<string | null>;
}

/** Lưới ảnh reCAPTCHA (/bframe) — bắt buộc giải tay. Checkbox vẫn có thể auto-tick. */
function hasRecaptchaManualChallenge(
  page: Awaited<ReturnType<Browser["newPage"]>>,
): boolean {
  return page.frames().some((f) => f.url().toLowerCase().includes("/bframe"));
}

/**
 * Tích ô reCAPTCHA "Tôi không phải là người máy" trong iframe Google.
 * Chỉ bấm checkbox (anchor) — nếu ra challenge chọn ảnh thì để user làm tay.
 */
async function clickRecaptchaCheckbox(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  human?: HumanCursor,
): Promise<boolean> {
  const frames = page.frames();
  let clicked = false;

  for (const frame of frames) {
    const furl = frame.url().toLowerCase();
    // iframe checkbox = /anchor ; challenge ảnh = /bframe — bỏ bframe
    if (!furl.includes("recaptcha") && !furl.includes("/anchor")) continue;
    if (furl.includes("/bframe")) continue;

    try {
      const state = await frame.evaluate(() => {
        const el = document.querySelector(
          "#recaptcha-anchor, .recaptcha-checkbox, [role='checkbox']",
        );
        if (!el) return "missing";
        if (el.getAttribute("aria-checked") === "true") return "checked";
        if (el.classList?.contains("recaptcha-checkbox-checked")) return "checked";
        return "unchecked";
      });
      if (state === "checked") {
        clicked = true;
        continue;
      }
      if (state === "missing") continue;

      const handle =
        (await frame.$("#recaptcha-anchor")) ||
        (await frame.$(".recaptcha-checkbox-border")) ||
        (await frame.$(".recaptcha-checkbox")) ||
        (await frame.$("[role='checkbox']"));
      if (!handle) continue;

      if (human) await human.pause(500, 1200);
      else await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));

      // click qua ElementHandle của frame (Puppeteer tự map tọa độ)
      await handle.click({ delay: 40 + Math.floor(Math.random() * 80) });
      console.log(`[worker] đã tích reCAPTCHA (Tôi không phải là người máy)`);
      clicked = true;
      if (human) await human.pause(1200, 2200);
      else await new Promise((r) => setTimeout(r, 1800));
    } catch {
      /* iframe cross-origin / chưa load */
    }
  }

  if (!clicked) return false;

  // Nếu đã tick xong → bấm Tiếp theo / Next trên trang challenge (nút enabled)
  try {
    const nextClicked = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, div[role='button'], span[role='button']"),
      );
      const next = nodes.find((n) => {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        const el = n as HTMLElement;
        const disabled =
          el.getAttribute("disabled") != null ||
          el.getAttribute("aria-disabled") === "true" ||
          el.classList.contains("VfPpkd-Button-disabled");
        return /^(tiếp theo|next|continue|xác minh)$/i.test(t) && !disabled && t.length < 40;
      }) as HTMLElement | undefined;
      if (!next) return false;
      next.click();
      return true;
    });
    if (nextClicked) {
      console.log(`[worker] bấm Tiếp theo sau reCAPTCHA`);
      if (human) await human.pause(800, 1500);
      else await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    /* ignore */
  }

  return true;
}

/**
 * Bấm Huỷ / Bỏ qua / Để sau / Continue as… trên interstitial Google
 * (recoveryoptions, video selfie, speedbump…). Không bấm Lưu.
 * Quét mọi page/frame đang mở.
 */
async function dismissGooglePrompts(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  human?: HumanCursor,
  browser?: Browser | null,
) {
  let any = false;
  const pages = browser ? await browser.pages().catch(() => [page]) : [page];
  const unique = [...new Set(pages.filter((p) => !p.isClosed()))];
  if (!unique.includes(page) && !page.isClosed()) unique.unshift(page);

  for (const p of unique) {
    // Không đụng tab Maps/Review — auto "Close" phá form đánh giá
    const pageUrl = p.url().toLowerCase();
    if (
      pageUrl.includes("google.com/maps") ||
      pageUrl.includes("maps.google.") ||
      pageUrl.includes("reviewsservice") ||
      pageUrl.includes("writereview")
    ) {
      continue;
    }
    // Đang challenge ảnh → không auto-click (để user giải tay)
    if (hasRecaptchaManualChallenge(p)) {
      continue;
    }
    // reCAPTCHA "Tôi không phải là người máy" (chỉ checkbox)
    if (await clickRecaptchaCheckbox(p, human).catch(() => false)) {
      any = true;
    }

    for (let i = 0; i < 6; i++) {
      const frames = p.frames();
      let clicked: string | null = null;
      for (const frame of frames) {
        try {
          clicked = (await frame.evaluate(
            `(() => { ${SKIP_PROMPT_SOURCE} })()`,
          )) as string | null;
        } catch {
          clicked = null;
        }
        if (clicked) break;
      }
      if (!clicked) clicked = await clickPromptInPage(p).catch(() => null);
      if (!clicked) break;
      any = true;
      console.log(`[worker] dismissed prompt: ${clicked}`);
      if (human) await human.pause(500, 1000);
      else await new Promise((r) => setTimeout(r, 700));
    }

    // Màn recovery options (gds) — nếu còn kẹt sau khi bấm Huỷ thì về myaccount
    const url = p.url().toLowerCase();
    if (url.includes("gds.google.com") || url.includes("recoveryoptions") || url.includes("/interstitials")) {
      const again = await clickPromptInPage(p).catch(() => null);
      if (again) {
        any = true;
        console.log(`[worker] dismissed recovery/skip: ${again}`);
        if (human) await human.pause(600, 1200);
        else await new Promise((r) => setTimeout(r, 800));
      }
      if (
        p.url().toLowerCase().includes("gds.google.com") ||
        p.url().toLowerCase().includes("recoveryoptions")
      ) {
        await p
          .goto(GOOGLE_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
          .catch(() => undefined);
        any = true;
        console.log(`[worker] left recovery interstitial → myaccount`);
      }
    }
  }

  const native = await clickChromeNativeContinueAs(browser?.process()?.pid);
  if (native) {
    any = true;
    console.log(`[worker] dismissed Chrome bubble: ${native}`);
    if (human) await human.pause(600, 1200);
    else await new Promise((r) => setTimeout(r, 800));
  }

  return any;
}

const GOOGLE_PASS_SEL =
  'input[type="password"][name="Passwd"], input[name="Passwd"]:not([aria-hidden="true"])';

/** Điền MK Google khi ô Passwd hiện (sau reCAPTCHA / challenge). */
async function tryAutoFillGooglePassword(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  password: string,
  human?: HumanCursor,
): Promise<"filled" | "missing" | "already" | "failed"> {
  if (!password) return "missing";
  const state = await page
    .evaluate((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement | null;
      if (!input) return "missing";
      if (input.getAttribute("aria-hidden") === "true") return "missing";
      const style = window.getComputedStyle(input);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return "missing";
      }
      const rect = input.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return "missing";
      if ((input.value || "").length > 0) return "already";
      return "empty";
    }, GOOGLE_PASS_SEL)
    .catch(() => "missing" as const);

  if (state === "missing") return "missing";
  if (state === "already") return "already";

  try {
    console.log("[worker] Typing Google password into form (sau challenge/reCAPTCHA)");
    if (human) {
      await human.typeText('input[name="Passwd"], input[type="password"]', password);
      await human.pause(400, 900);
      const pwNext = await page.$("#passwordNext");
      if (pwNext) await human.clickElement(pwNext);
      else await page.keyboard.press("Enter");
    } else {
      await page.click(GOOGLE_PASS_SEL).catch(() => undefined);
      await page.type(GOOGLE_PASS_SEL, password, { delay: 45 });
      await new Promise((r) => setTimeout(r, 500));
      const pwNext = await page.$("#passwordNext");
      if (pwNext) await pwNext.click();
      else await page.keyboard.press("Enter");
    }
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 25_000 })
      .catch(() => undefined);
    return "filled";
  } catch (e) {
    console.warn("[worker] auto-fill password failed:", e);
    return "failed";
  }
}

async function waitForLoginSuccess(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  timeoutMs: number,
  pollMs = 500,
  human?: HumanCursor,
  profileId?: string,
  googlePassword?: string,
  abortCtx?: { profileId: string; leaseToken: string; jobRunId: string },
  totpSecret?: string | null,
) {
  const started = Date.now();
  // timeoutMs <= 0 → chờ đến khi browser đóng hoặc login xong
  const browser = page.browser();
  let lastIssue: string | null | undefined;
  let pausedForCaptcha = false;
  let passwordAttempted = false;
  let totpAttempts = 0;
  let lastTotpAt = 0;
  let abortTick = 0;
  while (timeoutMs <= 0 || Date.now() - started < timeoutMs) {
    if (abortCtx && ++abortTick % 3 === 0) {
      const chk = await api<{ abort?: boolean; reason?: string }>(
        "/internal/jobs/abort-check",
        abortCtx,
      ).catch((): { abort?: boolean; reason?: string } => ({ abort: false }));
      if (chk.abort) {
        console.log(`[worker] abort wait — ${chk.reason || "cancelled"}`);
        throw Object.assign(new Error("Cancelled by admin"), { code: "ABORTED" });
      }
    }
    if (await isLoggedIn(page)) {
      if (profileId) await reportLoginIssue(profileId, null);
      if (pausedForCaptcha) {
        console.log(`[worker] reCAPTCHA đã giải — login OK, tiếp tục.`);
      }
      return true;
    }
    if (page.isClosed()) return false;

    const issue = await detectLoginIssue(page).catch(() => null);

    // reCAPTCHA: thử tick checkbox 1 lần, rồi DỪNG chờ giải tay (lưới ảnh / còn captcha)
    if (issue === "RECAPTCHA" || hasRecaptchaManualChallenge(page)) {
      if (!pausedForCaptcha) {
        if (!hasRecaptchaManualChallenge(page)) {
          await clickRecaptchaCheckbox(page, human).catch(() => false);
          await new Promise((r) => setTimeout(r, 2000));
          if (await isLoggedIn(page)) {
            if (profileId) await reportLoginIssue(profileId, null);
            return true;
          }
          // Tick xong hết captcha → thoát nhánh pause, tiếp tục vòng bình thường
          const still =
            (await detectLoginIssue(page).catch(() => null)) === "RECAPTCHA" ||
            hasRecaptchaManualChallenge(page);
          if (!still) {
            if (profileId) await reportLoginIssue(profileId, null);
            // Captcha xong sớm → điền MK nếu đã hiện
            if (googlePassword && !passwordAttempted) {
              const r = await tryAutoFillGooglePassword(page, googlePassword, human);
              if (r === "filled" || r === "already") passwordAttempted = true;
            }
            await dismissGooglePrompts(page, human, browser).catch(() => undefined);
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
        }
        pausedForCaptcha = true;
        if (profileId) await reportLoginIssue(profileId, "RECAPTCHA");
        lastIssue = "RECAPTCHA";
        await page.bringToFront().catch(() => undefined);
        console.log(
          `[worker] ⏸ DỪNG — cần giải reCAPTCHA TAY trên cửa sổ Chrome. ` +
            `Worker chờ đến khi bạn giải xong (không tự chọn ảnh). Sau đó sẽ tự nhập MK.`,
        );
      } else if (issue && issue !== lastIssue) {
        lastIssue = issue;
        if (profileId) await reportLoginIssue(profileId, issue);
      }
      // Không dismiss / không click thêm — chỉ poll
      await new Promise((r) => setTimeout(r, Math.max(pollMs, 1500)));
      continue;
    }

    if (pausedForCaptcha) {
      pausedForCaptcha = false;
      console.log(`[worker] reCAPTCHA đã qua — tự nhập MK nếu có ô mật khẩu…`);
      if (profileId && !issue) await reportLoginIssue(profileId, null);
    }

    // Sau captcha / challenge: ô MK mới hiện → điền tự động
    if (googlePassword && !passwordAttempted && issue !== "WRONG_PASSWORD") {
      const r = await tryAutoFillGooglePassword(page, googlePassword, human);
      if (r === "filled") {
        passwordAttempted = true;
        const pwIssue = await detectLoginIssue(page).catch(() => null);
        if (pwIssue && profileId) {
          lastIssue = pwIssue;
          await reportLoginIssue(profileId, pwIssue);
          console.log(`[worker] loginIssue=${pwIssue}`);
        }
      } else if (r === "already") {
        passwordAttempted = true;
      }
    }

    // 2FA / TOTP — gọi 2fa.live khi Google hỏi mã (tối đa 3 lần, cách nhau ≥10s)
    const wantsTotp =
      Boolean(totpSecret) &&
      (issue === "CHALLENGE" || (await pageLooksLikeTotpChallenge(page).catch(() => false)));
    if (wantsTotp && totpAttempts < 3 && Date.now() - lastTotpAt > 10_000) {
      const r = await tryAutoFillGoogleTotp(page, totpSecret, human);
      if (r === "filled" || r === "failed") {
        totpAttempts += 1;
        lastTotpAt = Date.now();
        if (r === "filled") {
          console.log(`[worker] Đã điền mã 2FA (lần ${totpAttempts})`);
          await new Promise((r2) => setTimeout(r2, 1500));
        } else {
          console.warn(`[worker] 2FA fill failed (lần ${totpAttempts}) — thử lại sau`);
          await new Promise((r2) => setTimeout(r2, 8000));
        }
        continue;
      }
      if (r === "already") {
        lastTotpAt = Date.now();
      }
      // no_input: chờ ô hiện ra ở vòng sau
    }

    await dismissGooglePrompts(page, human, browser).catch(() => undefined);

    if (profileId && issue && issue !== lastIssue) {
      lastIssue = issue;
      await reportLoginIssue(profileId, issue);
      console.log(`[worker] loginIssue=${issue}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Hết giờ: nếu vẫn captcha thì giữ RECAPTCHA để UI hiện
  if (!page.isClosed()) {
    await dismissGooglePrompts(page, human, browser).catch(() => undefined);
    if (profileId) {
      const finalIssue = await detectLoginIssue(page).catch(() => null);
      if (finalIssue) await reportLoginIssue(profileId, finalIssue);
    }
  }
  return isLoggedIn(page);
}

async function pageBlockedAsInsecure(page: Awaited<ReturnType<Browser["newPage"]>>) {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "");
  const blob = text.toLowerCase();
  return (
    blob.includes("may not be secure") ||
    blob.includes("couldn’t sign you in") ||
    blob.includes("couldn't sign you in") ||
    (blob.includes("trình duyệt này") && blob.includes("không an toàn")) ||
    blob.includes("không thể đăng nhập")
  );
}

/**
 * Nhận diện lỗi form Google để hiện trên Status:
 * EMAIL_NOT_FOUND | WRONG_PASSWORD | RECAPTCHA | BROWSER_BLOCKED | CHALLENGE
 */
async function detectLoginIssue(
  page: Awaited<ReturnType<Browser["newPage"]>>,
): Promise<string | null> {
  const url = page.url().toLowerCase();

  // reCAPTCHA v2 (checkbox hoặc lưới ảnh)
  const hasBframe = page.frames().some((f) => f.url().toLowerCase().includes("/bframe"));
  if (
    url.includes("challenge/recaptcha") ||
    url.includes("recaptcha") ||
    hasBframe
  ) {
    return "RECAPTCHA";
  }

  if (await pageBlockedAsInsecure(page).catch(() => false)) {
    return "BROWSER_BLOCKED";
  }

  const text = (
    await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "").catch(() => "")
  ).toLowerCase();

  if (
    text.includes("couldn't find your google account") ||
    text.includes("couldn’t find your google account") ||
    text.includes("không tìm thấy tài khoản") ||
    text.includes("couldn't find your google") ||
    text.includes("enter a valid email") ||
    text.includes("email hoặc số điện thoại không hợp lệ") ||
    (text.includes("không tìm thấy") && text.includes("google"))
  ) {
    return "EMAIL_NOT_FOUND";
  }

  if (
    text.includes("wrong password") ||
    text.includes("mật khẩu không chính xác") ||
    text.includes("incorrect password") ||
    text.includes("password is incorrect") ||
    text.includes("sai mật khẩu") ||
    (text.includes("mật khẩu") && text.includes("không đúng"))
  ) {
    return "WRONG_PASSWORD";
  }

  if (
    text.includes("i'm not a robot") ||
    text.includes("tôi không phải là người máy") ||
    text.includes("không phải là rô-bốt") ||
    text.includes("không phải là robot") ||
    text.includes("chọn tất cả hình ảnh") ||
    text.includes("select all images")
  ) {
    return "RECAPTCHA";
  }

  if (
    url.includes("/challenge/") ||
    url.includes("signin/rejected") ||
    text.includes("verify it’s you") ||
    text.includes("verify it's you") ||
    text.includes("xác minh danh tính") ||
    text.includes("2-step") ||
    text.includes("xác minh 2 bước") ||
    text.includes("try another way") ||
    text.includes("thử cách khác")
  ) {
    return "CHALLENGE";
  }

  return null;
}

async function reportLoginIssue(profileId: string, issue: string | null) {
  await api("/internal/browsers/login-issue", {
    profileId,
    workerId: WORKER_ID,
    issue,
  }).catch(() => undefined);
}

/**
 * Login Google — mở Chrome (có proxy), giữ sống, đánh index.
 * UNREADY → (login ok) → READY. Browser không đóng để job sau tái sử dụng.
 */
async function runGoogleLogin(
  claim: ClaimPayload,
  abortCtx?: { leaseToken: string; jobRunId: string },
) {
  const cookieFile = path.resolve(STORAGE_DIR, claim.profile.cookiePath);
  const manualWaitMs = Number(process.env.WORKER_LOGIN_MANUAL_MS || 600_000);
  const proxyLabel = claim.proxy
    ? `${claim.proxy.host}:${claim.proxy.port}`
    : "none";
  const googleEmail = claim.account.email;
  const googlePassword = claim.account.password;
  const totpSecret = claim.account.totpSecret || null;
  const idx = claim.profile.browserIndex;
  console.log(
    `[worker] LOGIN #${idx} email=${googleEmail} | proxy=OFF (mode A — IP máy) | jobProxy=${proxyLabel} | 2FA=${totpSecret ? "ON" : "OFF"} | keepAlive=${KEEP_BROWSER_ALIVE}`,
  );

  const prev = process.env.WORKER_HEADLESS;
  process.env.WORKER_HEADLESS = "false";
  let browser: Browser | null = null;
  let page: Awaited<ReturnType<Browser["newPage"]>> | null = null;
  let mode = "assisted";
  const loginProxy = LOGIN_USE_PROXY;

  try {
    const ensured = await connectOrLaunchBrowser(claim, { useProxy: loginProxy });
    browser = ensured.browser;
    console.log(
      `[worker] LOGIN #${idx} browser mode=${ensured.mode} reused=${ensured.reused} email=${googleEmail}`,
    );

    const existing = browserPool.get(claim.profile.id);
    if (existing?.browser === browser && existing.page && !existing.page.isClosed()) {
      page = existing.page;
    } else {
      page = await setupPage(browser, claim, { useProxy: loginProxy });
      await browserPool.register({
        profileId: claim.profile.id,
        browserIndex: idx,
        browser,
        page,
        proxyId: claim.proxy?.id ?? "none",
        cookiePath: claim.profile.cookiePath,
        browserProfilePath: claim.profile.browserProfilePath,
        openedAt: new Date(),
        pid:
          ensured.pid ||
          browser.process()?.pid ||
          (await resolveChromePidByProfileDir(
            path.resolve(STORAGE_DIR, claim.profile.browserProfilePath),
          ).catch(() => undefined)),
        accountEmail: googleEmail,
        proxyEnabled: loginProxy,
      });
    }
    {
      const live = browserPool.get(claim.profile.id);
      if (live) {
        live.accountEmail = googleEmail;
        live.loginInProgress = true;
        if (!live.pid && ensured.pid) live.pid = ensured.pid;
      }
    }

    // Mở Browser → đưa Chrome lên màn hình ngay
    const livePid = browserPool.get(claim.profile.id)?.pid;
    await activateBrowserOnScreen(browser, page, {
      preferredPid: livePid || ensured.pid,
      profilePath: path.resolve(STORAGE_DIR, claim.profile.browserProfilePath),
    });
    // Chỉ Esc bubble Restore — không bấm Close (tránh tắt Chrome)
    await dismissRestorePages(page).catch(() => undefined);
    console.log(`[worker] LOGIN #${idx} Chrome active trên màn hình`);

    const browserVersionOpened = await browser.version();
    await api("/internal/browsers/event", {
      profileId: claim.profile.id,
      workerId: WORKER_ID,
      event: "opened",
      browserVersion: browserVersionOpened,
    }).catch(() => undefined);

    if (!browser || !page) throw new Error("Browser/page not ready");
    const activePage = page;

    const human = new HumanCursor(activePage);
    await human.init();

    const cookiesOnDisk = await loadCookies(cookieFile);
    if (cookiesOnDisk.length) {
      await activePage.setCookie(...(cookiesOnDisk as never[])).catch(() => undefined);
    }

    // Hồ sơ đã login đúng email trên myaccount? (không tin cookie / tab Error 400)
    const verified = await verifyGoogleSession(activePage, googleEmail, human);
    if (verified.ok) {
      mode = "existing_session_matched";
      console.log(`[worker] #${idx} session OK — thấy ${googleEmail} trên myaccount`);
      await activePage.bringToFront().catch(() => undefined);
      await saveCookies(activePage, cookieFile);
      await saveWebStorage(activePage, claim.profile.localStoragePath);
      const cookies = await activePage.cookies();
      const browserVersion = await browser.version();
      const liveSess = browserPool.get(claim.profile.id);
      if (liveSess) liveSess.markedReady = true;
      await api("/internal/browsers/event", {
        profileId: claim.profile.id,
        workerId: WORKER_ID,
        event: "ready",
        browserVersion,
      }).catch(() => undefined);
      return {
        browserVersion,
        keepAlive: KEEP_BROWSER_ALIVE,
        markReady: true,
        result: {
          ok: true,
          loggedIn: true,
          mode,
          email: claim.account.email,
          browserIndex: idx,
          browserAlive: KEEP_BROWSER_ALIVE,
          url: activePage.url(),
          cookieCount: cookies.length,
          proxy: proxyLabel,
          proxyAuth: Boolean(claim.proxy?.username),
          pendingManualLogin: false,
        },
      };
    }
    console.log(`[worker] #${idx} chưa có hồ sơ hợp lệ (${verified.reason}) — bắt đầu login`);

    // Chrome đã mở trên form verify / mật khẩu / captcha → không goto sạch (tránh mất tiến trình), chỉ tự điền
    {
      const curUrl = activePage.url();
      const passVisible = await activePage
        .evaluate((sel) => {
          const input = document.querySelector(sel) as HTMLInputElement | null;
          if (!input || input.getAttribute("aria-hidden") === "true") return false;
          const r = input.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        }, GOOGLE_PASS_SEL)
        .catch(() => false);
      const totpVisible = await pageLooksLikeTotpChallenge(activePage).catch(() => false);
      const captchaVisible =
        (await detectLoginIssue(activePage).catch(() => null)) === "RECAPTCHA" ||
        hasRecaptchaManualChallenge(activePage);
      const onAuthForm =
        isSignInPage(curUrl) ||
        isPendingGoogleInterstitial(curUrl) ||
        passVisible ||
        totpVisible ||
        captchaVisible;

      // Chỉ resume khi đã thấy form mật khẩu / 2FA / captcha — không resume chỉ vì URL sign-in
      // (tránh bỏ qua bước điền email khi challenge trống).
      if (onAuthForm && (passVisible || totpVisible || captchaVisible)) {
        console.log(
          `[worker] #${idx} resume form đang mở (pass=${passVisible} totp=${totpVisible} captcha=${captchaVisible}) — tự điền, không goto login mới`,
        );
        mode = "resume_open_form";
        const liveLogin = browserPool.get(claim.profile.id);
        if (liveLogin) liveLogin.loginInProgress = true;
        try {
          await waitForLoginSuccess(
            activePage,
            manualWaitMs,
            700,
            human,
            claim.profile.id,
            googlePassword,
            abortCtx
              ? {
                  profileId: claim.profile.id,
                  leaseToken: abortCtx.leaseToken,
                  jobRunId: abortCtx.jobRunId,
                }
              : undefined,
            totpSecret,
          );
          const confirmed = await verifyGoogleSession(activePage, googleEmail, human);
          const ok = confirmed.ok;
          let loginIssue: string | null = null;
          if (ok) {
            mode = "login_confirmed_resume";
            await reportLoginIssue(claim.profile.id, null);
            await ensureOnGoogleAccountProfile(activePage, human, {
              forceGoto: true,
              chromePid: browser?.process()?.pid,
            }).catch(() => undefined);
          } else {
            loginIssue = await detectLoginIssue(activePage).catch(() => null);
            if (!loginIssue && confirmed.reason) {
              loginIssue =
                confirmed.reason === "signin_or_challenge"
                  ? "CHALLENGE"
                  : confirmed.reason === "google_400"
                    ? "BROWSER_BLOCKED"
                    : "CHALLENGE";
            }
            if (loginIssue) await reportLoginIssue(claim.profile.id, loginIssue);
          }
          await saveCookies(activePage, cookieFile);
          await saveWebStorage(activePage, claim.profile.localStoragePath);
          const cookies = await activePage.cookies();
          const browserVersion = await browser.version();
          if (ok) {
            const live = browserPool.get(claim.profile.id);
            if (live) live.markedReady = true;
            await api("/internal/browsers/event", {
              profileId: claim.profile.id,
              workerId: WORKER_ID,
              event: "ready",
              browserVersion,
            }).catch(() => undefined);
          }
          return {
            browserVersion,
            keepAlive: KEEP_BROWSER_ALIVE,
            markReady: ok,
            loginIssue,
            result: {
              ok,
              loggedIn: ok,
              mode,
              email: claim.account.email,
              browserIndex: idx,
              browserAlive: KEEP_BROWSER_ALIVE,
              url: activePage.url(),
              cookieCount: cookies.length,
              proxy: proxyLabel,
              proxyAuth: Boolean(claim.proxy?.username),
              pendingManualLogin: !ok,
              verifyReason: confirmed.reason,
              loginIssue,
            },
          };
        } finally {
          const liveDone = browserPool.get(claim.profile.id);
          if (liveDone) liveDone.loginInProgress = false;
        }
      }
    }

    // Warm-up nhẹ rồi mở form login sạch (không dùng accounts.google.com/ trần)
    if (loginProxy) {
      await verifyExitIp(activePage);
      await human.pause(300, 600);
    }
    await human.warmUp();

    await retryOperation(() => gotoCleanGoogleLogin(activePage), 3, "goto clean Google login");
    await human.pause(800, 1600);
    await restoreWebStorage(activePage, claim.profile.localStoragePath);
    await ensureNotBrokenGooglePage(activePage);

    if (await waitForLoginSuccess(activePage, 2_500, 400)) {
      mode = "existing_session";
    } else {
      const useAnother = await page.evaluateHandle(() => {
        const nodes = Array.from(document.querySelectorAll("div, span, li, button"));
        return (
          nodes.find((e) =>
            /use another account|dùng tài khoản khác/i.test(e.textContent || ""),
          ) || null
        );
      });
      const useAnotherEl = useAnother.asElement();
      if (useAnotherEl) {
        await human.clickElement(useAnotherEl as never).catch(() => undefined);
        await human.pause(400, 800);
      }

      const emailSel = 'input[type="email"], #identifierId';
      let emailBox = await page
        .waitForSelector(emailSel, { visible: true, timeout: 20_000 })
        .catch(() => null);

      if (!emailBox) {
        await gotoCleanGoogleLogin(page);
        await human.pause(600, 1200);
        emailBox = await page
          .waitForSelector(emailSel, { visible: true, timeout: 15_000 })
          .catch(() => null);
      }

      if (emailBox) {
        try {
          console.log(`[worker] Typing Google email into form: ${googleEmail}`);
          await human.typeText(emailSel, googleEmail);
          await human.pause(400, 900);
          const nextBtn = await page.$("#identifierNext");
          if (nextBtn) await human.clickElement(nextBtn);
          else await page.keyboard.press("Enter");
          await human.pause(1200, 2200);
          mode = "email_filled";
          const emailIssue = await detectLoginIssue(page).catch(() => null);
          if (emailIssue === "EMAIL_NOT_FOUND") {
            await reportLoginIssue(claim.profile.id, emailIssue);
          }
        } catch (e) {
          console.warn("[worker] LOGIN auto-fill email skipped:", e);
        }
      }

      if (await pageBlockedAsInsecure(page)) {
        mode = "manual_browser_blocked";
        console.log(
          `[worker] #${idx} Google chặn: "browser/app may not be secure". ` +
            "Hãy đăng nhập TAY trên cửa sổ này. Hoặc dùng WORKER_CDP_URL nối Chrome mở sẵn.",
        );
      } else {
        // Chờ ô MK hoặc reCAPTCHA (captcha thường chặn trước bước mật khẩu)
        const passDeadline = Date.now() + 12_000;
        let passBox: Awaited<ReturnType<typeof page.$>> = null;
        let captchaBeforePassword = false;
        while (Date.now() < passDeadline) {
          const earlyIssue = await detectLoginIssue(page).catch(() => null);
          if (earlyIssue === "RECAPTCHA" || hasRecaptchaManualChallenge(page)) {
            captchaBeforePassword = true;
            await reportLoginIssue(claim.profile.id, "RECAPTCHA");
            await page.bringToFront().catch(() => undefined);
            console.log(
              `[worker] #${idx} reCAPTCHA trước bước MK — giải tay trên Chrome, sau đó worker tự nhập MK.`,
            );
            break;
          }
          if (earlyIssue === "EMAIL_NOT_FOUND") {
            await reportLoginIssue(claim.profile.id, earlyIssue);
            break;
          }
          passBox = await page.$(GOOGLE_PASS_SEL).catch(() => null);
          if (passBox) {
            const visible = await page
              .evaluate((sel) => {
                const input = document.querySelector(sel) as HTMLInputElement | null;
                if (!input || input.getAttribute("aria-hidden") === "true") return false;
                const r = input.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
              }, GOOGLE_PASS_SEL)
              .catch(() => false);
            if (visible) break;
            passBox = null;
          }
          await new Promise((r) => setTimeout(r, 400));
        }

        if (passBox) {
          try {
            console.log("[worker] Typing Google password into form (not proxy password)");
            await human.typeText('input[name="Passwd"], input[type="password"]', googlePassword);
            await human.pause(400, 900);
            const pwNext = await page.$("#passwordNext");
            if (pwNext) await human.clickElement(pwNext);
            else await page.keyboard.press("Enter");
            await page
              .waitForNavigation({ waitUntil: "networkidle2", timeout: 25_000 })
              .catch(() => undefined);
            mode = "password_filled";
            const pwIssue = await detectLoginIssue(page).catch(() => null);
            if (pwIssue === "WRONG_PASSWORD" || pwIssue === "RECAPTCHA") {
              await reportLoginIssue(claim.profile.id, pwIssue);
            }
            if (pwIssue === "RECAPTCHA" || hasRecaptchaManualChallenge(page)) {
              await page.bringToFront().catch(() => undefined);
              console.log(
                `[worker] #${idx} ⏸ DỪNG — cần giải reCAPTCHA TAY trên Chrome trước khi tiếp tục.`,
              );
            }
          } catch (e) {
            console.warn("[worker] LOGIN auto-fill password skipped:", e);
            mode = "manual_password";
          }
        } else if (captchaBeforePassword) {
          mode = "awaiting_captcha_then_password";
        } else {
          mode = "manual_challenge";
          console.log(
            `[worker] #${idx} Google không hiện ô mật khẩu — sẽ tự nhập MK nếu ô hiện sau challenge.`,
          );
        }
      }
    }

    if (!(await isLoggedIn(page))) {
      console.log(
        `[worker] #${idx} chờ login (tối đa ${Math.round(manualWaitMs / 1000)}s) — ` +
          `gặp reCAPTCHA sẽ DỪNG chờ giải tay; sau captcha tự nhập MK` +
          `${totpSecret ? "; có 2FA → tự lấy mã từ 2fa.live" : ""}` +
          `; tự bấm Continue as / Để sau khi có.`,
      );
    }
    await waitForLoginSuccess(
      page,
      manualWaitMs,
      700,
      human,
      claim.profile.id,
      googlePassword,
      abortCtx
        ? {
            profileId: claim.profile.id,
            leaseToken: abortCtx.leaseToken,
            jobRunId: abortCtx.jobRunId,
          }
        : undefined,
      totpSecret,
    );
    // Chỉ READY khi myaccount hiện đúng email (không chấp nhận tab Error 400)
    const confirmed = await verifyGoogleSession(page, googleEmail, human);
    const ok = confirmed.ok;
    let loginIssue: string | null = null;
    if (ok) {
      mode = "login_confirmed";
      await reportLoginIssue(claim.profile.id, null);
      // Luôn mở trang hồ sơ + dismiss "Continue as …" (không để kẹt example.com)
      await ensureOnGoogleAccountProfile(page, human, {
        forceGoto: true,
        chromePid: browser?.process()?.pid,
      }).catch(() => undefined);
    } else {
      loginIssue = await detectLoginIssue(page).catch(() => null);
      if (!loginIssue && confirmed.reason) {
        loginIssue =
          confirmed.reason === "signin_or_challenge"
            ? "CHALLENGE"
            : confirmed.reason === "google_400"
              ? "BROWSER_BLOCKED"
              : "CHALLENGE";
      }
      if (loginIssue) {
        await reportLoginIssue(claim.profile.id, loginIssue);
        console.log(`[worker] #${idx} loginIssue=${loginIssue}`);
      }
      console.log(
        `[worker] #${idx} login chưa xác nhận (${confirmed.reason}) — giữ Chrome trên form, không loop goto`,
      );
      // Chỉ về form login nếu đang kẹt trang lỗi — tránh nhảy account↔login liên tục
      const cur = page.url();
      if (isBrokenGoogleUrl(cur) || (await pageLooksLikeGoogle400(page))) {
        await gotoCleanGoogleLogin(page).catch(() => undefined);
      }
    }

    await saveCookies(page, cookieFile);
    await saveWebStorage(page, claim.profile.localStoragePath);
    const cookies = await page.cookies();
    const browserVersion = await browser.version();

    if (ok) {
      const live = browserPool.get(claim.profile.id);
      if (live) live.markedReady = true;
      await api("/internal/browsers/event", {
        profileId: claim.profile.id,
        workerId: WORKER_ID,
        event: "ready",
        browserVersion,
      }).catch(() => undefined);
    }

    return {
      browserVersion,
      keepAlive: KEEP_BROWSER_ALIVE,
      markReady: ok,
      loginIssue,
      result: {
        ok,
        loggedIn: ok,
        mode,
        email: claim.account.email,
        browserIndex: idx,
        browserAlive: KEEP_BROWSER_ALIVE,
        url: page.url(),
        cookieCount: cookies.length,
        proxy: proxyLabel,
        proxyAuth: Boolean(claim.proxy?.username),
        pendingManualLogin: !ok,
        verifyReason: confirmed.reason,
        loginIssue,
      },
    };
  } catch (err) {
    if (!KEEP_BROWSER_ALIVE) {
      await browserPool.release(claim.profile.id, true);
    }
    throw err;
  } finally {
    if (prev === undefined) delete process.env.WORKER_HEADLESS;
    else process.env.WORKER_HEADLESS = prev;
    if (!KEEP_BROWSER_ALIVE) {
      await browserPool.release(claim.profile.id, true);
    }
  }
}

/** Check browser: IP public qua proxy + UA + version. */
async function runBrowserCheck(claim: ClaimPayload) {
  const live = browserPool.get(claim.profile.id);
  const wantProxy = Boolean(TASK_USE_PROXY && claim.proxy);
  const wantProxyId = wantProxy && claim.proxy ? claim.proxy.id : "none";
  const reuse =
    Boolean(live?.browser.connected) &&
    Boolean(live?.proxyEnabled) === wantProxy &&
    (live?.proxyId || "none") === wantProxyId;
  const ensured = reuse
    ? { browser: live!.browser, reused: true as const }
    : await connectOrLaunchBrowser(claim, { useProxy: wantProxy });
  const browser = ensured.browser;
  const page =
    reuse && live?.page && !live.page.isClosed()
      ? live.page
      : await setupPage(browser, claim, { useProxy: wantProxy });

  if (!reuse) {
    await browserPool.register({
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      browser,
      page,
      proxyId: claim.proxy?.id ?? "none",
      cookiePath: claim.profile.cookiePath,
      browserProfilePath: claim.profile.browserProfilePath,
      openedAt: new Date(),
      pid: browser.process()?.pid,
      accountEmail: claim.account.email,
      proxyEnabled: wantProxy,
    });
  }

  await enforceMaxTabs(browser, page);
  const browserVersion = await browser.version();
  const userAgent = await page.evaluate(() => navigator.userAgent);

  await page.goto("https://api.ipify.org?format=json", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  let exitIp: string | null = null;
  try {
    exitIp = (JSON.parse(bodyText) as { ip?: string }).ip || null;
  } catch {
    exitIp = bodyText.trim().slice(0, 64) || null;
  }

  const proxyLabel = claim.proxy
    ? `${claim.proxy.host}:${claim.proxy.port}`
    : "OFF";

  await page.goto(
    `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
        <h1>Browser check OK</h1>
        <p><b>Index:</b> #${claim.profile.browserIndex}</p>
        <p><b>Exit IP:</b> ${exitIp || "n/a"}</p>
        <p><b>Proxy:</b> ${proxyLabel}</p>
        <p><b>Reused live browser:</b> ${reuse || ensured.reused}</p>
        <p><b>Browser:</b> ${browserVersion}</p>
        <p style="word-break:break-all"><b>UA:</b> ${userAgent}</p>
      </body></html>`)}`,
    { waitUntil: "domcontentloaded" },
  );

  return {
    browserVersion,
    result: {
      ok: true,
      exitIp,
      browserIndex: claim.profile.browserIndex,
      reusedBrowser: reuse || ensured.reused,
      proxy: proxyLabel,
      country: null,
      userAgent,
      browserVersion,
      browserAlive: true,
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Đăng đánh giá Google Maps từ payload job. */
async function runMapsReviewJob(claim: ClaimPayload, job: ProfileTaskJob) {
  const raw = job.payload ?? claim.job?.payload;
  const payload = mapsReviewPayloadSchema.parse(raw ?? {});

  if (!claim.proxy) {
    throw new Error("MAPS_REVIEW requires a locked proxy (job.proxyId)");
  }

  // LOGIN Chrome thường không proxy → MAPS bắt buộc proxy → phải launch Chrome mới với --proxy-server
  // Chrome đóng (browserAlive=false / không trong pool): luôn tự launch — không cần mở tay trên Admin.
  const wantProxy = true;
  const live = browserPool.get(claim.profile.id);
  const reuse =
    Boolean(live?.browser.connected) &&
    Boolean(live?.proxyEnabled) === wantProxy &&
    live?.proxyId === claim.proxy.id;
  if (!live?.browser.connected) {
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} ${claim.account.email} Chrome đang đóng — tự mở lại với proxy để đăng bình luận`,
    );
  } else if (live.browser.connected && !reuse) {
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} Chrome cũ proxy=${live.proxyEnabled ? live.proxyId : "OFF"} ≠ job proxy=${claim.proxy.id.slice(0, 8)}… — đóng rồi mở Chrome mới CÓ proxy`,
    );
  }
  const ensured = reuse
    ? { browser: live!.browser, reused: true as const, mode: "pool" as const, pid: live?.pid }
    : await connectOrLaunchBrowser(claim, { useProxy: wantProxy });
  const browser = ensured.browser;
  const profilePath = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
  let chromePid =
    (ensured.pid && ensured.pid > 0 ? ensured.pid : undefined) ||
    live?.pid ||
    (await resolveChromePidByProfileDir(profilePath).catch(() => undefined));

  await bindProxyAuthToBrowser(browser, claim.proxy);

  const page =
    reuse && live?.page && !live.page.isClosed()
      ? live.page
      : await setupPage(browser, claim, { useProxy: wantProxy });

  // BẮT BUỘC: xác nhận exit IP qua proxy trước khi mở Maps (tránh spam IP máy)
  const gate = await assertProxyBeforeMaps(page, claim.proxy);
  console.log(
    `[worker] MAPS_REVIEW browser đã gắn proxy=${gate.proxyLabel} (verified exitIp=${gate.exitIp}) mode=${ensured.mode} reused=${ensured.reused}`,
  );

  if (!chromePid) {
    chromePid = await resolveChromePidByProfileDir(profilePath).catch(() => undefined);
  }

  let mapsWindowRaised = false;
  let lastOsFocusAt = 0;
  const resolveMapsChromePid = async () =>
    chromePid ||
    browserPool.get(claim.profile.id)?.pid ||
    browser.process()?.pid ||
    (await resolveChromePidByProfileDir(profilePath).catch(() => undefined));

  /** Tab + cửa sổ OS. launch=1 lần; window=SwitchToThisWindow; tab=chỉ bringToFront. */
  const keepFocus = async (focusOpts?: { os?: "launch" | "window" | "tab" }) => {
    if (!page.isClosed()) await page.bringToFront().catch(() => undefined);
    const mode = focusOpts?.os ?? "tab";
    if (mode === "tab") return;

    const pid = await resolveMapsChromePid();
    if (mode === "launch") {
      if (!mapsWindowRaised) {
        await activateBrowserOnScreen(browser, page, {
          preferredPid: pid,
          profilePath,
          maximize: true,
        });
        mapsWindowRaised = true;
        lastOsFocusAt = Date.now();
      } else {
        await focusChromeWindowWindows(pid, { force: true }).catch(() => false);
      }
      return;
    }

    // window — giữ foreground trong lúc đăng (SwitchToThisWindow, không maximize lại)
    const now = Date.now();
    if (now - lastOsFocusAt < 1200) return;
    lastOsFocusAt = now;
    await focusChromeWindowWindows(pid, { noMaximize: true, force: true }).catch(() => false);
  };

  await keepFocus({ os: "launch" });

  if (!reuse) {
    await browserPool.register({
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      browser,
      page,
      proxyId: claim.proxy.id,
      cookiePath: claim.profile.cookiePath,
      browserProfilePath: claim.profile.browserProfilePath,
      openedAt: new Date(),
      pid: chromePid || browser.process()?.pid,
      accountEmail: claim.account.email,
      markedReady: true,
      proxyEnabled: wantProxy,
      mapsReviewInProgress: true,
      proxyAuth:
        claim.proxy.username && claim.proxy.password
          ? { username: claim.proxy.username, password: claim.proxy.password }
          : null,
    });
  } else {
    const liveSession = browserPool.get(claim.profile.id);
    if (liveSession) {
      liveSession.mapsReviewInProgress = true;
      if (chromePid) liveSession.pid = chromePid;
      if (claim.proxy.username && claim.proxy.password) {
        liveSession.proxyAuth = {
          username: claim.proxy.username,
          password: claim.proxy.password,
        };
      }
      await bindProxyAuthToBrowser(browser, claim.proxy);
    }
  }

  await enforceMaxTabs(browser, page);
  const browserVersion = await browser.version();
  console.log(
    `[worker] MAPS_REVIEW #${claim.profile.browserIndex} ${claim.account.email} rating=${payload.rating} proxy=${gate.proxyLabel} exitIp=${gate.exitIp} directIp=${gate.directIp || "n/a"} auth=${proxyAuthDebug(claim.proxy)} mode=${ensured.mode} reused=${ensured.reused} pid=${chromePid || "?"}`,
  );

  // Không cần pulse focus: Chrome đã có flag chống throttle nền
  // (--disable-background-timer-throttling…) nên chạy ổn cả khi không focus.
  const out = await postMapsReview(page, payload, {
    proxy: claim.proxy,
    keepFocus,
  });
  if (!out.ok) {
    throw new Error(
      "Đã bấm Đăng nhưng không bắt được xác nhận (màn cảm ơn / form đóng) — kiểm tra trên Chrome",
    );
  }
  if (out.alreadyReviewed) {
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} đã có review trước đó — đánh dấu hoàn thành`,
    );
  }
  return {
    browserVersion,
    keepAlive: true,
    result: {
      ok: out.ok,
      alreadyReviewed: out.alreadyReviewed ?? false,
      reviewLink: out.reviewLink,
      pointsText: out.pointsText,
      placeUrl: out.placeUrl,
      rating: payload.rating,
      assignmentId: payload.assignmentId ?? null,
      proxy: gate.proxyLabel,
      proxyId: claim.proxy.id,
      exitIp: gate.exitIp,
      directIp: gate.directIp,
      proxyVerified: true,
      browserMode: ensured.mode,
      reusedBrowser: ensured.reused,
      browserIndex: claim.profile.browserIndex,
      email: claim.account.email,
      browserAlive: true,
    },
  };
}

/** Timeout cứng theo task — 1 job treo (CDP đơ, dialog nền…) không được chặn cả hàng đợi. */
const TASK_TIMEOUT_MS: Record<string, number> = {
  MAPS_REVIEW: Math.max(180_000, Number(process.env.MAPS_REVIEW_TIMEOUT_MS || 15 * 60_000)),
  HEALTHCHECK: 4 * 60_000,
  BROWSER_CHECK: 4 * 60_000,
  LOGIN: 45 * 60_000,
};

function runWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label} treo quá ${Math.round(ms / 60_000)} phút — tự hủy job để không chặn hàng đợi`,
            ),
          ),
        ms,
      );
    }),
  ]);
}

async function processJob(job: ProfileTaskJob) {
  const claim = await api<ClaimPayload>("/internal/jobs/claim", {
    profileId: job.profileId,
    leaseToken: job.leaseToken,
    jobRunId: job.jobRunId,
    workerId: WORKER_ID,
  });

  const markLoginBusy = (on: boolean) => {
    if (on) busyProfileIds.add(job.profileId);
    else busyProfileIds.delete(job.profileId);
    const live = browserPool.get(job.profileId);
    if (live) live.loginInProgress = on;
  };
  const markMapsBusy = (on: boolean) => {
    if (on) busyProfileIds.add(job.profileId);
    else busyProfileIds.delete(job.profileId);
    const live = browserPool.get(job.profileId);
    if (live) live.mapsReviewInProgress = on;
  };

  try {
    if (job.taskCode === "LOGIN") markLoginBusy(true);
    if (job.taskCode === "MAPS_REVIEW") markMapsBusy(true);
    const taskTimeoutMs = TASK_TIMEOUT_MS[job.taskCode] ?? 10 * 60_000;
    const taskPromise: Promise<unknown> =
      job.taskCode === "LOGIN"
        ? runGoogleLogin(claim, {
            leaseToken: job.leaseToken,
            jobRunId: job.jobRunId,
          })
        : job.taskCode === "BROWSER_CHECK"
          ? runBrowserCheck(claim)
          : job.taskCode === "MAPS_REVIEW"
            ? runMapsReviewJob(claim, job)
            : runHealthcheck(claim);
    const out = await runWithTimeout(
      taskPromise,
      taskTimeoutMs,
      `${job.taskCode} #${claim.profile.browserIndex}`,
    );

    const loginOut = out as {
      keepAlive?: boolean;
      markReady?: boolean;
      loginIssue?: string | null;
      browserVersion: string;
      result: Record<string, unknown>;
    };

    // Chỉ alive khi pool CDP còn nối — không tin lock file (user tắt tay vẫn còn lock)
    const stillAlive = Boolean(browserPool.get(job.profileId)?.browser.connected);
    await api("/internal/jobs/complete", {
      profileId: job.profileId,
      leaseToken: job.leaseToken,
      jobRunId: job.jobRunId,
      browserVersion: loginOut.browserVersion,
      result: loginOut.result,
      browserAlive: stillAlive,
      workerId: WORKER_ID,
      markReady: job.taskCode === "LOGIN" && Boolean(loginOut.markReady),
      loginIssue:
        job.taskCode === "LOGIN"
          ? loginOut.markReady
            ? null
            : (loginOut.loginIssue ??
              (typeof loginOut.result.loginIssue === "string"
                ? loginOut.result.loginIssue
                : null))
          : undefined,
    });
    console.log(
      `[worker] completed ${job.jobRunId} task=${job.taskCode} profile=${job.profileId} index=#${claim.profile.browserIndex}`,
      loginOut.result,
    );
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
    if (code === "ABORTED") {
      console.log(`[worker] job aborted by admin ${job.jobRunId} profile=${job.profileId}`);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    const stacktrace = err instanceof Error ? err.stack : undefined;
    // MAPS_REVIEW lỗi/timeout: CHỈ ngắt CDP (tháo pool), KHÔNG kill Chrome.
    // Kill Chrome ở đây chính là nguyên nhân "vừa vào Maps thì browser tắt" —
    // user đang nhìn cửa sổ Maps thì timeout/fail → cửa sổ biến mất.
    // Chrome còn mở → lần sau có thể reconnect (cùng proxy) hoặc kill có chủ đích
    // khi bắt buộc đổi proxy lúc launch.
    let alive = Boolean(browserPool.get(job.profileId)?.browser.connected);
    if (job.taskCode === "MAPS_REVIEW") {
      const wasConnected = alive;
      await browserPool
        .release(job.profileId, true, { kill: false })
        .catch(() => undefined);
      // Process Chrome thường vẫn sống sau disconnect CDP
      alive = wasConnected;
      try {
        const dir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
        const pid = await resolveChromePidByProfileDir(dir).catch(() => undefined);
        if (pid) alive = true;
      } catch {
        /* ignore */
      }
      console.warn(
        `[worker] MAPS_REVIEW fail — giữ Chrome mở (alive=${alive}): ${error.slice(0, 160)}`,
      );
    }
    await api("/internal/jobs/fail", {
      profileId: job.profileId,
      leaseToken: job.leaseToken,
      jobRunId: job.jobRunId,
      error,
      stacktrace,
      disableProfile: false,
      browserAlive: alive,
      workerId: WORKER_ID,
    }).catch((e) =>
      console.warn(
        `[worker] báo fail thất bại (job có thể đã bị reset): ${e instanceof Error ? e.message : e}`,
      ),
    );
    throw err;
  } finally {
    if (job.taskCode === "LOGIN") markLoginBusy(false);
    if (job.taskCode === "MAPS_REVIEW") markMapsBusy(false);
  }
}

type ReclaimProfile = {
  id: string;
  browserIndex: number;
  browserProfilePath: string;
  cookiePath: string;
  proxyId: string | null;
  account: { email: string };
};

async function focusLiveBrowser(profileId: string) {
  let live = browserPool.get(profileId);

  // Đang LOGIN/MAPS: không CDP reconnect (cướp session → Chrome tắt). Chỉ focus OS nếu có pool.
  const busy = busyProfileIds.has(profileId) || Boolean(live?.loginInProgress);

  // Mất pool nhưng Chrome còn mở → chỉ reconnect DevTools (KHÔNG kill / relaunch)
  if (!live?.browser.connected && !busy) {
    try {
      const { profiles } = await api<{ profiles: ReclaimProfile[] }>(
        "/internal/browsers/list-for-reclaim",
        {},
      );
      const row = profiles.find((p) => p.id === profileId);
      if (row) {
        const userDataDir = path.resolve(STORAGE_DIR, row.browserProfilePath);
        const port = await readDevToolsPort(userDataDir);
        if (port && (await isDevToolsReachable(port))) {
          const browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${port}`,
            defaultViewport: null,
          });
          const pages = await browser.pages();
          const page0 = pages.find((p) => !p.isClosed()) || (await browser.newPage());
          const pid = await resolveChromePidByProfileDir(userDataDir);
          await browserPool.register({
            profileId: row.id,
            browserIndex: row.browserIndex,
            browser,
            page: page0,
            proxyId: row.proxyId ?? "none",
            cookiePath: row.cookiePath,
            browserProfilePath: row.browserProfilePath,
            openedAt: new Date(),
            pid: browser.process()?.pid || pid,
            accountEmail: row.account.email,
            proxyEnabled: false,
          });
          console.log(
            `[worker] focus reconnect #${row.browserIndex} via DevTools :${port}`,
          );
          live = browserPool.get(profileId);
        }
      }
    } catch (e) {
      console.warn("[worker] focus reconnect failed", e);
    }
  }

  if (!live?.browser.connected) {
    if (busy) {
      // Job đang giữ Chrome — chỉ cố focus theo PID, không báo closed
      const rowPath = live?.browserProfilePath;
      const userDataDir = rowPath
        ? path.resolve(STORAGE_DIR, rowPath)
        : undefined;
      const pid =
        live?.pid ||
        (userDataDir ? await resolveChromePidByProfileDir(userDataDir) : undefined);
      if (pid && process.platform === "win32") {
        await focusChromeWindowWindows(pid).catch(() => undefined);
        console.log(
          `[worker] focus OS (busy job) profile=${profileId} pid=${pid}`,
        );
        return;
      }
      throw new Error("Browser đang mở login — chờ vài giây rồi bấm Hiện lại");
    }
    await api("/internal/browsers/event", {
      profileId,
      workerId: WORKER_ID,
      event: "closed",
    }).catch(() => undefined);
    throw new Error("Browser không còn mở — bấm Mở để mở lại");
  }

  const page = live.page.isClosed()
    ? (await live.browser.pages())[0]
    : live.page;
  if (!page || page.isClosed()) {
    throw new Error("Không có page để focus");
  }
  live.page = page;

  // Chỉ đưa cửa sổ lên — không goto / không kill
  await activateBrowserOnScreen(live.browser, page, {
    preferredPid: live.pid || live.browser.process()?.pid,
    profilePath: live.browserProfilePath
      ? path.resolve(STORAGE_DIR, live.browserProfilePath)
      : undefined,
  });

  if (!live.pid) {
    live.pid = live.browser.process()?.pid;
  }

  console.log(
    `[worker] focused browser #${live.browserIndex} profile=${profileId} pid=${live.pid ?? "?"}`,
  );
  return { ok: true, browserIndex: live.browserIndex };
}

/** Tìm PID Chrome theo user-data-dir khi puppeteer.connect() không có process().pid */
async function resolveChromePidByProfileDir(userDataDir?: string): Promise<number | undefined> {
  if (!userDataDir || process.platform !== "win32") return undefined;
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const needle = userDataDir.replace(/'/g, "''");
  const ps = `
$needle = '${needle}'
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  Sort-Object WorkingSetSize -Descending |
  Select-Object -First 1 -ExpandProperty ProcessId
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8_000, windowsHide: true, encoding: "utf8" },
    );
    const pid = Number(String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Đưa cửa sổ Chrome đúng PID lên foreground (Windows) — script .ps1 riêng, ổn định hơn inline. */
async function focusChromeWindowWindows(
  pid?: number,
  opts?: { noMaximize?: boolean; noAlt?: boolean; force?: boolean },
) {
  if (!pid || !(Number(pid) > 0)) {
    console.warn("[worker] focus OS skipped — missing Chrome PID");
    return false;
  }
  if (!existsSync(FOCUS_CHROME_PS1)) {
    console.warn(`[worker] focus OS skipped — missing script ${FOCUS_CHROME_PS1}`);
    return false;
  }
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    FOCUS_CHROME_PS1,
    "-RootPid",
    String(Number(pid)),
  ];
  if (opts?.noMaximize) args.push("-NoMaximize");
  if (opts?.noAlt) args.push("-NoAlt");
  if (opts?.force) args.push("-Force");

  const result = await execFileAsync("powershell.exe", args, {
    timeout: 20_000,
    windowsHide: true,
    encoding: "utf8",
  }).catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(" ").slice(0, 240);
    console.warn(`[worker] focus OS failed pid=${pid}: ${detail}`);
    return null;
  });
  if (!result) return false;
  const out = String(result.stdout || "").trim();
  if (out) console.log(`[worker] focus OS: ${out.split(/\r?\n/).pop()}`);
  return /ok=True|already-foreground|focused pid-tree=/i.test(out);
}

/** Đưa Chrome lên màn hình ngay (tab + cửa sổ OS). */
async function activateBrowserOnScreen(
  browser: Browser,
  page?: Awaited<ReturnType<Browser["newPage"]>> | null,
  opts?: { preferredPid?: number; profilePath?: string; maximize?: boolean },
) {
  const target =
    page && !page.isClosed()
      ? page
      : (await browser.pages()).find((p) => !p.isClosed()) || null;
  if (target) {
    await target.bringToFront().catch(() => undefined);
    const wantMaximize = opts?.maximize !== false && !maximizedBrowsers.has(browser);
    try {
      const client = await target.createCDPSession();
      const { windowId } = (await client.send("Browser.getWindowForTarget")) as {
        windowId: number;
      };
      const { bounds } = (await client.send("Browser.getWindowBounds", {
        windowId,
      })) as { bounds: { windowState?: string } };
      if (bounds.windowState === "minimized") {
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
      if (
        wantMaximize &&
        bounds.windowState !== "maximized" &&
        bounds.windowState !== "fullscreen"
      ) {
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "maximized" },
        });
        maximizedBrowsers.add(browser);
      }
      await client.detach().catch(() => undefined);
    } catch {
      /* CDP optional */
    }
  }
  if (process.platform === "win32") {
    let pid =
      (opts?.preferredPid && opts.preferredPid > 0 ? opts.preferredPid : undefined) ||
      browser.process()?.pid;
    if (!pid) {
      pid = await resolveChromePidByProfileDir(opts?.profilePath);
    }
    await focusChromeWindowWindows(pid, { force: true }).catch(() => false);
  }
}

/** CDP port còn lắng nghe thật không (tránh lock file cũ → alive giả). */
async function isDevToolsReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Xóa lock/DevTools stale sau khi user tắt Chrome tay. */
async function clearStaleProfileLocks(userDataDir: string) {
  const { unlink } = await import("fs/promises");
  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonCookie", "lockfile"]) {
    const f = path.join(userDataDir, name);
    if (existsSync(f)) {
      await unlink(f).catch(() => undefined);
    }
  }
}

/**
 * Chỉ báo alive khi CDP/pool thật sự nối được, hoặc Chrome process còn sống.
 * Tắt Chrome tay → port chết + không process → không còn trong list → UI off.
 * QUAN TRỌNG:
 * - Không clear lock khi process Chrome còn sống.
 * - Không puppeteer.connect trong heartbeat nếu Chrome đã chạy (cướp CDP → LOGIN disconnect → cửa sổ tắt).
 */
async function collectAliveProfileIds(): Promise<string[]> {
  // Gỡ session pool đã disconnect — nhưng giữ báo cáo alive nếu Chrome process còn / đang LOGIN
  for (const row of browserPool.list()) {
    const live = browserPool.get(row.profileId);
    if (live && !live.browser.connected) {
      if (busyProfileIds.has(row.profileId) || live.loginInProgress) {
        continue;
      }
      const userDataDir = live.browserProfilePath
        ? path.resolve(STORAGE_DIR, live.browserProfilePath)
        : null;
      const pid = userDataDir
        ? await resolveChromePidByProfileDir(userDataDir)
        : null;
      if (pid) {
        // Process còn — chỉ gỡ map CDP chết, không soft-connect ở đây
        await browserPool.release(row.profileId, false);
        continue;
      }
      await browserPool.release(row.profileId, false);
    }
  }

  const ids = new Set(
    browserPool
      .list()
      .filter((s) => s.connected)
      .map((s) => s.profileId),
  );

  // Đang LOGIN/MAPS → luôn coi là alive (tránh UI off giữa chừng)
  for (const id of busyProfileIds) ids.add(id);

  if (softReclaimBusy) return [...ids];
  softReclaimBusy = true;
  try {
    const { profiles } = await api<{ profiles: ReclaimProfile[] }>(
      "/internal/browsers/list-for-reclaim",
      {},
    );
    for (const row of profiles) {
      if (ids.has(row.id)) {
        const live = browserPool.get(row.id);
        if (live?.browser.connected && !busyProfileIds.has(row.id) && !live.loginInProgress) {
          await enforceMaxTabs(live.browser, live.page).catch(() => undefined);
        }
        continue;
      }

      // Đang job — tuyệt đối không CDP connect
      if (busyProfileIds.has(row.id) || browserPool.get(row.id)?.loginInProgress) {
        ids.add(row.id);
        continue;
      }

      const userDataDir = path.resolve(STORAGE_DIR, row.browserProfilePath);
      if (!existsSync(userDataDir)) continue;

      const port = await readDevToolsPort(userDataDir);
      const pid = await resolveChromePidByProfileDir(userDataDir);

      // Chrome process còn sống → báo alive, KHÔNG soft-connect (tránh cướp session LOGIN)
      if (pid) {
        ids.add(row.id);
        continue;
      }

      if (!port) {
        if (profileDirInUse(userDataDir)) {
          await clearStaleProfileLocks(userDataDir);
        }
        continue;
      }

      let reachable = await isDevToolsReachable(port);
      if (!reachable) {
        await new Promise((r) => setTimeout(r, 600));
        reachable = await isDevToolsReachable(port);
      }
      if (!reachable) {
        await clearStaleProfileLocks(userDataDir);
        console.log(
          `[worker] #${row.browserIndex} Chrome đã tắt (CDP :${port} chết, không còn process) → off`,
        );
        continue;
      }

      // Port còn nhưng không tìm thấy process (hiếm) — chỉ connect khi không busy
      try {
        const browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null,
        });
        attachTabLimiter(browser);
        const pages = (await browser.pages()).filter((p) => !p.isClosed());
        const page0 = pages[0] || (await browser.newPage());
        await enforceMaxTabs(browser, page0);
        const connectPid =
          browser.process()?.pid ||
          (await resolveChromePidByProfileDir(userDataDir));
        await browserPool.register({
          profileId: row.id,
          browserIndex: row.browserIndex,
          browser,
          page: page0,
          proxyId: row.proxyId ?? "none",
          cookiePath: row.cookiePath,
          browserProfilePath: row.browserProfilePath,
          openedAt: new Date(),
          pid: connectPid,
          accountEmail: row.account.email,
          proxyEnabled: false,
        });
        ids.add(row.id);
        await api("/internal/browsers/event", {
          profileId: row.id,
          workerId: WORKER_ID,
          event: "opened",
          browserVersion: await browser.version().catch(() => "unknown"),
        }).catch(() => undefined);
        console.log(
          `[worker] soft-reclaim #${row.browserIndex} via CDP :${port} (${row.account.email}) → alive`,
        );
      } catch {
        await clearStaleProfileLocks(userDataDir);
      }
    }
  } catch {
    /* ignore list/reclaim errors */
  } finally {
    softReclaimBusy = false;
  }

  return [...ids];
}

async function heartbeat(runningJobs: number, queueLength = 0) {
  const mem = process.memoryUsage();
  const aliveProfileIds = await collectAliveProfileIds();
  await api("/internal/workers/heartbeat", {
    id: WORKER_ID,
    hostname: hostname(),
    concurrency: CONCURRENCY,
    runningJobs,
    memPercent: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    queueLength,
    status: "ONLINE",
    aliveProfileIds,
  }).catch(() => undefined);
}

/** Đọc port CDP Chrome đã ghi vào user-data-dir. */
async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  try {
    const raw = await readFile(file, "utf8");
    const port = Number(String(raw).split(/\r?\n/)[0]?.trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function profileDirInUse(userDataDir: string) {
  return (
    existsSync(path.join(userDataDir, "SingletonLock")) ||
    existsSync(path.join(userDataDir, "lockfile")) ||
    existsSync(path.join(userDataDir, "DevToolsActivePort"))
  );
}

/** Kill Chrome đang giữ user-data-dir (orphan sau worker crash). */
async function killChromeUsingProfileDir(userDataDir: string) {
  const abs = path.resolve(userDataDir);
  if (process.platform === "win32") {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    // Match cả / và \ trong CommandLine
    const needleA = abs.replace(/'/g, "''");
    const needleB = abs.replace(/\\/g, "/").replace(/'/g, "''");
    const leaf = path.basename(abs).replace(/'/g, "''");
    const ps = `
$needles = @('${needleA}', '${needleB}', '${leaf}')
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return }
  foreach ($n in $needles) {
    if ($cl.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
      break
    }
  }
}
Start-Sleep -Milliseconds 1200
# Xóa lock nếu process đã chết
$lock = Join-Path '${needleA}' 'SingletonLock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
`;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 20_000, windowsHide: true },
    ).catch(() => undefined);
    return;
  }
  // Linux/mac: best-effort pkill by path
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("pkill", ["-f", userDataDir], { timeout: 8_000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));
}

async function dismissRestorePages(page: Awaited<ReturnType<Browser["newPage"]>>) {
  // CHỈ Esc — tuyệt đối không bấm Close (dễ nhầm nút đóng cả cửa sổ Chrome)
  await page.keyboard.press("Escape").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 120));
  await page.keyboard.press("Escape").catch(() => undefined);
  if (process.platform !== "win32") return;
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  // Chỉ Esc vào dialog "Restore pages?" — không Invoke Close/X
  const ps = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
$found = $false
foreach ($w in $windows) {
  try {
    $title = [string]$w.Current.Name
    if ($title -match '(?i)restore pages|didn.?t shut down|khôi phục trang|không tắt đúng') {
      $found = $true
      try { $w.SetFocus() } catch {}
      break
    }
  } catch {}
}
if ($found) {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Write-Output 'dismissed-restore-esc'
}
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { timeout: 4_000, windowsHide: true },
  ).catch(() => undefined);
}

/**
 * Nối lại Chrome orphan còn mở (sau worker restart) → giữ alive/READY đúng thực tế.
 * Không có CDP: kill+relaunch cùng user-data-dir (cookie/session giữ nguyên).
 */
async function reclaimOrphanBrowsers() {
  const { profiles } = await api<{ profiles: ReclaimProfile[] }>(
    "/internal/browsers/list-for-reclaim",
    {},
  );
  const kept: string[] = [];
  let relaunchBudget = RECLAIM_RELAUNCH_MAX;

  for (const row of profiles) {
    const userDataDir = path.resolve(STORAGE_DIR, row.browserProfilePath);
    if (!existsSync(userDataDir) || !profileDirInUse(userDataDir)) continue;

    let browser: Browser | null = null;
    let mode = "connect";

    const port = await readDevToolsPort(userDataDir);
    if (port) {
      try {
        browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null,
        });
        console.log(
          `[worker] reclaim #${row.browserIndex} via CDP :${port} (${row.account.email})`,
        );
      } catch (e) {
        console.warn(`[worker] reclaim CDP #${row.browserIndex} failed:`, e);
        browser = null;
      }
    }

    if (!browser) {
      if (relaunchBudget <= 0) {
        console.log(
          `[worker] skip relaunch #${row.browserIndex} (${row.account.email}) — chỉ 1 hồ sơ/lần, bấm Mở khi cần`,
        );
        continue;
      }
      relaunchBudget -= 1;
      mode = "relaunch";
      console.log(
        `[worker] reclaim #${row.browserIndex} orphan không CDP — kill+relaunch (${row.account.email}) [budget còn ${relaunchBudget}]`,
      );
      await killChromeUsingProfileDir(userDataDir);
      await markChromeCleanExit(userDataDir);
      try {
        // Dùng cùng launch detached như LOGIN (không puppeteer.launch — tránh kill theo worker)
        const fakeClaim = {
          profile: {
            id: row.id,
            browserIndex: row.browserIndex,
            browserAlive: true,
            browserProfilePath: row.browserProfilePath,
            cookiePath: row.cookiePath,
            localStoragePath: null,
            userAgent: null,
            viewport: null,
            currentTask: null,
          },
          account: { id: "", email: row.account.email, password: "" },
          proxy: null,
        } as ClaimPayload;
        const launched = await launchBrowser(fakeClaim, { useProxy: false });
        browser = launched.browser;
      } catch (e) {
        console.warn(`[worker] reclaim relaunch #${row.browserIndex} failed:`, e);
        continue;
      }
    }

    const pages = await browser.pages();
    let page = pages.find((p) => !p.isClosed()) || (await browser.newPage());
    await applyStealth(page).catch(() => undefined);
    await dismissRestorePages(page).catch(() => undefined);
    await ensureNotBrokenGooglePage(page).catch(() => undefined);

    attachTabLimiter(browser);
    await enforceMaxTabs(browser, page);
    const reclaimPid =
      browser.process()?.pid ||
      (await resolveChromePidByProfileDir(userDataDir).catch(() => undefined));
    await browserPool.register({
      profileId: row.id,
      browserIndex: row.browserIndex,
      browser,
      page,
      proxyId: row.proxyId ?? "none",
      cookiePath: row.cookiePath,
      browserProfilePath: row.browserProfilePath,
      openedAt: new Date(),
      pid: reclaimPid,
      accountEmail: row.account.email,
      proxyEnabled: false,
    });

    const browserVersion = await browser.version().catch(() => "unknown");
    // Chỉ READY khi myaccount hiện đúng email — không READY giả từ cookie/NTP
    const confirmed = await verifyGoogleSession(page, row.account.email).catch(() => ({
      ok: false as const,
      reason: "verify_failed" as const,
    }));
    const loggedIn = confirmed.ok;
    const live = browserPool.get(row.id);
    if (live) {
      live.markedReady = loggedIn;
      live.accountEmail = row.account.email;
    }
    if (!loggedIn) {
      await gotoCleanGoogleLogin(page).catch(() => undefined);
    } else {
      await page.bringToFront().catch(() => undefined);
    }

    await api("/internal/browsers/event", {
      profileId: row.id,
      workerId: WORKER_ID,
      event: loggedIn ? "ready" : "opened",
      browserVersion,
    }).catch(() => undefined);

    kept.push(row.id);
    console.log(
      `[worker] reclaimed #${row.browserIndex} mode=${mode} loggedIn=${loggedIn} reason=${"reason" in confirmed ? confirmed.reason : "ok"} → ${loggedIn ? "READY" : "UNREADY+alive"}`,
    );
  }

  return kept;
}

async function main() {
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });

  let running = 0;

  browserPool.setDisconnectHandler(async (session) => {
    // CDP đứt nhưng Chrome process còn (worker reconnect / disconnect chủ động) → không báo off
    const userDataDir = session.browserProfilePath
      ? path.resolve(STORAGE_DIR, session.browserProfilePath)
      : null;
    const pid = userDataDir
      ? await resolveChromePidByProfileDir(userDataDir).catch(() => undefined)
      : undefined;
    if (pid) {
      console.log(
        `[worker] CDP disconnected index=#${session.browserIndex} nhưng Chrome pid=${pid} còn — giữ alive`,
      );
      return;
    }
    console.log(
      `[worker] browser disconnected index=#${session.browserIndex} → off`,
    );
    await api("/internal/browsers/event", {
      profileId: session.profileId,
      workerId: WORKER_ID,
      event: "closed",
    }).catch((e) => console.warn("[worker] closed event failed", e));
  });

  // 1) Nối lại Chrome còn mở → 2) chỉ clear alive giả (không đụng hồ sơ vừa reclaim)
  let keptIds: string[] = [];
  try {
    keptIds = await reclaimOrphanBrowsers();
  } catch (e) {
    console.warn("[worker] reclaim failed", e);
  }

  await api("/internal/browsers/reset-alive", {
    workerId: WORKER_ID,
    all: true,
    keepProfileIds: keptIds,
  }).catch((e) => console.warn("[worker] reset-alive failed", e));

  await heartbeat(0);

  const worker = new Worker<ProfileTaskJob>(
    QUEUE_PROFILE_TASKS,
    async (job) => {
      running += 1;
      try {
        await processJob(job.data);
      } finally {
        running -= 1;
      }
    },
    { connection, concurrency: CONCURRENCY },
  );

  const controlWorker = new Worker<BrowserControlJob>(
    QUEUE_BROWSER_CONTROL,
    async (job) => {
      if (job.data.type === "focus") {
        await focusLiveBrowser(job.data.profileId);
      }
    },
    { connection, concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job failed ${job?.id}`, err.message);
  });
  controlWorker.on("failed", (job, err) => {
    console.error(`[worker] focus failed ${job?.id}`, err.message);
  });

  setInterval(() => {
    heartbeat(running).catch(() => undefined);
  }, 10_000);

  // Poll: KHÔNG bringToFront account khác (tránh nhảy cửa sổ khi đang mở LOGIN).
  setInterval(() => {
    const anyLoginBusy = browserPool.list().some((r) => {
      const s = browserPool.get(r.profileId);
      return Boolean(s?.loginInProgress);
    });
    for (const row of browserPool.list()) {
      const live = browserPool.get(row.profileId);
      if (!live?.browser.connected) continue;
      void (async () => {
        try {
          if (live.loginInProgress) return;
          // Đang MAPS_REVIEW — không auto-dismiss / navigate (tránh bấm Close trên Maps)
          if (live.mapsReviewInProgress) return;

          await ensureLiveProxyAuth(live);

          // Đã READY: sửa trang lệch im lặng — không cướp focus khi account khác đang LOGIN
          if (live.markedReady) {
            if (anyLoginBusy) return;
            const u = live.page.url().toLowerCase();
            if (
              !u.includes("myaccount.google.com") &&
              !u.includes("mail.google.com") &&
              !isSignInPage(u)
            ) {
              await ensureOnGoogleAccountProfile(live.page, undefined, {
                quiet: true,
                chromePid: live.pid,
              }).catch(() => undefined);
            } else {
              await clickChromeNativeContinueAs(live.pid).catch(() => null);
            }
            return;
          }

          if (!live.accountEmail) return;

          const url = live.page.url();
          // Job LOGIN không còn chạy — không đụng form captcha / không ghi lại loginIssue
          // (tránh banner “Chờ xác minh tay” hiện lại sau khi admin bấm Dừng job)
          if (isSignInPage(url) || isPendingGoogleInterstitial(url)) {
            return;
          }
          if (isBrokenGoogleUrl(url) || (await pageLooksLikeGoogle400(live.page))) {
            // Chỉ dọn URL lỗi khi đang LOGIN; ngoài ra để yên cửa sổ
            return;
          }
          await dismissGooglePrompts(live.page, undefined, live.browser).catch(() => undefined);

          // Chỉ READY khi đã ở myaccount/mail VÀ thấy đúng email (không navigate)
          if (!looksLoggedIn(url)) return;
          if (!(await pageMentionsEmail(live.page, live.accountEmail))) return;

          live.markedReady = true;
          await ensureOnGoogleAccountProfile(live.page, undefined, {
            forceGoto: true,
            quiet: anyLoginBusy,
            chromePid: live.pid,
          }).catch(() => undefined);
          await saveCookies(live.page, path.resolve(STORAGE_DIR, live.cookiePath));
          const browserVersion = await live.browser.version();
          await api("/internal/browsers/event", {
            profileId: live.profileId,
            workerId: WORKER_ID,
            event: "ready",
            browserVersion,
          });
          console.log(`[worker] late-ready index=#${live.browserIndex} email=${live.accountEmail}`);
        } catch {
          /* ignore */
        }
      })();
    }
  }, 3_000);

  console.log(
    `[worker] ${WORKER_ID} listening queue=${QUEUE_PROFILE_TASKS}+${QUEUE_BROWSER_CONTROL} concurrency=${CONCURRENCY} keepBrowserAlive=${KEEP_BROWSER_ALIVE}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
