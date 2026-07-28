import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:55420",
  defaultViewport: null,
});

const page = await browser.newPage();
const placeUrl =
  "https://www.google.com/maps/place/xonxao+caf%C3%A9/@20.9856771,105.8212598,1053m/data=!3m1!1e3!4m8!3m7!1s0x3135adc5e8e29571:0x43598407ac1b9dec!8m2!3d20.9914875!4d105.8140649!9m1!1b1!16s%2Fg%2F11ml0jgrjd?entry=ttu";

await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
await sleep(5000);

const before = await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  writeBtn: !!document.querySelector('button.S9kvJb[aria-label="Viết bài đánh giá"]'),
  writeBtnText: document.querySelector('button.S9kvJb[aria-label="Viết bài đánh giá"]')?.innerText,
}));
console.log("before", before);

const btn = await page.$('button.S9kvJb[aria-label="Viết bài đánh giá"]');
if (btn) {
  const box = await btn.boundingBox();
  console.log("btn box", box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 50 });
}
await sleep(4000);

const pages = await browser.pages();
console.log(
  "pages after click",
  pages.map((p) => p.url().slice(0, 100)),
);

for (const [i, p] of pages.entries()) {
  const info = await p.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) =>
      (d.innerText || "").slice(0, 300),
    );
    const textareas = Array.from(document.querySelectorAll("textarea")).map((t) => ({
      aria: t.getAttribute("aria-label"),
      ph: t.getAttribute("placeholder"),
      vis: t.getClientRects().length > 0,
    }));
    const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => f.src?.slice(0, 120));
    return {
      url: location.href.slice(0, 120),
      dialogs,
      textareas,
      iframes,
      bodyHasDanhGia: (document.body?.innerText || "").includes("Đăng công khai"),
    };
  });
  console.log(`--- page ${i} ---`);
  console.log(JSON.stringify(info, null, 2));
}

await page.screenshot({
  path: path.resolve(__dirname, "debug_after_click_son.png"),
});
console.log("shot debug_after_click_son.png");
await browser.disconnect();
