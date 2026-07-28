import type { Browser, Page } from "puppeteer";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";

export type ProxyCreds = {
  id?: string;
  host?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
};

export type ProxyGateResult = {
  exitIp: string;
  proxyLabel: string;
  directIp: string | null;
};

const proxyAuthByBrowser = new WeakMap<
  Browser,
  { username: string; password: string }
>();
const proxyAuthListenerAttached = new WeakSet<Browser>();

export function proxyAuthDebug(proxy: ProxyCreds | null | undefined): string {
  if (!proxy?.username || !proxy?.password) return "missing";
  return `userLen=${proxy.username.length} passLen=${proxy.password.length}`;
}

function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? httpsRequest : httpRequest;
    const req = lib(url, { method: "GET", timeout: timeoutMs }, (res) => {
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

/** Gắn user/pass cho 1 tab — phải gọi trước page.goto khi dùng --proxy-server. */
export async function attachProxyAuthToPage(
  page: Page,
  proxy: ProxyCreds | null | undefined,
): Promise<boolean> {
  if (!proxy?.username || !proxy?.password) {
    console.warn("[proxy-auth] thiếu user/pass — tab sẽ bị HTTP 407 / popup Sign in");
    return false;
  }
  await page.authenticate({
    username: proxy.username,
    password: proxy.password,
  });
  return true;
}

/** Gắn auth cho mọi tab hiện có + tab mới — gọi ngay sau puppeteer.launch/connect. */
export async function bindProxyAuthToBrowser(
  browser: Browser,
  proxy: ProxyCreds | null | undefined,
): Promise<boolean> {
  if (!proxy?.username || !proxy?.password) {
    console.warn(
      "[proxy-auth] thiếu user/pass cho browser — Chrome sẽ báo 407 khi vào Maps",
    );
    return false;
  }
  const creds = { username: proxy.username, password: proxy.password };
  proxyAuthByBrowser.set(browser, creds);

  const pages = await browser.pages().catch(() => []);
  for (const p of pages) {
    if (p.isClosed()) continue;
    await p.authenticate(creds).catch(() => undefined);
  }

  if (!proxyAuthListenerAttached.has(browser)) {
    proxyAuthListenerAttached.add(browser);
    browser.on("targetcreated", (target) => {
      if (target.type() !== "page") return;
      void (async () => {
        const c = proxyAuthByBrowser.get(browser);
        if (!c) return;
        try {
          const page = await target.page();
          if (page && !page.isClosed()) {
            await page.authenticate(c);
          }
        } catch {
          /* ignore */
        }
      })();
    });
  }

  return true;
}

/**
 * Cổng bắt buộc trước Maps:
 * 1) Có user/pass
 * 2) Chrome lấy được exit IP qua proxy
 * 3) Exit IP khác IP máy (nếu lấy được IP máy) → chắc chắn đang đi proxy
 * 4) Hiện banner trên tab để nhìn thấy
 */
export async function assertProxyBeforeMaps(
  page: Page,
  proxy: ProxyCreds | null | undefined,
): Promise<ProxyGateResult> {
  if (!proxy?.host || !proxy.port) {
    throw new Error("MAPS_REVIEW bị chặn: chưa gán proxy host:port");
  }
  if (!proxy.username || !proxy.password) {
    throw new Error(
      `MAPS_REVIEW bị chặn: proxy ${proxy.host}:${proxy.port} thiếu user/pass`,
    );
  }

  await attachProxyAuthToPage(page, proxy);

  const directIp = await fetchPublicIpDirect();
  let exitIp = "";
  try {
    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const body = await page.evaluate(() => document.body?.innerText || "");
    const m = body.match(/"ip"\s*:\s*"([^"]+)"/);
    exitIp = m?.[1] || "";
    if (!exitIp) {
      throw new Error(`warmup không trả IP (body=${body.slice(0, 80)})`);
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(
      `MAPS_REVIEW bị chặn: proxy ${proxy.host}:${proxy.port} auth thất bại (${proxyAuthDebug(proxy)}): ${raw.slice(0, 180)}`,
    );
  }

  if (directIp && exitIp === directIp) {
    throw new Error(
      `MAPS_REVIEW bị chặn: exit IP trùng IP máy (${exitIp}) — Chrome chưa đi qua proxy ${proxy.host}:${proxy.port}`,
    );
  }

  const proxyLabel = `${proxy.host}:${proxy.port}`;
  console.log(
    `[proxy-gate] OK proxy=${proxyLabel} exitIp=${exitIp} directIp=${directIp || "n/a"} — cho phép vào Maps`,
  );

  // Banner nhìn thấy trên Chrome trước khi vào Maps
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px;background:#0b1220;color:#e8eef7">
    <h1 style="color:#2dd4bf">Proxy OK — vào Maps</h1>
    <p><b>Proxy:</b> ${proxyLabel}</p>
    <p><b>Exit IP (qua proxy):</b> <span style="color:#34d399">${exitIp}</span></p>
    <p><b>IP máy (không proxy):</b> ${directIp || "n/a"}</p>
    <p style="color:#8494ab;font-size:13px">Chỉ khi exit IP ≠ IP máy mới được đăng review.</p>
  </body></html>`;
  await page
    .goto(`data:text/html,${encodeURIComponent(html)}`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    })
    .catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));

  return { exitIp, proxyLabel, directIp };
}
