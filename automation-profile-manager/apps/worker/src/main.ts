import { hostname, tmpdir } from "os";
import { existsSync } from "fs";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";
import { config as loadEnv } from "dotenv";
import net from "net";
import { spawn } from "child_process";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import puppeteer, { Browser } from "puppeteer";
import {
  QUEUE_PROFILE_TASKS,
  QUEUE_BROWSER_CONTROL,
  ProfileTaskJob,
  BrowserControlJob,
  mapsReviewPayloadSchema,
  mapsDeleteReviewPayloadSchema,
  accountProfileUpdatePayloadSchema,
  scanGoogleProfilePayloadSchema,
} from "@apm/shared";
import { browserPool } from "./browser-pool";
import { HumanCursor } from "./humanize";
import { applyStealth } from "./stealth";
import { postMapsReview, assertGoogleSessionForMaps } from "./maps-review";
import { deleteMapsReview } from "./maps-delete-review";
import { updateGoogleProfile, scanGoogleProfile } from "./google-profile-update.js";
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
import {
  installChromeCloseGuardsOnBrowser,
  setMapsChromeGuard,
  startChromeWindowWatchdog,
  stopChromeWindowWatchdog,
  ensureChromeWindowVisible,
  logChromeCloseIntent,
  isMapsChromeGuardOn,
} from "./chrome-debug-guard.js";
import {
  invalidateChromeProfileCache,
  listAllChromeMainPidsByUserDataDir,
  pruneIdleProfileChrome,
  resolveBestChromePidForProfileDir,
  sanitizeProfileChrome,
} from "./chrome-profile-sanitize.js";

// Load apps/worker/.env trước khi đọc token (tránh lệch INTERNAL_API_TOKEN với API)
loadEnv({ path: path.resolve(__dirname, "../.env") });

const FOCUS_CHROME_PS1 = path.resolve(__dirname, "../scripts/focus-chrome-window.ps1");

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

/** Serialize Start-Process — nhiều job cùng lúc dễ fail PowerShell/timeout. */
let chromeSpawnChain: Promise<void> = Promise.resolve();

function withChromeSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chromeSpawnChain.then(fn, fn);
  chromeSpawnChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Mở Chrome độc lập khỏi PM2 trên Windows — bắt buộc --user-data-dir.
 * Win32_Process.Create: không dính job PM2; cmdline đầy đủ, không UseShellExecute.
 */
async function spawnChromeWindowsDetached(
  exe: string,
  args: string[],
  browserIndex: number,
): Promise<number | undefined> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const userDataArg = args.find((a) => /^--user-data-dir=/i.test(a));
  if (!userDataArg) {
    throw new Error(
      `Chrome #${browserIndex}: thiếu --user-data-dir — từ chối mở (tránh Chrome mặc định / chọn profile)`,
    );
  }
  const userDataDir = userDataArg.slice("--user-data-dir=".length).replace(/^"|"$/g, "");

  return withChromeSpawnLock(async () => {
    const argsFile = path.join(
      process.env.TEMP || tmpdir(),
      `binhluan-chrome-args-${browserIndex}-${Date.now()}.json`,
    );
    await writeFile(argsFile, JSON.stringify({ exe, args, userDataDir }), "utf8");
    const filePs = argsFile.replace(/'/g, "''");

    const tryWmiCreate = async (): Promise<number | undefined> => {
      // Escape Win32 cmdline: quote arg nếu có space hoặc "
      // KHÔNG escape backslash (lỗi cũ: [ \\t"] khiến mọi path Windows bị double-\\)
      const ps = `
$ErrorActionPreference = 'Stop'
$j = Get-Content -LiteralPath '${filePs}' -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = [string]$j.exe
$chromeArgs = @($j.args)
$userDataDir = [string]$j.userDataDir
if (-not ($chromeArgs | Where-Object { $_ -match '^--user-data-dir=' })) {
  throw 'Missing --user-data-dir in args'
}
function Escape-WinArg([string]$a) {
  if ($null -eq $a) { return '""' }
  if ($a -notmatch '[ "]') { return $a }
  return '"' + ($a -replace '"','""') + '"'
}
$cmd = (Escape-WinArg $exe) + ' ' + (($chromeArgs | ForEach-Object { Escape-WinArg ([string]$_) }) -join ' ')
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($null -eq $r -or $r.ReturnValue -ne 0) {
  throw ("Win32_Process.Create failed ReturnValue=" + $(if ($r) { $r.ReturnValue } else { 'null' }))
}
$procId = [int]$r.ProcessId
Start-Sleep -Milliseconds 800
# Xác minh process (hoặc con) thật sự dùng user-data-dir automation — không phải Chrome hệ thống
$needle = $userDataDir.ToLowerInvariant()
$ok = $false
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cl = [string]$_.CommandLine
  if (-not $cl) { return }
  if ($cl.ToLowerInvariant().Contains($needle)) { $script:ok = $true }
}
if (-not $ok) {
  try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
  throw ('Chrome opened WITHOUT automation user-data-dir (refused system profile picker). cmd=' + $cmd.Substring(0, [Math]::Min(240, $cmd.Length)))
}
Write-Output $procId
`;
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 45_000, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      );
      const pid = Number(
        String(stdout || "")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop(),
      );
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(
          `Win32_Process.Create không trả PID (stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)})`,
        );
      }
      return pid;
    };

    const errors: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pid = await tryWmiCreate();
        await unlink(argsFile).catch(() => undefined);
        return pid;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stderr =
          e && typeof e === "object" && "stderr" in e
            ? String((e as { stderr?: string }).stderr || "")
            : "";
        errors.push(
          `attempt${attempt}: ${msg}${stderr ? ` | stderr=${stderr.slice(0, 400)}` : ""}`,
        );
        console.warn(
          `[worker] spawn Chrome #${browserIndex} fail ${attempt}/3: ${msg.slice(0, 240)}`,
        );
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }

    await unlink(argsFile).catch(() => undefined);
    throw new Error(
      `Start-Process Chrome failed #${browserIndex}: ${errors.join(" || ")}`,
    );
  });
}

