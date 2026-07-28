import { existsSync } from "fs";
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

function extractPlaceKeyFromUrl(url: string): string | null {
  const hex = url.match(/1s(0x[a-f0-9]+:0x[a-f0-9]+)/i)?.[1];
  if (hex) return hex.toLowerCase();
  const chij = url.match(/19s(ChIJ[^!?&]+)/i)?.[1];
  if (chij) return chij;
  return null;
}

function buildSearchUrl(placeName: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(placeName)}?hl=vi`;
}

const SCRAPE_IN_BROWSER = `(() => {
  const parseRating = (text) => {
    const m = String(text).replace(",", ".").match(/(\\d+(?:\\.\\d+)?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 && n <= 5 ? n : null;
  };

  const parseReviews = (text) => {
    const n = String(text).replace(/\\u00a0/g, " ");
    const compact = n.match(/(\\d+(?:,\\d+)?)\\s*\\((\\d[\\d.,\\s]*)\\)/);
    if (compact) {
      const v = Number(compact[2].replace(/[.,\\s]/g, ""));
      if (Number.isFinite(v) && v >= 0) return v;
    }
    const patterns = [
      /(\\d[\\d.,\\s]*)\\s*(?:bài\\s*)?(?:viết|đánh giá|reviews?)/i,
      /(\\d[\\d.,\\s]*)\\s*(?:lượt\\s*)?(?:đánh giá|reviews?)/i,
      /\\((\\d[\\d.,\\s]*)\\)/,
    ];
    for (const p of patterns) {
      const m = n.match(p);
      if (m && m[1]) {
        const v = Number(m[1].replace(/[.,\\s]/g, ""));
        if (Number.isFinite(v) && v >= 0) return v;
      }
    }
    return null;
  };

  const placeName = document.querySelector("h1")?.textContent?.trim() || null;
  let currentRating = null;
  let reviewCount = null;

  const nice = document.querySelector("div.F7nice");
  if (nice) {
    const spans = Array.from(nice.querySelectorAll("span[aria-hidden='true'], span"));
    for (const s of spans) {
      const t = s.textContent || "";
      if (currentRating == null) currentRating = parseRating(t);
      if (reviewCount == null) reviewCount = parseReviews(t);
    }
  }

  const ratingEl = document.querySelector("div.fontDisplayLarge, span.ceNzKf");
  if (currentRating == null && ratingEl) currentRating = parseRating(ratingEl.textContent || "");

  const body = document.body?.innerText?.slice(0, 8000) || "";
  if (currentRating == null) currentRating = parseRating(body);
  if (reviewCount == null) reviewCount = parseReviews(body);

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

export async function scrapeGoogleMapsDom(url: string): Promise<MapsPlaceInfo | null> {
  const key = cacheKey(url);
  const hit = scrapeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;

  return withScrapeLock(async () => {
    const again = scrapeCache.get(key);
    if (again && Date.now() - again.at < CACHE_TTL_MS) return again.info;

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
        await page.waitForSelector("h1, div.F7nice", { timeout: 8000 }).catch(() => null);
        await new Promise((r) => setTimeout(r, 350));
        scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;

        if (scraped.reviewCount == null || scraped.currentRating == null) {
          await openReviewsTab(page);
          scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;
        }
      } catch {
        /* fallback search below */
      }

      if (
        (scraped.currentRating == null || scraped.reviewCount == null) &&
        placeNameFromUrl
      ) {
        const href = await resolveSearchHref(page, placeNameFromUrl, placeKey);
        if (href) {
          const target = href.includes("?") ? `${href}&hl=vi` : `${href}?hl=vi`;
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
          await page.waitForSelector("h1, div.F7nice", { timeout: 6000 }).catch(() => null);
          await new Promise((r) => setTimeout(r, 300));

          scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;

          if (scraped.reviewCount == null || scraped.currentRating == null) {
            await openReviewsTab(page);
            scraped = (await page.evaluate(SCRAPE_IN_BROWSER)) as Scraped;
          }
        }
      }

      if (
        scraped.placeName == null &&
        scraped.currentRating == null &&
        scraped.reviewCount == null
      ) {
        scrapeCache.set(key, { at: Date.now(), info: null });
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
      };
      scrapeCache.set(key, { at: Date.now(), info });
      return info;
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
