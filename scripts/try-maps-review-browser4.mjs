/**
 * Browser #4 — Maps "Viết bài đánh giá"
 * Account: phuonganh.k62neu@gmail.com
 * Selector ưu tiên: button.S9kvJb[aria-label="Viết bài đánh giá"]
 */
import puppeteer from "puppeteer";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileId = "e921e5b5-06e3-41b2-bcbe-d8c528619a6b-mrsq55o4";
const userDataDir = path.resolve(
  __dirname,
  `../automation-profile-manager/apps/worker/data/profiles/profiles/${profileId}`,
);
const email = "phuonganh.k62neu@gmail.com";
const executablePath = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));

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

  // Cuộn tới nút nếu đã có trong DOM
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
    console.log("✅ Đã click (selector chính):", mainSelector);
    return true;
  } catch {
    console.log("Selector chính không thấy — thử fallback…");
  }

  for (const selector of fallbackSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000, visible: true });
      await page.click(selector);
      console.log("✅ Đã click (CSS):", selector);
      return true;
    } catch {
      /* next */
    }
  }

  // XPath fallback (Puppeteer mới không còn waitForXPath / $x)
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
        console.log("✅ Đã click (XPath):", xp);
        return true;
      }
    } catch {
      /* next */
    }
  }

  return false;
}

try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${profileId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    { stdio: "ignore" },
  );
} catch {
  /* ignore */
}
await sleep(1000);

console.log("Browser #4 →", email);
console.log("Profile →", userDataDir);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  userDataDir,
  ignoreDefaultArgs: ["--enable-automation"],
  args: [
    "--start-maximized",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  ...(executablePath ? { executablePath } : {}),
});

const page = (await browser.pages())[0] || (await browser.newPage());

try {
  console.log("Đang truy cập:", placeUrl);
  await page.goto(placeUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await sleep(5000);

  // Nếu panel place chưa có h1 — thử mở qua search result / place link
  const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
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
  }

  const clicked = await clickReviewButton(page);
  const shot = path.resolve(__dirname, "error_screenshot_browser4.png");

  if (!clicked) {
    console.error('❌ Không thể tìm thấy hoặc click "Viết bài đánh giá".');
    await page.screenshot({ path: shot, fullPage: true });
    console.log("Screenshot:", shot);
    console.log(
      "Gợi ý: nếu thấy nút Sign in — profile chưa login Google, cần đăng nhập tay rồi chạy lại.",
    );
  } else {
    console.log("✅ Đã nhấn thành công. Cửa sổ đánh giá sẽ xuất hiện (yêu cầu đăng nhập nếu chưa).");
    await sleep(10_000);
  }
} catch (e) {
  console.error(e);
  try {
    await page.screenshot({
      path: path.resolve(__dirname, "error_screenshot_browser4.png"),
      fullPage: true,
    });
  } catch {
    /* ignore */
  }
}

console.log("Giữ Chrome #4 mở.");
await new Promise(() => {});