function chromeLaunchArgs(withProxy: boolean, proxy: ClaimPayload["proxy"], debugPort?: number) {
  const args: string[] = [
    "--start-maximized",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    // Profile trong user-data-dir automation (tránh màn "Who's using Chrome?")
    "--profile-directory=Default",
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

const PROFILE_CHROME_WAIT_MS = Math.max(
  30_000,
  Number(process.env.PROFILE_CHROME_WAIT_MS || 120_000),
);

/** Job MAPS trước còn dọn Chrome (restore sau đăng) — job kế phải chờ, không fail ngay. */
async function waitForPriorMapsChromeCleanup(
  profileId: string,
  label: string,
  timeoutMs = PROFILE_CHROME_WAIT_MS,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const live = browserPool.get(profileId);
    if (live?.mapsReviewInProgress && live.browser.connected) {
      console.log(
        `[worker] ${label} chờ job trước dọn Chrome (mapsReviewInProgress)…`,
      );
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const userDataDir = live?.browserProfilePath
      ? path.resolve(STORAGE_DIR, live.browserProfilePath)
      : null;
    if (userDataDir && live?.browser.connected) {
      const port = await readDevToolsPort(userDataDir);
      if (port && !(await isDevToolsReachable(port))) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    }
    return;
  }
  console.warn(
    `[worker] ${label} hết thời gian chờ Chrome job trước (${Math.round(timeoutMs / 1000)}s) — thử tiếp`,
  );
}

/** Reconnect DevTools có retry — tránh fail ngay khi Chrome vừa đóng/mở lại sau MAPS. */
async function reconnectDevToolsForMaps(
  userDataDir: string,
  claim: ClaimPayload,
  maxWaitMs = 60_000,
): Promise<{ browser: Browser; pid?: number; usingJobProxy: boolean } | null> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const port = await readDevToolsPort(userDataDir);
    if (port) {
      try {
        const remain = maxWaitMs - (Date.now() - started);
        await waitForDevToolsPort(port, Math.min(12_000, Math.max(2000, remain)));
        const existingProxy = await readChromeProxyFromProfileDir(userDataDir);
        const usingJobProxy = Boolean(
          claim.proxy &&
            existingProxy &&
            existingProxy.host === claim.proxy.host &&
            existingProxy.port === claim.proxy.port,
        );
        const browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null,
        });
        if (usingJobProxy) {
          await bindProxyAuthToBrowser(browser, claim.proxy!);
        }
        const pid = await resolveChromePidByProfileDir(userDataDir).catch(
          () => undefined,
        );
        return { browser, pid, usingJobProxy };
      } catch (e) {
        console.warn(
          `[worker] MAPS #${claim.profile.browserIndex} DevTools retry: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/**
 * Chrome còn process/lock nhưng DevTools chết (thường sau restore lỗi) — dọn để launch sạch.
 * Chỉ khi profile không còn job MAPS/LOGIN đang giữ pool.
 */
async function recoverStuckChromeForMaps(
  claim: ClaimPayload,
  profilePath: string,
): Promise<boolean> {
  const idx = claim.profile.browserIndex;
  const live = browserPool.get(claim.profile.id);
  if (live?.mapsReviewInProgress && live.browser.connected) {
    return false;
  }
  if (live?.loginInProgress && live.browser.connected) {
    return false;
  }
  if (live?.browser.connected) {
    const port = await readDevToolsPort(profilePath);
    if (port && (await isDevToolsReachable(port))) return false;
  }
  const pid = await resolveChromePidByProfileDir(profilePath).catch(
    () => undefined,
  );
  if (!pid && !profileDirInUse(profilePath)) return false;

  const cleaned = await sanitizeProfileChrome({
    userDataDir: profilePath,
    profileId: claim.profile.id,
    browserIndex: idx,
    reason: "maps-recover",
    isBusy: () => isProfileChromeBusy(claim.profile.id),
    deps: chromeSanitizeDeps(),
  });
  if (
    cleaned.action === "skipped-busy" ||
    cleaned.action === "none" ||
    cleaned.action === "ok"
  ) {
    return false;
  }

  console.warn(
    `[worker] MAPS #${idx} Chrome kẹt (pid=${pid ?? "?"}) — đã dọn (${cleaned.action}) để mở lại`,
  );
  setMapsChromeGuard(false);
  if (live) live.mapsReviewInProgress = false;
  await browserPool
    .release(claim.profile.id, true, { forceClose: true })
    .catch(() => undefined);
  return true;
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
 *
 * QUAN TRỌNG: nếu Chrome đã chạy cùng user-data-dir thì KHÔNG spawn thêm —
 * spawn trùng profile trên Windows hay làm cửa sổ cũ biến mất (= "bị kill").
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
  if (alivePid) {
    // Đã có process → bắt buộc reconnect, tuyệt đối không spawn đè
    const port = await readDevToolsPort(userDataDir);
    if (port && (await isDevToolsReachable(port))) {
      console.log(
        `[worker] launch #${claim.profile.browserIndex} bỏ spawn — Chrome pid=${alivePid} còn, reconnect :${port}`,
      );
      const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        defaultViewport: null,
      });
      const withProxy = Boolean(opts?.useProxy && claim.proxy);
      if (withProxy && claim.proxy) {
        await bindProxyAuthToBrowser(browser, claim.proxy);
      }
      return { browser, pid: alivePid };
    }
    // DevTools chết nhưng process còn — dọn zombie rồi spawn mới
    console.warn(
      `[worker] launch #${claim.profile.browserIndex} Chrome pid=${alivePid} DevTools chết — dọn zombie rồi spawn mới`,
    );
    await sanitizeProfileChrome({
      userDataDir,
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      reason: "launch-zombie",
      isBusy: () => false,
      deps: chromeSanitizeDeps(),
    });
    await new Promise((r) => setTimeout(r, 400));
  }
  await markChromeCleanExit(userDataDir);

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

  // Windows: KHÔNG spawn chrome.exe trực tiếp từ worker (PM2 treekill).
  // Start-Process / cmd start = process độc lập. Serialize + retry vì máy nhiều Chrome dễ fail.
  let spawnPid: number | undefined;
  if (process.platform === "win32") {
    spawnPid = await spawnChromeWindowsDetached(
      exe,
      args,
      claim.profile.browserIndex,
    );
  } else {
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    spawnPid = child.pid;
  }
  console.log(
    `[worker] Chrome spawned independent #${claim.profile.browserIndex} pid=${spawnPid ?? "?"} debug=:${port}`,
  );

  try {
    await waitForDevToolsPort(port);
  } catch (e) {
    // Chỉ tắt process vừa spawn thất bại — KHÔNG kill Chrome cũ cùng profile
    if (spawnPid) {
      try {
        process.kill(spawnPid);
      } catch {
        /* ignore */
      }
    }
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
 * Lấy Chrome cho profile: pool → CDP reconnect (Chrome còn mở) → launch.
 * Mặc định KHÔNG BAO GIỜ kill Chrome đang mở (LOGIN/MAPS/HEALTHCHECK alike).
 * Chỉ launch mới khi profile dir chưa bị chiếm / không reconnect được.
 */
async function connectOrLaunchBrowser(
  claim: ClaimPayload,
  opts?: { useProxy?: boolean; neverKill?: boolean },
): Promise<{ browser: Browser; reused: boolean; mode: string; pid?: number }> {
  const wantProxy = opts?.useProxy ?? TASK_USE_PROXY;
  // Mặc định giữ cửa sổ — chỉ kill khi ALLOW_CHROME_KILL=1 và neverKill không set
  const allowKill =
    process.env.ALLOW_CHROME_KILL === "1" && opts?.neverKill !== true;
  const neverKill = !allowKill;
  const live = browserPool.get(claim.profile.id);
  if (live?.browser.connected) {
    const pathMismatch =
      live.browserProfilePath &&
      live.browserProfilePath !== claim.profile.browserProfilePath;
    const emailMismatch =
      live.accountEmail &&
      live.accountEmail.toLowerCase() !== claim.account.email.toLowerCase();
    const wantProxyId = wantProxy && claim.proxy ? claim.proxy.id : "none";
    const liveProxyId = live.proxyEnabled ? live.proxyId || "none" : "none";
    const proxyMismatch =
      Boolean(live.proxyEnabled) !== wantProxy ||
      (wantProxy && liveProxyId !== wantProxyId);
    if (pathMismatch || emailMismatch || proxyMismatch) {
      if (neverKill) {
        console.warn(
          `[worker] #${claim.profile.browserIndex} pool lệch proxy/path — REUSE (never-kill)`,
        );
        return { browser: live.browser, reused: true, mode: "pool-forced", pid: live.pid };
      }
      const proxyLabel =
        wantProxy && claim.proxy
          ? `${claim.proxy.host}:${claim.proxy.port}`
          : "OFF";
      console.log(
        `[worker] #${claim.profile.browserIndex} pool stale — đóng Chrome cũ rồi launch mới (proxy=${proxyLabel})`,
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

  const preSanitize = await sanitizeProfileChromeForClaim(claim, "pre-connect");
  if (preSanitize.readyToLaunch) {
    console.log(
      `[worker] #${claim.profile.browserIndex} pre-sanitize → launch Chrome mới (${preSanitize.action})`,
    );
    const launched = await launchBrowser(claim, { useProxy: wantProxy });
    return {
      browser: launched.browser,
      reused: false,
      mode: "launch-after-sanitize",
      pid: launched.pid,
    };
  }

  // Ưu tiên process thật — lock file có thể stale / thiếu trong khi Chrome còn
  const existingPid = await resolveChromePidByProfileDir(userDataDir).catch(
    () => undefined,
  );
  if (existingPid || profileDirInUse(userDataDir)) {
    const wantLabel =
      wantProxy && claim.proxy
        ? `${claim.proxy.host}:${claim.proxy.port}`
        : null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const port = await readDevToolsPort(userDataDir);
      if (!port || !(await isDevToolsReachable(port))) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      try {
        const existingProxy = await readChromeProxyFromProfileDir(userDataDir);
        const have = existingProxy
          ? `${existingProxy.host}:${existingProxy.port}`
          : null;
        // never-kill: reconnect dù lệch proxy (không tắt cửa sổ)
        if (!neverKill) {
          if (wantProxy && wantLabel && have !== wantLabel) {
            console.log(
              `[worker] #${claim.profile.browserIndex} Chrome proxy=${have ?? "OFF"} ≠ job ${wantLabel} — sẽ kill`,
            );
            break;
          }
          if (!wantProxy && existingProxy) {
            console.log(
              `[worker] #${claim.profile.browserIndex} Chrome có proxy nhưng LOGIN cần IP máy — sẽ kill`,
            );
            break;
          }
        } else if (wantProxy && wantLabel && have !== wantLabel) {
          console.warn(
            `[worker] #${claim.profile.browserIndex} proxy Chrome=${have ?? "OFF"} ≠ job ${wantLabel} — reconnect giữ cửa sổ (never-kill)`,
          );
        }

        const browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null,
        });
        if (wantProxy && claim.proxy && have === wantLabel) {
          await bindProxyAuthToBrowser(browser, claim.proxy);
        }
        const pid =
          existingPid ??
          (await resolveChromePidByProfileDir(userDataDir));
        console.log(
          `[worker] reconnect #${claim.profile.browserIndex} via DevTools :${port} proxy=${have ?? "OFF"} (${claim.account.email}) — KHÔNG kill`,
        );
        return { browser, reused: true, mode: "devtools", pid };
      } catch (e) {
        console.warn(
          `[worker] DevTools reconnect #${claim.profile.browserIndex} attempt ${attempt + 1} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Chrome còn process / lock mà CDP chết → auto-sanitize rồi launch (không bắt user đóng tay)
    const retrySanitize = await sanitizeProfileChromeForClaim(
      claim,
      "devtools-dead",
    );
    if (retrySanitize.readyToLaunch) {
      console.log(
        `[worker] #${claim.profile.browserIndex} sau sanitize DevTools chết → launch Chrome mới`,
      );
      const launched = await launchBrowser(claim, { useProxy: wantProxy });
      return {
        browser: launched.browser,
        reused: false,
        mode: "sanitize-relaunch",
        pid: launched.pid,
      };
    }
    if (retrySanitize.devtoolsPort) {
      try {
        const browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${retrySanitize.devtoolsPort}`,
          defaultViewport: null,
        });
        const pid = await resolveChromePidByProfileDir(userDataDir);
        console.log(
          `[worker] reconnect #${claim.profile.browserIndex} sau sanitize :${retrySanitize.devtoolsPort}`,
        );
        return {
          browser,
          reused: true,
          mode: "devtools-after-sanitize",
          pid,
        };
      } catch {
        /* fall through */
      }
    }
    if (neverKill || existingPid) {
      throw new Error(
        `#${claim.profile.browserIndex}: Chrome đang mở (pid=${existingPid ?? "?"}) nhưng không reconnect được DevTools sau sanitize — thử đóng Chrome thừa rồi bấm Mở browser / Đăng lại.`,
      );
    }
    console.log(
      `[worker] #${claim.profile.browserIndex} profile dir locked — kill orphan rồi launch (proxy=${wantProxy ? wantLabel ?? "ON" : "OFF"}) [ALLOW_CHROME_KILL=1]`,
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
            `[worker] launch conflict → reconnect #${claim.profile.browserIndex} :${port}`,
          );
          return { browser, reused: true, mode: "devtools-conflict", pid };
        } catch {
          /* fall through */
        }
      }
      if (neverKill) {
        throw new Error(
          `#${claim.profile.browserIndex}: launch conflict — KHÔNG kill Chrome đang mở`,
        );
      }
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

/** Đóng tab thừa — giữ keepPage + các tab cũ (Maps), đóng tab mới vượt hạn. */
async function enforceMaxTabs(
  browser: Browser,
  keepPage?: Awaited<ReturnType<Browser["newPage"]>> | null,
) {
  // Đang MAPS: tuyệt đối không đóng tab — Maps hay spawn target tạm, đóng nhầm = "kill browser"
  for (const s of browserPool.allSessions()) {
    if (s.browser === browser && s.mapsReviewInProgress) return;
  }
  if (isMapsChromeGuardOn()) return;
  const open = (await browser.pages()).filter((p) => !p.isClosed());
  if (open.length <= MAX_TABS_PER_BROWSER) return;

  const keep = new Set<Awaited<ReturnType<Browser["newPage"]>>>();
  if (keepPage && !keepPage.isClosed()) keep.add(keepPage);
  // Ưu tiên giữ tab Maps / Google đã mở sẵn (cũ → mới), không ưu tiên popup mới
  for (const p of open) {
    if (keep.size >= MAX_TABS_PER_BROWSER) break;
    const url = p.url() || "";
    if (/google\.(com|com\.\w+)\/maps|myaccount\.google|accounts\.google/i.test(url)) {
      keep.add(p);
    }
  }
  for (const p of open) {
    if (keep.size >= MAX_TABS_PER_BROWSER) break;
    keep.add(p);
  }
  // Không bao giờ đóng hết — tab cuối = cửa sổ ẩn
  const closable = open.filter((p) => !keep.has(p));
  if (closable.length >= open.length) return;
  for (const p of closable) {
    if (keep.has(p)) continue;
    const url = p.url() || "";
    // Không bao giờ đóng tab Maps đang xem
    if (/google\.(com|com\.\w+)\/maps/i.test(url)) continue;
    // Giữ ít nhất 1 tab
    const still = (await browser.pages()).filter((x) => !x.isClosed());
    if (still.length <= 1) {
      console.warn(`[worker] bỏ qua đóng tab — chỉ còn 1 tab`);
      break;
    }
    console.log(`[worker] đóng tab thừa: ${url.slice(0, 80)}`);
    logChromeCloseIntent("page.close", `enforceMaxTabs ${url.slice(0, 80)}`);
    await p.close().catch(() => undefined);
  }
}

/** Gắn listener: tab mới vượt quá giới hạn → đóng tab MỚI (không đụng tab Maps cũ). */
function attachTabLimiter(browser: Browser) {
  installChromeCloseGuardsOnBrowser(browser);
  if (tabLimiterAttached.has(browser)) return;
  tabLimiterAttached.add(browser);
  browser.on("targetcreated", (target) => {
    if (target.type() !== "page") return;
    void (async () => {
      try {
        for (const s of browserPool.allSessions()) {
          if (s.browser === browser && s.mapsReviewInProgress) return;
        }
        if (isMapsChromeGuardOn()) return;
        const open = (await browser.pages()).filter((p) => !p.isClosed());
        if (open.length <= MAX_TABS_PER_BROWSER) return;
        // Đóng đúng tab vừa tạo — KHÔNG đóng tab Maps đang chạy
        const page = await target.page();
        if (!page || page.isClosed()) return;
        const url = page.url() || "";
        if (/google\.(com|com\.\w+)\/maps/i.test(url)) return;
        if (open.length <= 1) return;
        console.log(
          `[worker] tab-limiter đóng tab mới (over ${MAX_TABS_PER_BROWSER}): ${url.slice(0, 80)}`,
        );
        logChromeCloseIntent("page.close", `tab-limiter ${url.slice(0, 80)}`);
        await page.close().catch(() => undefined);
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
async function runMapsReviewJob(
  claim: ClaimPayload,
  job: ProfileTaskJob,
  opts?: { signal?: AbortSignal },
) {
  const raw = job.payload ?? claim.job?.payload;
  const payload = mapsReviewPayloadSchema.parse(raw ?? {});
  const signal = opts?.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("MAPS_REVIEW aborted (timeout/cancel)");
      (err as { code?: string }).code = "ABORTED";
      throw err;
    }
  };

  if (!claim.proxy) {
    throw new Error("MAPS_REVIEW requires a locked proxy (job.proxyId)");
  }
  let jobProxy: NonNullable<ClaimPayload["proxy"]> = claim.proxy;

  /**
   * Luồng chuẩn MAPS_REVIEW:
   * 1) Mở / nối Chrome (IP máy)
   * 2) Kiểm tra đăng nhập Google (IP máy — myaccount không đi proxy)
   * 3) Kiểm tra proxy (exit IP) + mở Chrome với proxy job
   * 4) Vào Maps qua proxy → đăng bình luận → lưu reviewLink
   * 5) Thoát proxy → mở lại Chrome bình thường (IP máy + myaccount)
   */
  const profilePath = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
  // Bật guard NGAY — trước khi connect/setupPage (tránh đóng tab / ẩn cửa sổ)
  setMapsChromeGuard(true);
  const mapSanitize = await sanitizeProfileChromeForClaim(
    claim,
    "maps-start",
  ).catch(() => null);
  if (
    mapSanitize &&
    (mapSanitize.readyToLaunch ||
      mapSanitize.action === "killed-zombie" ||
      mapSanitize.action === "killed-all")
  ) {
    const stalePool = browserPool.get(claim.profile.id);
    if (stalePool?.browser.connected) {
      await browserPool
        .release(claim.profile.id, true, { forceClose: true })
        .catch(() => undefined);
    }
  }
  const live = browserPool.get(claim.profile.id);
  const existingPid = await resolveChromePidByProfileDir(profilePath).catch(
    () => undefined,
  );
  let browser: Browser;
  let page: Awaited<ReturnType<Browser["newPage"]>>;
  let chromePid: number | undefined;
  let reused = false;
  let mode = "launch";
  let usingJobProxy = true;

  // ── 1) Mở / nối tab Chrome ──────────────────────────────────────────
  if (live?.browser.connected) {
    browser = live.browser;
    page =
      live.page && !live.page.isClosed()
        ? live.page
        : await setupPage(browser, claim, { useProxy: Boolean(live.proxyEnabled) });
    chromePid = live.pid;
    reused = true;
    mode = "pool";
    usingJobProxy = Boolean(live.proxyEnabled) && live.proxyId === jobProxy.id;
    if (!usingJobProxy) {
      const cli = await readChromeProxyFromProfileDir(profilePath);
      usingJobProxy = Boolean(
        cli && cli.host === jobProxy.host && cli.port === jobProxy.port,
      );
    }
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước1 tab=pool proxyMatch=${usingJobProxy}`,
    );
  } else if (existingPid || profileDirInUse(profilePath)) {
    await waitForPriorMapsChromeCleanup(
      claim.profile.id,
      `MAPS_REVIEW #${claim.profile.browserIndex}`,
    );
    const reconnected = await reconnectDevToolsForMaps(profilePath, claim);
    if (reconnected) {
      browser = reconnected.browser;
      usingJobProxy = reconnected.usingJobProxy;
      page = await setupPage(browser, claim, { useProxy: usingJobProxy });
      chromePid =
        reconnected.pid ??
        (await resolveChromePidByProfileDir(profilePath).catch(() => undefined));
      reused = true;
      mode = "devtools";
      console.log(
        `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước1 tab=devtools-retry proxyMatch=${usingJobProxy}`,
      );
    } else {
      await recoverStuckChromeForMaps(claim, profilePath);
      console.log(
        `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước1 Chrome cũ không nối được — launch/reconnect qua connectOrLaunchBrowser`,
      );
      const ensured = await connectOrLaunchBrowser(claim, {
        useProxy: false,
        neverKill: true,
      });
      browser = ensured.browser;
      chromePid = ensured.pid;
      mode = ensured.mode;
      page = await setupPage(browser, claim, { useProxy: false });
      usingJobProxy = false;
      reused = ensured.reused;
    }
  } else {
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước1 Chrome đóng — mở mới IP máy (session trước, proxy sau)`,
    );
    const ensured = await connectOrLaunchBrowser(claim, {
      useProxy: false,
      neverKill: true,
    });
    browser = ensured.browser;
    chromePid = ensured.pid;
    mode = ensured.mode;
    page = await setupPage(browser, claim, { useProxy: false });
    usingJobProxy = false;
    reused = false;
  }

  throwIfAborted();

  /** Đóng Chrome hiện tại → mở lại (cookie giữ trong profile). */
  const relaunchMapsChrome = async (useProxy: boolean, reason: string) => {
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} ${reason} — relaunch proxy=${useProxy ? "ON" : "OFF"}`,
    );
    logChromeCloseIntent(
      "forceClose",
      `MAPS chrome-switch #${claim.profile.browserIndex} proxy=${useProxy ? "ON" : "OFF"}`,
    );
    setMapsChromeGuard(false);
    {
      const pooled = browserPool.get(claim.profile.id);
      if (pooled) pooled.mapsReviewInProgress = false;
    }
    await browserPool.release(claim.profile.id, true, { forceClose: true }).catch(
      () => undefined,
    );
    if (browser.connected) {
      await browser.close().catch(() => undefined);
    }
    setMapsChromeGuard(true);
    for (let i = 0; i < 40; i++) {
      const still = await resolveChromePidByProfileDir(profilePath).catch(
        () => undefined,
      );
      if (!still) break;
      if (i === 20) {
        console.warn(
          `[worker] MAPS_REVIEW #${claim.profile.browserIndex} chờ Chrome tắt (pid=${still})…`,
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const stuck = await resolveChromePidByProfileDir(profilePath).catch(
      () => undefined,
    );
    if (stuck) {
      console.warn(
        `[worker] MAPS_REVIEW #${claim.profile.browserIndex} force Stop-Process pid=${stuck}`,
      );
      const prev = process.env.ALLOW_CHROME_KILL;
      process.env.ALLOW_CHROME_KILL = "1";
      try {
        await killChromeUsingProfileDir(profilePath);
      } finally {
        if (prev === undefined) delete process.env.ALLOW_CHROME_KILL;
        else process.env.ALLOW_CHROME_KILL = prev;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const ensured = await connectOrLaunchBrowser(claim, {
      useProxy,
      neverKill: true,
    });
    browser = ensured.browser;
    chromePid = ensured.pid;
    mode = `${useProxy ? "proxy" : "direct"}-switch:${ensured.mode}`;
    reused = false;
    usingJobProxy = useProxy;
    if (useProxy) {
      await bindProxyAuthToBrowser(browser, jobProxy);
      page = await setupPage(browser, claim, { useProxy: true });
    } else {
      page = await setupPage(browser, claim, { useProxy: false });
    }
  };

  // ── 2) Kiểm tra session trên IP máy — browser thường KHÔNG proxy ────────
  const cliProxy = await readChromeProxyFromProfileDir(profilePath).catch(() => null);
  if (usingJobProxy || cliProxy) {
    await relaunchMapsChrome(false, "session check cần IP máy");
  }
  throwIfAborted();
  console.log(
    `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước2 kiểm tra đăng nhập (IP máy)…`,
  );
  await assertGoogleSessionForMaps(page, claim.account.email);
  throwIfAborted();

  // ── 3) Bật proxy job + kiểm tra exit IP (retry proxy khác nếu tunnel fail) ──
  const maxProxyTries = Math.min(
    8,
    Math.max(1, Number(process.env.MAPS_PROXY_RETRIES || 4)),
  );
  let gate: Awaited<ReturnType<typeof assertProxyBeforeMaps>> | null = null;
  for (let proxyTry = 0; proxyTry < maxProxyTries; proxyTry++) {
    if (proxyTry > 0) {
      const swapped: { proxy: NonNullable<ClaimPayload["proxy"]> } = await api(
        "/internal/jobs/reswap-proxy",
        {
          profileId: claim.profile.id,
          leaseToken: job.leaseToken,
          jobRunId: job.jobRunId,
          failedProxyId: jobProxy.id,
        },
      );
      jobProxy = swapped.proxy;
      claim.proxy = swapped.proxy;
      console.log(
        `[worker] MAPS_REVIEW #${claim.profile.browserIndex} proxy retry ${proxyTry + 1}/${maxProxyTries} → ${jobProxy.host}:${jobProxy.port}`,
      );
    }
    await relaunchMapsChrome(
      true,
      proxyTry === 0 ? "Maps cần proxy job" : `proxy retry ${proxyTry + 1}`,
    );
    throwIfAborted();
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước3 kiểm tra proxy (${claim.proxy?.host}:${claim.proxy?.port})…`,
    );
    try {
      gate = await assertProxyBeforeMaps(page, jobProxy);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /ERR_TUNNEL|auth thất bại|407|warmup không trả IP|exit IP trùng/i.test(
        msg,
      );
      console.warn(
        `[worker] MAPS_REVIEW #${claim.profile.browserIndex} proxy gate fail (${proxyTry + 1}/${maxProxyTries}): ${msg.slice(0, 160)}`,
      );
      if (!retryable || proxyTry >= maxProxyTries - 1) throw e;
    }
  }
  if (!gate) throw new Error("MAPS thiếu proxy gate");
  console.log(
    `[worker] MAPS_REVIEW browser ready proxy=${gate.proxyLabel} exitIp=${gate.exitIp} mode=${mode} reused=${reused}`,
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

  const keepFocus = async (focusOpts?: { os?: "launch" | "window" | "tab" }) => {
    if (!page.isClosed()) await page.bringToFront().catch(() => undefined);
    const modeFocus = focusOpts?.os ?? "tab";
    if (modeFocus === "tab") return;

    const pid = await resolveMapsChromePid();
    if (modeFocus === "launch") {
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

    const now = Date.now();
    if (now - lastOsFocusAt < 2500) return;
    lastOsFocusAt = now;
    await focusChromeWindowWindows(pid, { noMaximize: true, force: true }).catch(() => false);
  };

  await keepFocus({ os: "launch" });
  if (chromePid) {
    await ensureChromeWindowVisible(
      chromePid,
      `maps-before-register:#${claim.profile.browserIndex}`,
    );
    startChromeWindowWatchdog(chromePid, `MAPS#${claim.profile.browserIndex}`, 1500);
  }

  // Đánh dấu MAPS sớm — chặn tab-limiter / browser.close trước khi goto Maps
  await browserPool.register({
    profileId: claim.profile.id,
    browserIndex: claim.profile.browserIndex,
    browser,
    page,
    proxyId: jobProxy.id,
    cookiePath: claim.profile.cookiePath,
    browserProfilePath: claim.profile.browserProfilePath,
    openedAt: new Date(),
    pid: chromePid || browser.process()?.pid,
    accountEmail: claim.account.email,
    markedReady: true,
    proxyEnabled: true,
    mapsReviewInProgress: true,
    proxyAuth:
      jobProxy.username && jobProxy.password
        ? { username: jobProxy.username, password: jobProxy.password }
        : null,
  });

  // Không enforceMaxTabs ở đây — Maps sẽ tạo target; limiter đã no-op khi mapsReviewInProgress
  const browserVersion = await browser.version();
  console.log(
    `[worker] MAPS_REVIEW #${claim.profile.browserIndex} ${claim.account.email} rating=${payload.rating} proxy=${gate.proxyLabel} exitIp=${gate.exitIp} directIp=${gate.directIp || "n/a"} auth=${proxyAuthDebug(jobProxy)} mode=${mode} reused=${reused} pid=${chromePid || "?"}`,
  );

  // ── 4) Vào Maps (proxy) + bình luận + lưu link ───────────────────
  console.log(`[worker] MAPS_REVIEW #${claim.profile.browserIndex} bước4 → Maps + bình luận`);
  throwIfAborted();
  try {
    const out = await postMapsReview(page, payload, {
      proxy: jobProxy,
      keepFocus,
      signal,
      accountEmail: claim.account.email,
      checkSession: false,
    });
    throwIfAborted();
    console.log(
      `[worker] MAPS_REVIEW #${claim.profile.browserIndex} → postMapsReview xong ok=${out.ok}`,
    );
    if (!out.ok) {
      throw new Error(
        "Đã bấm Đăng nhưng không bắt được xác nhận (màn cảm ơn / form đóng) — kiểm tra trên Chrome",
      );
    }

    // ── 5) Thoát proxy → Chrome bình thường (IP máy + myaccount) ─────
    let restoredProfileNoProxy = false;
    try {
      await restoreProfileBrowserAfterMaps(claim, profilePath);
      // Cập nhật pid cho finally (Chrome mới, không proxy)
      chromePid =
        browserPool.get(claim.profile.id)?.pid ||
        (await resolveChromePidByProfileDir(profilePath).catch(() => undefined));
      restoredProfileNoProxy = true;
    } catch (e) {
      console.warn(
        `[worker] MAPS #${claim.profile.browserIndex} restore hồ sơ sau đăng lỗi (review vẫn OK): ${e instanceof Error ? e.message : e}`,
      );
      // Dọn Chrome kẹt để job kế không fail DevTools — bài đã đăng vẫn COMPLETED
      await recoverStuckChromeForMaps(claim, profilePath).catch(() => false);
    }

    return {
      browserVersion,
      keepAlive: true,
      result: {
        ok: out.ok,
        alreadyReviewed: false,
        reviewLink: out.reviewLink,
        pointsText: out.pointsText,
        placeUrl: out.placeUrl,
        rating: payload.rating,
        assignmentId: payload.assignmentId ?? null,
        proxy: gate.proxyLabel,
        proxyId: jobProxy.id,
        exitIp: gate.exitIp,
        directIp: gate.directIp,
        proxyVerified: true,
        browserMode: mode,
        reusedBrowser: reused,
        browserIndex: claim.profile.browserIndex,
        email: claim.account.email,
        browserAlive: true,
        restoredProfileNoProxy,
      },
    };
  } finally {
    const pid =
      chromePid ||
      browserPool.get(claim.profile.id)?.pid ||
      (await resolveChromePidByProfileDir(profilePath).catch(() => undefined));
    if (pid) {
      await ensureChromeWindowVisible(pid, `maps-finally:#${claim.profile.browserIndex}`);
      // Giữ watchdog thêm 30s sau job (tránh bị ẩn ngay khi soft-reclaim)
      setTimeout(() => stopChromeWindowWatchdog(pid), 30_000).unref?.();
    }
  }
}

/** Sau MAPS thành công: thoát proxy, mở lại Chrome IP máy + tab myaccount. */
async function restoreProfileBrowserAfterMaps(
  claim: ClaimPayload,
  profilePath: string,
): Promise<void> {
  const idx = claim.profile.browserIndex;
  const pooled = browserPool.get(claim.profile.id);

  setMapsChromeGuard(false);
  if (pooled) pooled.mapsReviewInProgress = false;

  console.log(
    `[worker] MAPS #${idx} bước5 → thoát proxy, về browser bình thường (IP máy + myaccount)`,
  );
  logChromeCloseIntent("forceClose", `MAPS proxy-off #${idx}`);
  await browserPool.release(claim.profile.id, true, { forceClose: true }).catch(
    () => undefined,
  );

  for (let i = 0; i < 40; i++) {
    const still = await resolveChromePidByProfileDir(profilePath).catch(
      () => undefined,
    );
    if (!still) break;
    if (i === 20) {
      console.warn(`[worker] MAPS #${idx} chờ Chrome tắt (proxy-off) pid=${still}…`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const stuck = await resolveChromePidByProfileDir(profilePath).catch(
    () => undefined,
  );
  if (stuck) {
    console.warn(
      `[worker] MAPS #${idx} force Stop-Process pid=${stuck} để thoát proxy`,
    );
    const prev = process.env.ALLOW_CHROME_KILL;
    process.env.ALLOW_CHROME_KILL = "1";
    try {
      await killChromeUsingProfileDir(profilePath);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_CHROME_KILL;
      else process.env.ALLOW_CHROME_KILL = prev;
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  // Mở lại KHÔNG proxy (= LOGIN / hồ sơ thường)
  const ensured = await connectOrLaunchBrowser(claim, {
    useProxy: false,
    neverKill: true,
  });
  const browser = ensured.browser;
  const chromePid = ensured.pid;
  const page = await setupPage(browser, claim, { useProxy: false });

  await browserPool.register({
    profileId: claim.profile.id,
    browserIndex: claim.profile.browserIndex,
    browser,
    page,
    proxyId: "none",
    cookiePath: claim.profile.cookiePath,
    browserProfilePath: claim.profile.browserProfilePath,
    openedAt: new Date(),
    pid: chromePid || browser.process()?.pid,
    accountEmail: claim.account.email,
    markedReady: true,
    proxyEnabled: false,
    mapsReviewInProgress: false,
    proxyAuth: null,
  });

  if (!browser.connected) {
    throw new Error(
      `MAPS #${idx} restore xong nhưng CDP chưa nối — cần dọn Chrome`,
    );
  }

  const human = new HumanCursor(page);
  await ensureOnGoogleAccountProfile(page, human, {
    forceGoto: true,
    chromePid: chromePid || browser.process()?.pid,
  });
  await page.bringToFront().catch(() => undefined);
  if (chromePid) {
    await ensureChromeWindowVisible(chromePid, `maps-proxy-off:#${idx}`).catch(
      () => undefined,
    );
  }
  console.log(
    `[worker] MAPS #${idx} đã về hồ sơ myaccount (proxy=OFF) url=${page.url().slice(0, 80)}`,
  );
}

/** Đóng hẳn Chrome sau MAPS_DELETE_REVIEW — không giữ cửa sổ như MAPS_REVIEW. */
async function shutdownChromeAfterDelete(claim: ClaimPayload) {
  const profileId = claim.profile.id;
  const idx = claim.profile.browserIndex;
  const live = browserPool.get(profileId);
  if (live) live.mapsReviewInProgress = false;
  busyProfileIds.delete(profileId);
  setMapsChromeGuard(false);

  const dir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
  console.log(
    `[worker] MAPS_DELETE_REVIEW #${idx} dọn Chrome sau xóa (forceClose + kill)…`,
  );
  await browserPool
    .release(profileId, true, { forceClose: true })
    .catch(() => undefined);

  const prev = process.env.ALLOW_CHROME_KILL;
  process.env.ALLOW_CHROME_KILL = "1";
  try {
    await killChromeUsingProfileDir(dir);
  } finally {
    if (prev === undefined) delete process.env.ALLOW_CHROME_KILL;
    else process.env.ALLOW_CHROME_KILL = prev;
  }
}

/** Xóa đánh giá Maps đã đăng — Chrome IP máy (không proxy), đúng account. */
async function runMapsDeleteReviewJob(
  claim: ClaimPayload,
  job: ProfileTaskJob,
  opts?: { signal?: AbortSignal },
) {
  const raw = job.payload ?? claim.job?.payload;
  const payload = mapsDeleteReviewPayloadSchema.parse(raw ?? {});
  const signal = opts?.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("MAPS_DELETE_REVIEW aborted (timeout/cancel)");
      (err as { code?: string }).code = "ABORTED";
      throw err;
    }
  };

  const live = browserPool.get(claim.profile.id);
  const reuse =
    Boolean(live?.browser.connected) && live?.proxyEnabled === false;
  const ensured = reuse
    ? { browser: live!.browser, reused: true as const, pid: live!.pid }
    : await connectOrLaunchBrowser(claim, { useProxy: false, neverKill: true });
  const browser = ensured.browser;
  const page =
    reuse && live?.page && !live.page.isClosed()
      ? live.page
      : await setupPage(browser, claim, { useProxy: false });

  if (!reuse) {
    await browserPool.register({
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      browser,
      page,
      proxyId: "none",
      cookiePath: claim.profile.cookiePath,
      browserProfilePath: claim.profile.browserProfilePath,
      openedAt: new Date(),
      pid: ensured.pid || browser.process()?.pid,
      accountEmail: claim.account.email,
      markedReady: true,
      proxyEnabled: false,
      mapsReviewInProgress: true,
      proxyAuth: null,
    });
  } else if (live) {
    live.mapsReviewInProgress = true;
  }

  setMapsChromeGuard(true);
  throwIfAborted();

  console.log(
    `[worker] MAPS_DELETE_REVIEW #${claim.profile.browserIndex} ${claim.account.email} assignment=${payload.assignmentId}`,
  );

  try {
    await assertGoogleSessionForMaps(page, claim.account.email).catch((e) => {
      throw new Error(
        `Chưa đăng nhập Google để xóa review: ${e instanceof Error ? e.message : e}`,
      );
    });

    throwIfAborted();
    const out = await deleteMapsReview(page, payload, {
      signal,
      human: new HumanCursor(page),
    });

    if (!out.ok) {
      throw new Error(out.detail || "Xóa review thất bại");
    }

    const browserVersion = (await browser.version().catch(() => "")) || "";

    return {
      browserVersion,
      /** Không giữ Chrome — processJob sẽ forceClose + kill sau complete. */
      keepAlive: false,
      result: {
        ok: true,
        alreadyGone: out.alreadyGone,
        deleted: true,
        detail: out.detail,
        assignmentId: payload.assignmentId,
        reviewLink: payload.reviewLink ?? null,
        placeUrl: payload.placeUrl,
        browserIndex: claim.profile.browserIndex,
        email: claim.account.email,
        browserAlive: false,
      },
    };
  } finally {
    const pooled = browserPool.get(claim.profile.id);
    if (pooled) pooled.mapsReviewInProgress = false;
  }
}

async function runGoogleProfileUpdateJob(
  claim: ClaimPayload,
  job: ProfileTaskJob,
  opts?: { signal?: AbortSignal },
) {
  const raw = job.payload ?? claim.job?.payload;
  const payload = accountProfileUpdatePayloadSchema.parse(raw ?? {});
  const signal = opts?.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("ACCOUNT_PROFILE_UPDATE aborted (timeout/cancel)");
      (err as { code?: string }).code = "ABORTED";
      throw err;
    }
  };

  const live = browserPool.get(claim.profile.id);
  const reuse =
    Boolean(live?.browser.connected) && live?.proxyEnabled === false;
  const ensured = reuse
    ? { browser: live!.browser, reused: true as const, pid: live!.pid }
    : await connectOrLaunchBrowser(claim, { useProxy: false, neverKill: true });
  const browser = ensured.browser;
  const page =
    reuse && live?.page && !live.page.isClosed()
      ? live.page
      : await setupPage(browser, claim, { useProxy: false });

  if (!reuse) {
    await browserPool.register({
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      browser,
      page,
      proxyId: "none",
      cookiePath: claim.profile.cookiePath,
      browserProfilePath: claim.profile.browserProfilePath,
      openedAt: new Date(),
      pid: ensured.pid || browser.process()?.pid,
      accountEmail: claim.account.email,
      markedReady: true,
      proxyEnabled: false,
      mapsReviewInProgress: true,
      proxyAuth: null,
    });
  } else if (live) {
    live.mapsReviewInProgress = true;
  }

  setMapsChromeGuard(true);
  throwIfAborted();

  console.log(
    `[worker] ACCOUNT_PROFILE_UPDATE #${claim.profile.browserIndex} ${claim.account.email}`,
  );

  try {
    await assertGoogleSessionForMaps(page, claim.account.email).catch((e) => {
      throw new Error(
        `Chưa đăng nhập Google để đổi hồ sơ: ${e instanceof Error ? e.message : e}`,
      );
    });
    await ensureOnGoogleAccountProfile(page, new HumanCursor(page), {
      forceGoto: true,
      chromePid: ensured.pid || browser.process()?.pid,
    });

    throwIfAborted();
    const out = await updateGoogleProfile(page, payload, {
      signal,
      human: new HumanCursor(page),
      totpSecret: claim.account.totpSecret,
    });

    const browserVersion = (await browser.version().catch(() => "")) || "";

    return {
      browserVersion,
      keepAlive: true,
      result: {
        ok: out.ok,
        needsManual: out.needsManual,
        nameUpdated: out.nameUpdated,
        avatarUpdated: out.avatarUpdated,
        addressUpdated: out.addressUpdated,
        addressSkipped: out.addressSkipped,
        detail: out.detail,
        steps: out.steps,
        accountId: payload.accountId,
        email: claim.account.email,
        browserIndex: claim.profile.browserIndex,
      },
    };
  } finally {
    const pooled = browserPool.get(claim.profile.id);
    if (pooled) pooled.mapsReviewInProgress = false;
    setMapsChromeGuard(false);
  }
}

/** Quét tên + avatar thực tế từ myaccount.google.com, lưu vào GoogleAccount.googleName + googleAvatar. */
async function runScanGoogleProfileJob(
  claim: ClaimPayload,
  job: ProfileTaskJob,
  opts?: { signal?: AbortSignal },
) {
  const raw = job.payload ?? claim.job?.payload;
  const payload = scanGoogleProfilePayloadSchema.parse(raw ?? {});
  const signal = opts?.signal;

  const live = browserPool.get(claim.profile.id);
  const reuse =
    Boolean(live?.browser.connected) && live?.proxyEnabled === false;
  const ensured = reuse
    ? { browser: live!.browser, reused: true as const, pid: live!.pid }
    : await connectOrLaunchBrowser(claim, { useProxy: false, neverKill: true });
  const browser = ensured.browser;
  const page =
    reuse && live?.page && !live.page.isClosed()
      ? live.page
      : await setupPage(browser, claim, { useProxy: false });

  if (!reuse) {
    await browserPool.register({
      profileId: claim.profile.id,
      browserIndex: claim.profile.browserIndex,
      browser,
      page,
      proxyId: "none",
      cookiePath: claim.profile.cookiePath,
      browserProfilePath: claim.profile.browserProfilePath,
      openedAt: new Date(),
      pid: ensured.pid || browser.process()?.pid,
      accountEmail: claim.account.email,
      markedReady: true,
      proxyEnabled: false,
      mapsReviewInProgress: true,
      proxyAuth: null,
    });
  } else if (live) {
    live.mapsReviewInProgress = true;
  }

  setMapsChromeGuard(true);

  console.log(
    `[worker] SCAN_GOOGLE_PROFILE #${claim.profile.browserIndex} ${claim.account.email}`,
  );

  try {
    await assertGoogleSessionForMaps(page, claim.account.email).catch((e) => {
      throw new Error(
        `Chưa đăng nhập Google để quét hồ sơ: ${e instanceof Error ? e.message : e}`,
      );
    });

    const out = await scanGoogleProfile(page, payload, {
      signal,
      human: new HumanCursor(page),
    });

    const browserVersion = (await browser.version().catch(() => "")) || "";

    return {
      browserVersion,
      keepAlive: true,
      result: {
        ok: out.ok,
        name: out.name,
        avatarUrl: out.avatarUrl,
        detail: out.detail,
        needsManual: out.needsManual,
        accountId: payload.accountId,
        email: claim.account.email,
        browserIndex: claim.profile.browserIndex,
      },
    };
  } finally {
    const pooled = browserPool.get(claim.profile.id);
    if (pooled) pooled.mapsReviewInProgress = false;
    setMapsChromeGuard(false);
  }
}

/** Timeout cứng theo task — 1 job treo (CDP đơ, dialog nền…) không được chặn cả hàng đợi. */
const TASK_TIMEOUT_MS: Record<string, number> = {
  MAPS_REVIEW: Math.max(180_000, Number(process.env.MAPS_REVIEW_TIMEOUT_MS || 15 * 60_000)),
  MAPS_DELETE_REVIEW: Math.max(
    60_000,
    Number(process.env.MAPS_DELETE_TIMEOUT_MS || 8 * 60_000),
  ),
  ACCOUNT_PROFILE_UPDATE: Math.max(
    120_000,
    Number(process.env.ACCOUNT_PROFILE_UPDATE_TIMEOUT_MS || 12 * 60_000),
  ),
  SCAN_GOOGLE_PROFILE: Math.max(
    300_000,
    Number(process.env.SCAN_GOOGLE_PROFILE_TIMEOUT_MS || 5 * 60_000),
  ),
  HEALTHCHECK: 4 * 60_000,
  BROWSER_CHECK: 4 * 60_000,
  LOGIN: 45 * 60_000,
};

function runWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `${label} treo quá ${Math.round(ms / 60_000)} phút — tự hủy job để không chặn hàng đợi`,
          ),
        );
      }, ms);
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
    setMapsChromeGuard(on);
    if (!on && live?.pid) stopChromeWindowWatchdog(live.pid);
  };

  const abort = new AbortController();
  let taskPromise: Promise<unknown> | null = null;

  try {
    if (job.taskCode === "LOGIN") markLoginBusy(true);
    // MAPS: chỉ busy + chrome-guard sớm; mapsReviewInProgress gắn khi register
    // (tránh chặn forceClose đổi-proxy ở đầu job)
    if (job.taskCode === "MAPS_REVIEW" || job.taskCode === "MAPS_DELETE_REVIEW" || job.taskCode === "ACCOUNT_PROFILE_UPDATE" || job.taskCode === "SCAN_GOOGLE_PROFILE") {
      busyProfileIds.add(job.profileId);
      setMapsChromeGuard(true);
    }
    const taskTimeoutMs = TASK_TIMEOUT_MS[job.taskCode] ?? 10 * 60_000;
    taskPromise =
      job.taskCode === "LOGIN"
        ? runGoogleLogin(claim, {
            leaseToken: job.leaseToken,
            jobRunId: job.jobRunId,
          })
        : job.taskCode === "BROWSER_CHECK"
          ? runBrowserCheck(claim)
          : job.taskCode === "MAPS_REVIEW"
            ? runMapsReviewJob(claim, job, { signal: abort.signal })
            : job.taskCode === "MAPS_DELETE_REVIEW"
              ? runMapsDeleteReviewJob(claim, job, { signal: abort.signal })
              : job.taskCode === "ACCOUNT_PROFILE_UPDATE"
                ? runGoogleProfileUpdateJob(claim, job, { signal: abort.signal })
                : job.taskCode === "SCAN_GOOGLE_PROFILE"
                  ? runScanGoogleProfileJob(claim, job, { signal: abort.signal })
                  : runHealthcheck(claim);
    const out = await runWithTimeout(
      taskPromise,
      taskTimeoutMs,
      `${job.taskCode} #${claim.profile.browserIndex}`,
      () => {
        // Quan trọng: abort để zombie postMapsReview dừng — nếu không, job sau
        // mở Chrome cùng profile sẽ kill cửa sổ Maps đang chạy ngầm.
        abort.abort();
        console.warn(
          `[worker] ${job.taskCode} #${claim.profile.browserIndex} TIMEOUT → abort signal (chờ task dừng trước job kế)`,
        );
      },
    );

    const loginOut = out as {
      keepAlive?: boolean;
      markReady?: boolean;
      loginIssue?: string | null;
      browserVersion: string;
      result: Record<string, unknown>;
    };

    // Chỉ alive khi pool CDP còn nối — không tin lock file (user tắt tay vẫn còn lock)
    const liveAfter = browserPool.get(job.profileId);
    if (job.taskCode === "MAPS_REVIEW" && liveAfter) {
      liveAfter.mapsReviewInProgress = false;
    }
    if (job.taskCode === "MAPS_DELETE_REVIEW" && liveAfter) {
      liveAfter.mapsReviewInProgress = false;
    }
    if (job.taskCode === "ACCOUNT_PROFILE_UPDATE" && liveAfter) {
      liveAfter.mapsReviewInProgress = false;
    }
    let stillAlive = Boolean(liveAfter?.browser.connected);
    if (!stillAlive && job.taskCode === "MAPS_REVIEW") {
      const dir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
      const pid = await resolveChromePidByProfileDir(dir).catch(() => undefined);
      stillAlive = Boolean(pid);
    }
    // DELETE: luôn báo browserAlive=false — sẽ tắt Chrome ngay sau complete
    if (job.taskCode === "MAPS_DELETE_REVIEW") {
      stillAlive = false;
    }
    // PROFILE_UPDATE: giữ Chrome mở nếu cần giải tay
    if (job.taskCode === "ACCOUNT_PROFILE_UPDATE") {
      stillAlive = Boolean(liveAfter?.browser.connected);
    }
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
    if (job.taskCode === "MAPS_DELETE_REVIEW") {
      await shutdownChromeAfterDelete(claim);
    }
  } catch (err) {
    abort.abort();
    const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
    if (code === "ABORTED") {
      console.log(`[worker] job aborted by admin ${job.jobRunId} profile=${job.profileId}`);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    const stacktrace = err instanceof Error ? err.stack : undefined;
    // MAPS_REVIEW lỗi/timeout: GIỮ CDP + cửa sổ — KHÔNG disconnect, KHÔNG kill.
    // Disconnect cũ khiến browserAlive/pool lệch → lần sau spawn đè → Windows tắt Chrome cũ.
    let alive = Boolean(browserPool.get(job.profileId)?.browser.connected);
    if (job.taskCode === "MAPS_REVIEW") {
      try {
        const dir = path.resolve(STORAGE_DIR, claim.profile.browserProfilePath);
        const pid = await resolveChromePidByProfileDir(dir).catch(() => undefined);
        if (pid) alive = true;
        const live = browserPool.get(job.profileId);
        if (live) live.mapsReviewInProgress = false;
        // Job fail sau khi bật proxy — trả browser về IP máy (không gắn proxy lâu dài)
        const onProxy = await readChromeProxyFromProfileDir(dir).catch(() => null);
        if (onProxy) {
          await restoreProfileBrowserAfterMaps(claim, dir).catch((restoreErr) =>
            console.warn(
              `[worker] MAPS fail — restore IP máy lỗi:`,
              restoreErr instanceof Error ? restoreErr.message : restoreErr,
            ),
          );
          alive = Boolean(
            browserPool.get(job.profileId)?.browser.connected ||
              (await resolveChromePidByProfileDir(dir).catch(() => undefined)),
          );
        }
      } catch {
        /* ignore */
      }
      console.warn(
        `[worker] MAPS_REVIEW fail — giữ Chrome mở (alive=${alive}, pool=${Boolean(browserPool.get(job.profileId)?.browser.connected)}): ${error.slice(0, 160)}`,
      );
    }
    if (job.taskCode === "MAPS_DELETE_REVIEW") {
      const live = browserPool.get(job.profileId);
      if (live) live.mapsReviewInProgress = false;
      console.warn(
        `[worker] MAPS_DELETE_REVIEW fail — sẽ đóng Chrome: ${error.slice(0, 160)}`,
      );
      alive = false;
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
    if (job.taskCode === "MAPS_DELETE_REVIEW") {
      await shutdownChromeAfterDelete(claim).catch((e) =>
        console.warn(
          `[worker] dọn Chrome sau delete-fail lỗi: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
    throw err;
  } finally {
    // Chờ zombie task dừng hẳn trước khi nhả busy — tránh job kế kill Chrome đang Maps.
    if (taskPromise) {
      await Promise.race([
        taskPromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((r) => setTimeout(r, 8_000)),
      ]);
    }
    if (job.taskCode === "LOGIN") markLoginBusy(false);
    if (job.taskCode === "MAPS_REVIEW" || job.taskCode === "MAPS_DELETE_REVIEW") {
      markMapsBusy(false);
    }
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
  if (!userDataDir) return undefined;
  return resolveBestChromePidForProfileDir(userDataDir);
}

/**
 * Map user-data-dir (lower) → một PID Chrome MAIN (legacy heartbeat).
 * Dùng listAllChromeMainPidsByUserDataDir khi cần phát hiện trùng profile.
 */
async function listChromePidsByUserDataDir(): Promise<Map<string, number>> {
  const all = await listAllChromeMainPidsByUserDataDir();
  const out = new Map<string, number>();
  for (const [dir, pids] of all) {
    if (pids[0]) out.set(dir, pids[0]);
  }
  return out;
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
    // KHÔNG dùng Browser.setWindowBounds (Chrome 150 hay để cửa sổ IsWindowVisible=false).
    // Chỉ restore/show qua OS API.
  }
  if (process.platform === "win32") {
    let pid =
      (opts?.preferredPid && opts.preferredPid > 0 ? opts.preferredPid : undefined) ||
      browser.process()?.pid;
    if (!pid) {
      pid = await resolveChromePidByProfileDir(opts?.profilePath);
    }
    if (pid) {
      await ensureChromeWindowVisible(pid, "activateBrowserOnScreen");
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

function chromeSanitizeDeps() {
  return {
    readDevToolsPort,
    isDevToolsReachable,
    clearStaleProfileLocks,
  };
}

/** Chỉ coi profile busy khi MAPS/LOGIN đang giữ CDP sống — không chặn sanitize lúc mới bắt job. */
function isProfileChromeBusy(profileId: string): boolean {
  const live = browserPool.get(profileId);
  return Boolean(
    (live?.mapsReviewInProgress && live.browser.connected) ||
      (live?.loginInProgress && live.browser.connected),
  );
}

async function sanitizeProfileChromeForClaim(claim: ClaimPayload, reason: string) {
  return sanitizeProfileChrome({
    userDataDir: path.resolve(STORAGE_DIR, claim.profile.browserProfilePath),
    profileId: claim.profile.id,
    browserIndex: claim.profile.browserIndex,
    reason,
    isBusy: () => isProfileChromeBusy(claim.profile.id),
    deps: chromeSanitizeDeps(),
  });
}

let heartbeatPruneTick = 0;

async function maybePruneIdleChrome(runningJobs: number) {
  const every = Math.max(
    3,
    Number(process.env.CHROME_PRUNE_EVERY_HEARTBEATS || 18),
  );
  if (++heartbeatPruneTick % every !== 0) return;
  if (runningJobs > 0 && process.env.CHROME_PRUNE_WHILE_JOBS !== "1") return;

  try {
    const { profiles } = await api<{ profiles: ReclaimProfile[] }>(
      "/internal/browsers/list-for-reclaim",
      {},
    );
    await pruneIdleProfileChrome({
      profileDirs: profiles.map((p) => ({
        profileId: p.id,
        browserIndex: p.browserIndex,
        userDataDir: path.resolve(STORAGE_DIR, p.browserProfilePath),
      })),
      isBusy: (profileId) => isProfileChromeBusy(profileId),
      deps: chromeSanitizeDeps(),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Chỉ báo alive khi CDP/pool thật sự nối được, hoặc Chrome process còn sống.
 * Tắt Chrome tay → port chết + không process → không còn trong list → UI off.
 * QUAN TRỌNG:
 * - Không clear lock khi process Chrome còn sống.
 * - Không puppeteer.connect trong heartbeat nếu Chrome đã chạy (cướp CDP → LOGIN disconnect → cửa sổ tắt).
 * - Trả null khi đang quét (tránh heartbeat chồng → sync list rỗng → UI “Tắt” giả).
 */
async function collectAliveProfileIds(): Promise<string[] | null> {
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

  if (softReclaimBusy) return null;
  softReclaimBusy = true;
  try {
    const chromeByDir = await listChromePidsByUserDataDir();
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

      const dirKey = userDataDir.toLowerCase();
      const pid = chromeByDir.get(dirKey);
      const port = await readDevToolsPort(userDataDir);

      // Chrome process còn sống → báo alive, KHÔNG soft-connect (tránh cướp session LOGIN)
      if (pid) {
        ids.add(row.id);
        continue;
      }

      // SingletonLock còn = Chrome đang giữ profile (kể cả khi map PID miss)
      if (existsSync(path.join(userDataDir, "SingletonLock"))) {
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
          chromeByDir.get(dirKey) ||
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
  const payload: Record<string, unknown> = {
    id: WORKER_ID,
    hostname: hostname(),
    concurrency: CONCURRENCY,
    runningJobs,
    memPercent: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    queueLength,
    status: "ONLINE",
  };
  // null = đang quét dở — KHÔNG gửi mảng rỗng (tránh API clear hết browserAlive)
  if (aliveProfileIds) payload.aliveProfileIds = aliveProfileIds;
  await api("/internal/workers/heartbeat", payload).catch(() => undefined);
  void maybePruneIdleChrome(runningJobs);
}

/** Đọc port CDP Chrome đã ghi vào user-data-dir (fallback: cmdline process). */
async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  try {
    const raw = await readFile(file, "utf8");
    const port = Number(String(raw).split(/\r?\n/)[0]?.trim());
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* fall through */
  }
  // Fallback: đọc --remote-debugging-port từ process Chrome đang giữ profile
  if (process.platform !== "win32") return null;
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const abs = path.resolve(userDataDir).replace(/'/g, "''");
    const ps = `
$needle = '${abs}'
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |
  ForEach-Object {
    if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') {
      Write-Output $Matches[1]
      return
    }
  }
`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8_000, windowsHide: true, encoding: "utf8" },
    );
    const port = Number(String(stdout || "").trim().split(/\r?\n/).find((l) => /^\d+$/.test(l.trim())));
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

/** Đọc --proxy-server=host:port từ Chrome đang giữ user-data-dir (không kill). */
async function readChromeProxyFromProfileDir(
  userDataDir: string,
): Promise<{ host: string; port: number } | null> {
  const abs = path.resolve(userDataDir);
  if (process.platform !== "win32") return null;
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const needle = abs.replace(/'/g, "''");
    const ps = `
$needle = '${needle}'
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |
  ForEach-Object {
    if ($_.CommandLine -match '--proxy-server=(?:https?://)?([^:\\s]+):(\\d+)') {
      Write-Output ($Matches[1] + ':' + $Matches[2])
      return
    }
  }
`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 8_000, windowsHide: true, encoding: "utf8" },
    );
    const line = String(stdout || "").trim().split(/\r?\n/).find((l) => l.includes(":"));
    if (!line) return null;
    const m = line.match(/^([^:]+):(\d+)$/);
    if (!m) return null;
    return { host: m[1]!, port: Number(m[2]) };
  } catch {
    return null;
  }
}

/**
 * Kill Chrome đang giữ user-data-dir.
 * Mặc định NO-OP (giữ mọi cửa sổ) — chỉ thật sự kill khi ALLOW_CHROME_KILL=1.
 * Lỗi launch vừa spawn (spawnPid) vẫn được tắt riêng ở launchBrowser.
 */
async function killChromeUsingProfileDir(userDataDir: string) {
  if (process.env.ALLOW_CHROME_KILL !== "1") {
    console.warn(
      `[worker] BỎ QUA killChrome (never-kill toàn cục): ${path.basename(userDataDir)} — set ALLOW_CHROME_KILL=1 nếu thật sự cần`,
    );
    return;
  }
  const resolved = path.resolve(userDataDir);
  for (const live of browserPool.allSessions()) {
    if (!live.mapsReviewInProgress && !busyProfileIds.has(live.profileId)) continue;
    const livePath = live.browserProfilePath;
    if (!livePath) continue;
    const liveDir = path.resolve(STORAGE_DIR, livePath);
    if (liveDir === resolved) {
      console.warn(
        `[worker] BỎ QUA killChrome — đang MAPS/busy #${live.browserIndex} (${live.accountEmail || "?"})`,
      );
      return;
    }
  }
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
    invalidateChromeProfileCache();
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
    // Đang MAPS_REVIEW — tuyệt đối không reclaim/kill
    const busyLive = browserPool.get(row.id);
    if (busyLive?.mapsReviewInProgress || busyProfileIds.has(row.id)) {
      console.log(
        `[worker] reclaim skip #${row.browserIndex} — đang MAPS/busy`,
      );
      kept.push(row.id);
      continue;
    }
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
      // NEVER kill+relaunch — giữ orphan Chrome; user/Mở browser xử lý tay
      console.log(
        `[worker] reclaim #${row.browserIndex} orphan không CDP — GIỮ nguyên (never-kill), không relaunch`,
      );
      continue;
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
    const reclaimProxy = await readChromeProxyFromProfileDir(userDataDir).catch(
      () => null,
    );
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
      proxyEnabled: Boolean(reclaimProxy),
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

  void maybePruneIdleChrome(0);

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
          if (isMapsChromeGuardOn()) return;

          await ensureLiveProxyAuth(live);

          // Đã READY: sửa trang lệch im lặng — không cướp focus khi account khác đang LOGIN
          if (live.markedReady) {
            if (anyLoginBusy) return;
            // Chrome MAPS còn proxy — không goto myaccount (proxy nhả → tunnel fail)
            if (live.proxyEnabled) return;
            const u = live.page.url().toLowerCase();
            // Đừng đụng tab Maps — navigate đi = user thấy "out"
            if (/google\.(com|com\.\w+)\/maps/i.test(u)) return;
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
