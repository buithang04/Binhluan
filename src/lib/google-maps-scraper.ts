import { existsSync } from "fs";
import { extractPlaceKeyFromUrl } from "./place-key";
import type { MapsPlaceInfo } from "./google-maps";

type Scraped = {
  placeName: string | null;
  currentRating: number | null;
  reviewCount: number | null;
};

const scrapeCache = new Map<string, { at: number; info: MapsPlaceInfo | null }>();
const CACHE_TTL_MS = 10 * 60_000;

function cacheKey(url: string) {
  return url.trim().toLowerCase().replace(/\/$/, "");
}

function resolveChromeLaunch(): {
  executablePath?: string;
  channel?: "chrome";
} {
  const fromEnv = (process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  if (fromEnv && existsSync(fromEnv)) return { executablePath: fromEnv };

  const candidates = [
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : "",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return { executablePath: p };
  }
  return { channel: "chrome" };
}

function extractPlaceNameFromUrl(url: string): string | null {
  const match = url.match(/\/maps\/place\/([^/@?]+)/i);
  if (match?.[1]) {
    try {
      const name = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
      if (name) return name;
    } catch {
      const name = match[1].replace(/\+/g, " ").trim();
      if (name) return name;
    }
  }

  const searchMatch = url.match(/\/maps\/search\/([^/@?]+)/i);
  if (searchMatch?.[1]) {
    try {
      return decodeURIComponent(searchMatch[1].replace(/\+/g, " ")).trim() || null;
    } catch {
      return searchMatch[1].replace(/\+/g, " ").trim() || null;
    }
  }

  return null;
}

function buildSearchUrl(placeName: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(placeName)}?hl=vi`;
}

const SCRAPE_IN_BROWSER = `(() => {
  const toNum = (s) => {
    const n = Number(String(s).replace(",", ".").replace(/\\s/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  /** Cộng histogram aria "N sao, M bài đánh giá" → { total, avg } */
  const readHistogram = () => {
    let total = 0;
    let weighted = 0;
    let hit = false;
    for (const el of Array.from(document.querySelectorAll("[aria-label]"))) {
      const label = (el.getAttribute("aria-label") || "").trim();
      const m =
        label.match(/^([1-5])\\s*sao\\s*,\\s*(\\d[\\d.,\\s]*)\\s*bài đánh giá/i) ||
        label.match(/^([1-5])\\s*stars?\\s*,\\s*(\\d[\\d.,\\s]*)\\s*reviews?/i);
      if (!m) continue;
      hit = true;
      const stars = Number(m[1]);
      const count = toNum(m[2]) ?? 0;
      total += count;
      weighted += stars * count;
    }
    if (!hit) return null;
    return {
      total,
      avg: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
    };
  };

  const placeName = document.querySelector("h1")?.textContent?.trim() || null;
  let currentRating = null;
  let reviewCount = null;

  // 1) Histogram (ổn định) — ưu tiên khi đã có số liệu
  const hist = readHistogram();
  if (hist && hist.total > 0) {
    reviewCount = hist.total;
    if (hist.avg != null) currentRating = hist.avg;
  } else if (hist && hist.total === 0) {
    reviewCount = 0;
  }

  // 2) Khối sao tổng quan F7nice (trang Overview) — chỉ khi histogram chưa có
  const nice = document.querySelector("div.F7nice");
  if (nice && (currentRating == null || reviewCount == null)) {
    const niceText = (nice.innerText || "").replace(/\\u00a0/g, " ");
    if (currentRating == null) {
      const ratingM = niceText.match(/(\\d+(?:[.,]\\d+)?)/);
      if (ratingM) {
        const n = toNum(ratingM[1]);
        if (n != null && n >= 1 && n <= 5) currentRating = n;
      }
    }
    if (reviewCount == null) {
      const reviewM = niceText.match(/\\((\\d[\\d.,\\s]*)\\)/) ||
        niceText.match(/(\\d[\\d.,\\s]*)\\s*(?:bài\\s*)?(?:đánh giá|reviews?)/i);
      if (reviewM) {
        const n = toNum(reviewM[1]);
        if (n != null && n >= 0) reviewCount = n;
      }
    }
  }

  // 3) Aria điểm TB đúng dạng "3,0 sao" / "3.0 stars"
  if (currentRating == null) {
    for (const el of Array.from(document.querySelectorAll("[aria-label]"))) {
      const label = (el.getAttribute("aria-label") || "").trim();
      const m =
        label.match(/^(\\d+(?:[.,]\\d+)?)\\s*sao$/i) ||
        label.match(/^(\\d+(?:[.,]\\d+)?)\\s*stars?$/i);
      if (!m) continue;
      const n = toNum(m[1]);
      if (n != null && n >= 1 && n <= 5) {
        currentRating = n;
        break;
      }
    }
  }

  // 4) Text trang (fallback)
  const body = document.body?.innerText?.slice(0, 8000) || "";
  if (reviewCount == null) {
    if (/chưa có (?:bài )?đánh giá|no reviews?|be the first|chưa có ai đánh giá|chưa có xếp hạng/i.test(body)) {
      reviewCount = 0;
    } else {
      const m = body.match(/(\\d[\\d.,\\s]*)\\s*bài đánh giá/i)
        || body.match(/(\\d[\\d.,\\s]*)\\s*reviews?\\b/i);
      if (m) {
        const n = toNum(m[1]);
        if (n != null && n >= 0) reviewCount = n;
      }
    }
  }
  if (currentRating == null) {
    const m = body.match(/(\\d+(?:[.,]\\d+)?)\\s*sao\\b/i)
      || body.match(/(\\d+(?:[.,]\\d+)?)\\s*stars?\\b/i);
    if (m) {
      const n = toNum(m[1]);
      if (n != null && n >= 1 && n <= 5) currentRating = n;
    }
  }

  return { placeName, currentRating, reviewCount };
})()`;

const CLICK_REVIEWS_TAB = `(() => {
  const buttons = Array.from(document.querySelectorAll("button, [role='tab']"));
  const tab = buttons.find((b) => {
    const text = (b.textContent || "").trim();
    const label = b.getAttribute("aria-label") || "";
    if (/viết bài/i.test(label) || /viết bài/i.test(text)) return false;
    return text === "Bài đánh giá" || text === "Reviews" || /^Bài đánh giá\\b/i.test(label);
  });
  if (tab) {
    tab.click();
    return true;
  }
  return false;
})()`;

let scrapeQueue: Promise<unknown> = Promise.resolve();
let sharedBrowser: import("puppeteer").Browser | null = null;
let browserLaunch: Promise<import("puppeteer").Browser> | null = null;

async function withScrapeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scrapeQueue.then(fn, fn);
  scrapeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function getSharedBrowser(): Promise<import("puppeteer").Browser> {
  if (sharedBrowser?.connected) return sharedBrowser;
  if (browserLaunch) return browserLaunch;

  browserLaunch = (async () => {
    const puppeteer = await import("puppeteer");
    const chrome = resolveChromeLaunch();
    const browser = await puppeteer.default.launch({
      headless: true,
      ...(chrome.executablePath
        ? { executablePath: chrome.executablePath }
        : { channel: chrome.channel || "chrome" }),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    sharedBrowser = browser;
    browser.on("disconnected", () => {
      sharedBrowser = null;
      browserLaunch = null;
    });
    return browser;
  })();

  try {
    return await browserLaunch;
  } catch (e) {
    browserLaunch = null;
    throw e;
  }
}

async function setupPage(page: import("puppeteer").Page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8" });
}

async function resolveSearchHref(
  page: import("puppeteer").Page,
  placeName: string,
  placeKey: string | null,
): Promise<string | null> {
  await page.goto(buildSearchUrl(placeName), { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("a.hfpxzc", { timeout: 6000 }).catch(() => null);

  return page.evaluate(
    (name, key) => {
      const links = Array.from(document.querySelectorAll("a.hfpxzc")) as HTMLAnchorElement[];
      if (!links.length) return null;

      if (key) {
        const byKey = links.find((a) => (a.href || "").toLowerCase().includes(key.toLowerCase()));
        if (byKey) return byKey.href;
      }

      const target = name.trim().toLowerCase();
      const byName = links.find((a) => {
        const label = (a.getAttribute("aria-label") || "").trim().toLowerCase();
        return label === target;
      });
      return (byName || links[0]).href;
    },
    placeName,
    placeKey,
  );
}

async function openReviewsTab(page: import("puppeteer").Page) {
  await page.evaluate(CLICK_REVIEWS_TAB);
  await page
    .waitForSelector(".jANrlb .fontBodySmall, tr.BHOKXe[aria-label], div.F7nice", {
      timeout: 4000,
    })
    .catch(() => null);
  await new Promise((r) => setTimeout(r, 250));
}

/** Chạy thao tác trên 1 tab Maps (dùng chung browser pool). */
export async function withMapsPage<T>(
  fn: (page: import("puppeteer").Page) => Promise<T>,
): Promise<T> {
  return withScrapeLock(async () => {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    try {
      await setupPage(page);
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

export async function scrapeGoogleMapsDom(url: string): Promise<MapsPlaceInfo | null> {
  const key = cacheKey(url);
  const hit = scrapeCache.get(key);
  // Chỉ dùng cache khi đã quét được dữ liệu — không cache lần fail (tránh "lúc được lúc không")
  if (hit && hit.info && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;

  return withScrapeLock(async () => {
    const again = scrapeCache.get(key);
    if (again && again.info && Date.now() - again.at < CACHE_TTL_MS) return again.info;

    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    try {
      await setupPage(page);

      const placeNameFromUrl = extractPlaceNameFromUrl(url);
      const placeKey = extractPlaceKeyFromUrl(url);
      let scraped: Scraped = { placeName: null, currentRating: null, reviewCount: null };

      try {
        const direct = url.includes("hl=") ? url : `${url}${url.includes("?") ? "&" : "?"}hl=vi`;
        await page.goto(direct, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page
          .waitForSelector(
            "h1, div.F7nice, button[aria-label*='Write a review' i], button[aria-label*='Viết bài đánh giá' i]",
            { timeout: 10000 },
          )
          .catch(() => null);
        await new Promise((r) => setTimeout(r, 800));
        scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;

        // Chưa chắc (thiếu sao/lượt, hoặc 0 lượt nghi ngờ) → mở tab Reviews xác nhận
        const unsure =
          scraped.currentRating == null ||
          scraped.reviewCount == null ||
          scraped.reviewCount === 0;
        if (unsure) {
          await openReviewsTab(page);
          await page
            .waitForFunction(
              () =>
                Array.from(document.querySelectorAll("[aria-label]")).some((el) =>
                  /^[1-5]\s*sao\s*,/i.test((el.getAttribute("aria-label") || "").trim()),
                ) ||
                /bài đánh giá|reviews?/i.test(document.body?.innerText || ""),
              { timeout: 5000 },
            )
            .catch(() => null);
          await new Promise((r) => setTimeout(r, 400));
          scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;
        }
      } catch {
        /* fallback search below */
      }

      if (
        (scraped.currentRating == null ||
          scraped.reviewCount == null ||
          scraped.reviewCount === 0) &&
        placeNameFromUrl
      ) {
        const href = await resolveSearchHref(page, placeNameFromUrl, placeKey);
        if (href) {
          const target = href.includes("?") ? `${href}&hl=vi` : `${href}?hl=vi`;
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
          await page.waitForSelector("h1, div.F7nice", { timeout: 6000 }).catch(() => null);
          await new Promise((r) => setTimeout(r, 500));

          scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;
          await openReviewsTab(page);
          await new Promise((r) => setTimeout(r, 400));
          scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;
        }
      }

      if (
        scraped.placeName == null &&
        scraped.currentRating == null &&
        scraped.reviewCount == null
      ) {
        // Không cache null — lần sau thử lại
        return null;
      }

      const info: MapsPlaceInfo = {
        placeName:
          scraped.placeName && scraped.placeName !== "Kết quả"
            ? scraped.placeName
            : placeNameFromUrl,
        currentRating: scraped.currentRating,
        reviewCount: scraped.reviewCount,
        source: "dom_scrape",
        placeKey:
          extractPlaceKeyFromUrl(page.url()) ??
          placeKey ??
          extractPlaceKeyFromUrl(url),
      };
      scrapeCache.set(key, { at: Date.now(), info });
      return info;
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
