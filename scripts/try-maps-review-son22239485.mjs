/**
 * Browser #56 (son22239485@gmail.com) — connect Chrome đang sống + click Viết bài đánh giá
 */
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const email = "son22239485@gmail.com";
const browserIndex = 56;
const browserURL = "http://127.0.0.1:55420";

const placeUrl =
  "https://www.google.com/maps/place/xonxao+caf%C3%A9/@20.9856771,105.8212598,1053m/data=!3m1!1e3!4m8!3m7!1s0x3135adc5e8e29571:0x43598407ac1b9dec!8m2!3d20.9914875!4d105.8140649!9m1!1b1!16s%2Fg%2F11ml0jgrjd?entry=ttu&g_ep=EgoyMDI2MDcxNS4wIKXMDSoASAFQAw%3D%3D";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickReviewButton(page) {
  const mainSelector = 'button.S9kvJb[aria-label="Viết bài đánh giá"]';
  const fallbackSelectors = [
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Write a review"]',
    'button.S9kvJb[aria-label*="đánh giá" i]',
    'button.S9kvJb[aria-label*="review" i]',
  ];

  await page.evaluate(() => {
    const btn =
      document.querySelector('button.S9kvJb[aria-label="Viết bài đánh giá"]') ||
      document.querySelector('button[aria-label="Viết bài đánh giá"]') ||
      document.querySelector('button[aria-label="Write a review"]');
    if (btn) btn.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await sleep(800);

  try {
    await page.waitForSelector(mainSelector, { timeout: 5000, visible: true });
    await page.click(mainSelector);
    console.log("✅ Click (selector chính):", mainSelector);
    return true;
  } catch {
    console.log("Selector chính không thấy — thử fallback…");
  }

  for (const selector of fallbackSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000, visible: true });
      await page.click(selector);
      console.log("✅ Click (CSS):", selector);
      return true;
    } catch {
      /* next */
    }
  }

  const xpathList = [
    '//button[contains(@class, "S9kvJb") and contains(., "Viết bài đánh giá")]',
    '//button[@aria-label="Viết bài đánh giá"]',
    '//button[@aria-label="Write a review"]',
  ];
  for (const xp of xpathList) {
    try {
      const handle = await page.evaluateHandle((xpath) => {
        const r = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        return r.singleNodeValue;
      }, xp);
      const el = handle.asElement();
      if (el) {
        await el.click();
        console.log("✅ Click (XPath):", xp);
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

console.log(`Browser #${browserIndex} → ${email}`);
console.log("Connect CDP →", browserURL);

const browser = await puppeteer.connect({
  browserURL,
  defaultViewport: null,
});

const page = await browser.newPage();

try {
  // Check login nhanh
  console.log("1) Check myaccount…");
  await page.goto("https://myaccount.google.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(3000);
  const onLogin = /accounts\.google\.com|signin/i.test(page.url());
  const hasEmail = await page.evaluate(
    (e) => (document.body?.innerText || "").toLowerCase().includes(e.toLowerCase()),
    email,
  );
  console.log("URL:", page.url());
  console.log("Email on page:", hasEmail, "| need sign-in:", onLogin);

  console.log("2) Goto place…");
  await page.goto(placeUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await sleep(5000);

  let h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
  console.log("H1:", h1 || "(none)");
  if (!/xonxao/i.test(h1)) {
    const opened = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll('a[href*="/maps/place/"], [role="feed"] a'),
      );
      for (const a of links) {
        if ((a.textContent || "").toLowerCase().includes("xonxao")) {
          a.click();
          return (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
      }
      return null;
    });
    console.log("Mở place:", opened || "skip");
    await sleep(4000);
    h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
    console.log("H1 after:", h1 || "(none)");
  }

  const clicked = await clickReviewButton(page);
  const shot = path.resolve(__dirname, "error_screenshot_son22239485.png");

  if (!clicked) {
    console.error('❌ Không click được "Viết bài đánh giá".');
    await page.screenshot({ path: shot, fullPage: true });
    console.log("Screenshot:", shot);
  } else {
    console.log("✅ Đã nhấn Viết bài đánh giá.");
    await sleep(10_000);
    await page.screenshot({ path: shot });
    console.log("Screenshot:", shot);
  }
} catch (e) {
  console.error(e);
  try {
    await page.screenshot({
      path: path.resolve(__dirname, "error_screenshot_son22239485.png"),
      fullPage: true,
    });
  } catch {
    /* ignore */
  }
}

console.log("Xong — không đóng Chrome #56 (đang connect, chỉ disconnect).");
await browser.disconnect();
