/**
 * Browser #3 trial — login check + open place panel + Write a review
 */
import puppeteer from "puppeteer";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.resolve(
  __dirname,
  "../automation-profile-manager/apps/worker/data/profiles/profiles/c4094719-d1ef-4a9d-b1d3-7ddc0a9270d4-mrsq58ls",
);
const email = "huyenvu2k.ftu@gmail.com";
const executablePath = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, needles) {
  const lower = needles.map((n) => n.toLowerCase());
  return page.evaluate((needlesLower) => {
    const nodes = Array.from(
      document.querySelectorAll('button, [role="button"], a, span, div, h1, h2, h3'),
    );
    for (const node of nodes) {
      const label = (
        (node.getAttribute?.("aria-label") || "") +
        " " +
        (node.textContent || "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!label || label.length > 120) continue;
      if (!needlesLower.some((n) => label.includes(n))) continue;
      const clickable =
        node.closest("button") ||
        node.closest('[role="button"]') ||
        node.closest("a") ||
        (node.matches?.("button, [role='button'], a") ? node : node);
      clickable.scrollIntoView({ block: "center" });
      clickable.click();
      return label.slice(0, 100);
    }
    return null;
  }, lower);
}

// Kill leftover chrome locking this profile (best-effort)
try {
  const { execSync } = await import("child_process");
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*c4094719-d1ef-4a9d-b1d3-7ddc0a9270d4-mrsq58ls*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    { stdio: "ignore" },
  );
} catch {
  /* ignore */
}
await sleep(1000);

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
  // 1) Check Google session
  console.log("1) Check myaccount…");
  await page.goto("https://myaccount.google.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(3000);
  const onLogin = /accounts\.google\.com|signin/i.test(page.url());
  const pageHasEmail = await page.evaluate(
    (e) => (document.body?.innerText || "").toLowerCase().includes(e.toLowerCase()),
    email,
  );
  console.log("URL:", page.url());
  console.log("Logged in with email on page:", pageHasEmail, "| redirected to signin:", onLogin);

  // 2) Open Maps via search (ổn định hơn deep-link place)
  console.log("2) Open Maps search…");
  await page.goto(
    "https://www.google.com/maps/search/xonxao+caf%C3%A9+349+V%C5%A9+T%C3%B4ng+Phan+H%C3%A0+N%E1%BB%99i",
    { waitUntil: "domcontentloaded", timeout: 90_000 },
  );
  await sleep(5000);

  let h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
  console.log("H1 after search:", h1 || "(none)");
  if (!/xonxao/i.test(h1)) {
    const hit = await clickText(page, ["xonxao café", "xonxao cafe", "xonxao"]);
    console.log("Clicked result:", hit);
    await sleep(4000);
    h1 = await page.evaluate(() => document.querySelector("h1")?.textContent || "");
    console.log("H1 after click:", h1 || "(none)");
  }

  // 3) Reviews tab
  const tab = await clickText(page, ["reviews", "đánh giá"]);
  console.log("Reviews tab:", tab);
  await sleep(2500);

  // 4) Write a review
  let reviewBtn = null;
  for (const sel of [
    'button[aria-label="Write a review"]',
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label*="Write a review" i]',
    'button[aria-label*="Viết" i]',
  ]) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 2000, visible: true });
      if (el) {
        await el.click();
        reviewBtn = sel;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!reviewBtn) {
    reviewBtn = await clickText(page, [
      "write a review",
      "viết bài đánh giá",
      "viết đánh giá",
    ]);
  }

  if (reviewBtn) {
    console.log("✅ Write review clicked:", reviewBtn);
  } else {
    console.log("❌ Chưa click được Write a review");
    await page.screenshot({
      path: path.resolve(__dirname, "error_screenshot_browser3.png"),
    });
  }

  console.log("Done — Chrome #3 vẫn mở.");
} catch (e) {
  console.error(e);
}

await new Promise(() => {});
