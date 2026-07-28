/**
 * Browser #56 — son22239485@gmail.com
 * Full review flow — form trong iframe ReviewsService.LoadWriteWidget
 * Sau Đăng: lưu link review → click Xong → mở place tiếp theo
 */
import puppeteer from "puppeteer";
import path from "path";
import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const email = "son22239485@gmail.com";
const browserURL = "http://127.0.0.1:55420";
const rating = 5;
const reviewText =
  "Không gian trang nghiêm, lối đi rõ ràng, dễ tìm. Thăm viếng thuận tiện.";
const imagePath = path.resolve(__dirname, "fixtures", "review-photo.png");

/** Place cần đánh giá lần này */
const placeUrl =
  "https://www.google.com/maps/place/Ngh%C4%A9a+Trang+V%C4%83n+%C4%90i%E1%BB%83n/@20.9450986,105.8235435,813m/data=!3m1!1e3!4m8!3m7!1s0x3135adb5f75bd773:0x3df67d1db41a2fdf!8m2!3d20.9450986!4d105.8261184!9m1!1b1!16s%2Fg%2F11t3ytz7qx?entry=ttu";

const reviewLinksFile = path.resolve(__dirname, "review-links.jsonl");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => path.resolve(__dirname, name);

function saveReviewLink(entry) {
  mkdirSync(path.dirname(reviewLinksFile), { recursive: true });
  appendFileSync(reviewLinksFile, JSON.stringify(entry) + "\n", "utf8");
  writeFileSync(
    path.resolve(__dirname, "last-review-link.json"),
    JSON.stringify(entry, null, 2),
    "utf8",
  );
  console.log("💾 Đã lưu link review →", reviewLinksFile);
  console.log("   ", entry.reviewLink || entry.profileReviewsLink);
}

async function clickReviewButton(page) {
  // Place mới: "Viết bài đánh giá"; place đã review: "Chỉnh sửa…"
  const selectors = [
    'button.S9kvJb[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label*="Viết bài đánh giá" i]',
    'button[aria-label*="Write a review" i]',
    'button[aria-label*="Chỉnh sửa bài đánh giá" i]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 8000, visible: true });
      await el.scrollIntoViewIfNeeded();
      await sleep(300);
      const box = await el.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        delay: 40,
      });
      console.log("✅ Click nút review:", sel);
      return true;
    } catch {
      /* next */
    }
  }
  throw new Error("Không tìm thấy nút Viết/Chỉnh sửa đánh giá");
}

/** Form review nằm trong iframe LoadWriteWidget */
async function waitReviewFrame(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frames = page.frames();
    for (const frame of frames) {
      const url = frame.url();
      if (!/ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(url))
        continue;
      try {
        const has = await frame.evaluate(
          () =>
            !!document.querySelector(
              'textarea, div[role="radiogroup"], [data-rating], button[jsname="IJM3w"]',
            ),
        );
        if (has) {
          console.log("✅ Review iframe sẵn sàng:", url.slice(0, 100));
          return frame;
        }
      } catch {
        /* cross-origin transient */
      }
    }
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const hasTa = await frame.$("textarea");
        if (hasTa) {
          console.log("✅ Review iframe (textarea):", frame.url().slice(0, 100));
          return frame;
        }
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
  }
  return null;
}

async function dismissInfoInFrame(frame) {
  await frame.evaluate(() => {
    const title = document.querySelector('h1, [role="heading"]');
    title?.click();
    const tips = Array.from(document.querySelectorAll("div, span")).filter((n) => {
      const t = (n.textContent || "").toLowerCase();
      return t.includes("cách bài đăng") || t.includes("how your posts appear");
    });
    for (const tip of tips) {
      const btn = tip
        .closest("div")
        ?.querySelector('button[aria-label*="Đóng" i], button[aria-label*="Close" i]');
      btn?.click();
    }
  });
  await sleep(400);
}

async function selectStar(frame, value) {
  await dismissInfoInFrame(frame);
  const ok = await frame.evaluate((rating) => {
    const groups = Array.from(document.querySelectorAll('div[role="radiogroup"]'));
    if (!groups.length) return { ok: false, reason: "no_radiogroup" };
    const group = groups[0];
    const byData =
      group.querySelector(`div.s2xyy[data-rating="${rating}"]`) ||
      group.querySelector(`[data-rating="${rating}"]`);
    if (byData) {
      byData.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      byData.click();
      const selected =
        group.querySelector(`[aria-checked="true"]`) ||
        group.querySelector(`[data-rating="${rating}"][aria-checked="true"]`);
      return { ok: true, via: "data-rating", checked: !!selected };
    }
    const clickables = Array.from(
      group.querySelectorAll('[role="radio"], .s2xyy, span, div, button'),
    ).filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width >= 14 && b.height >= 14;
    });
    const target = clickables[rating - 1] || clickables[clickables.length - 1];
    if (!target) return { ok: false, reason: "no_star_el", count: clickables.length };
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    target.click();
    return { ok: true, via: "index", count: clickables.length };
  }, value);

  console.log(`Sao ${value}:`, ok);
  if (!ok?.ok) return false;

  for (let i = 0; i < 15; i++) {
    const enabled = await frame.evaluate(() => {
      const b = document.querySelector('button[jsname="IJM3w"]');
      if (!b) return false;
      return !b.disabled && b.getAttribute("aria-disabled") !== "true";
    });
    if (enabled) {
      console.log("✅ Nút Đăng đã enable (sao OK)");
      return true;
    }
    if (i === 5 || i === 10) {
      await frame.evaluate((rating) => {
        const group = document.querySelectorAll('div[role="radiogroup"]')[0];
        group?.querySelector(`div.s2xyy[data-rating="${rating}"]`)?.click();
      }, value);
    }
    await sleep(400);
  }
  console.warn("⚠️ Sao có thể chưa ăn — Đăng vẫn disabled");
  return true;
}

async function enterReview(frame, text) {
  const selectors = [
    'textarea[aria-label="Nhập bài đánh giá"]',
    'textarea[aria-label*="đánh giá" i]',
    'textarea[placeholder*="trải nghiệm" i]',
    "textarea",
  ];
  for (const sel of selectors) {
    try {
      const el = await frame.waitForSelector(sel, { timeout: 5000, visible: true });
      await el.click({ clickCount: 3 });
      await frame.evaluate((s) => {
        const ta = document.querySelector(s);
        if (ta) ta.value = "";
      }, sel);
      await el.type(text, { delay: 25 });
      console.log("✅ Nhập bình luận:", sel);
      return true;
    } catch {
      /* next */
    }
  }
  console.error("❌ Không nhập được bình luận");
  return false;
}

/**
 * Chọn ảnh: ưu tiên uploadFile trực tiếp vào input[type=file] trong iframe,
 * fallback FileChooser khi click "Thêm ảnh và video".
 */
async function addImage(frame, page, filePath) {
  const abs = path.resolve(filePath);
  if (!abs || !existsSync(abs)) {
    console.log("⏭ Bỏ qua ảnh (không có file):", filePath);
    return false;
  }
  console.log("🖼 Upload ảnh:", abs);

  const findFileInput = async () => {
    const scopes = [frame, page, ...page.frames()];
    for (const ctx of scopes) {
      try {
        const inputs = await ctx.$$('input[type="file"]');
        for (const input of inputs) {
          const accept = await ctx.evaluate(
            (el) => (el.getAttribute("accept") || "").toLowerCase(),
            input,
          );
          if (!accept || accept.includes("image") || accept.includes("*")) {
            return input;
          }
        }
        if (inputs[0]) return inputs[0];
      } catch {
        /* ignore */
      }
    }
    return null;
  };

  try {
    let input = await findFileInput();

    if (!input) {
      // Click nút thêm ảnh trong iframe
      const clicked = await frame.evaluate(() => {
        const candidates = [
          ...document.querySelectorAll(
            'button, div[role="button"], span, div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf',
          ),
        ];
        for (const el of candidates) {
          const label = (
            el.getAttribute("aria-label") ||
            el.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (
            /Thêm ảnh và video/i.test(label) ||
            /Add photos? and videos?/i.test(label) ||
            /Thêm ảnh/i.test(label)
          ) {
            el.click();
            return label.slice(0, 60);
          }
        }
        return null;
      });
      console.log("Click thêm ảnh:", clicked || "(không thấy nút)");
      await sleep(600);
      input = await findFileInput();
    }

    if (input) {
      await input.uploadFile(abs);
      await input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      console.log("✅ uploadFile OK");
    } else {
      // FileChooser fallback
      console.log("→ Thử FileChooser…");
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }).catch(() => null),
        frame.evaluate(() => {
          const el =
            document.querySelector(
              'div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i], button[aria-label*="Add photo" i]',
            ) ||
            [...document.querySelectorAll("button, div[role='button']")].find(
              (b) => /Thêm ảnh|Add photo/i.test(b.textContent || ""),
            );
          el?.click();
        }),
      ]);
      if (!chooser) {
        console.warn("⚠️ Không mở được file chooser / không thấy input");
        await page.screenshot({ path: shot("error_photo_son.png") });
        return false;
      }
      await chooser.accept([abs]);
      console.log("✅ FileChooser.accept OK");
    }

    // Chờ thumbnail / ảnh đã gắn
    for (let i = 0; i < 20; i++) {
      const ready = await frame.evaluate(() => {
        const imgs = document.querySelectorAll(
          'img[src*="googleusercontent"], img[src*="lh3."], [data-photo-id], .YkuOub img, .OF2m4e img',
        );
        return imgs.length > 0;
      });
      if (ready) {
        console.log("✅ Ảnh đã hiện trong form");
        return true;
      }
      await sleep(400);
    }
    console.warn("⚠️ Upload xong nhưng chưa thấy thumbnail — vẫn tiếp tục");
    await page.screenshot({ path: shot("warn_photo_son.png") });
    return true;
  } catch (e) {
    console.error("❌ Ảnh:", e.message);
    await page.screenshot({ path: shot("error_photo_son.png") });
    return false;
  }
}

async function submitReview(frame) {
  await dismissInfoInFrame(frame);
  for (let i = 0; i < 20; i++) {
    const ready = await frame.evaluate(() => {
      const b = document.querySelector('button[jsname="IJM3w"]');
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    });
    if (ready) break;
    await sleep(400);
  }

  const clicked = await frame.evaluate(() => {
    const b = document.querySelector('button[jsname="IJM3w"]');
    if (!b) return { ok: false, reason: "missing" };
    if (b.disabled || b.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: "disabled" };
    }
    b.click();
    return { ok: true };
  });
  console.log("Đăng:", clicked);
  return !!clicked.ok;
}

/** Quét page + mọi iframe (thank-you thường nằm trong WriteWidget) */
async function findThankYouContext(page) {
  const contexts = [page.mainFrame(), ...page.frames()];
  for (const ctx of contexts) {
    try {
      const info = await ctx.evaluate(() => {
        const root =
          document.querySelector("[data-view-profile-post-link]") ||
          document.querySelector("#thank-you-title")?.closest(".RkItDe, [jscontroller]") ||
          document.querySelector('button[jsname="done-button"]')?.closest(".RkItDe, [jscontroller]");

        const profileReviewsLink =
          (root && root.getAttribute("data-view-profile-post-link")) ||
          document
            .querySelector("[data-view-profile-post-link]")
            ?.getAttribute("data-view-profile-post-link") ||
          null;

        const contributeMoreLink =
          document
            .querySelector("[data-contribute-more-link]")
            ?.getAttribute("data-contribute-more-link") || null;

        const pointsEl = document.querySelector("#thank-you-title .xy1tk, .xy1tk");
        const pointsText = pointsEl?.textContent?.trim() || null;
        const seeBtn = document.querySelector(
          'button[jsname="see-your-reviews-button"]',
        );
        const doneBtn = document.querySelector('button[jsname="done-button"]');
        const body = document.body?.innerText || "";
        const hasThankYou =
          !!doneBtn ||
          !!document.querySelector("#thank-you-title") ||
          /\+\d+\s*điểm/i.test(body);

        return {
          hasThankYou,
          profileReviewsLink,
          contributeMoreLink,
          pointsText,
          hasSee: !!seeBtn,
          hasDone: !!doneBtn,
          frameUrl: location.href.slice(0, 120),
        };
      });
      if (info?.hasThankYou) return { ctx, info };
    } catch {
      /* frame detached / cross-origin */
    }
  }
  return null;
}

/**
 * Thank-you modal: lấy link review → lưu → click Xong (jsname=done-button)
 */
async function finishThankYouAndSaveLink(page, placeUrlUsed, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await findThankYouContext(page);
    if (!found) {
      await sleep(400);
      continue;
    }

    const { ctx, info } = found;
    console.log("✅ Thank-you modal:", {
      points: info.pointsText,
      profileReviewsLink: info.profileReviewsLink,
      frame: info.frameUrl,
    });

    let reviewLink = info.profileReviewsLink;
    // Click "Xem bài đánh giá của bạn" để lấy URL cụ thể hơn (tab mới hoặc cùng tab)
    if (info.hasSee) {
      const beforePages = (await page.browser().pages()).length;
      await ctx.evaluate(() => {
        document.querySelector('button[jsname="see-your-reviews-button"]')?.click();
      });
      await sleep(2500);
      const pages = await page.browser().pages();
      if (pages.length > beforePages) {
        const newest = pages[pages.length - 1];
        reviewLink = newest.url();
        await newest.close().catch(() => undefined);
      } else if (!reviewLink) {
        reviewLink = page.url();
      }
    }

    const entry = {
      at: new Date().toISOString(),
      email,
      placeUrl: placeUrlUsed,
      reviewLink: reviewLink || info.profileReviewsLink,
      profileReviewsLink: info.profileReviewsLink,
      contributeMoreLink: info.contributeMoreLink,
      pointsText: info.pointsText,
    };
    saveReviewLink(entry);

    const done = await ctx.evaluate(() => {
      const b =
        document.querySelector('button[jsname="done-button"]') ||
        [...document.querySelectorAll("button")].find((x) => {
          const t = (x.textContent || "").replace(/\s+/g, " ").trim();
          return t === "Xong" || t === "Done";
        });
      if (!b) return false;
      b.click();
      return true;
    });
    console.log(done ? "✅ Click Xong (done-button)" : "⚠️ Không thấy nút Xong");
    await sleep(1200);
    return entry;
  }

  console.warn("⚠️ Không thấy thank-you modal");
  return null;
}

console.log(`#56 ${email} → ${browserURL}`);
console.log("Place:", placeUrl);
const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
const page = await browser.newPage();

try {
  await page.goto(placeUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  await sleep(4000);

  await clickReviewButton(page);
  await sleep(1500);

  const frame = await waitReviewFrame(page, 25000);
  if (!frame) {
    await page.screenshot({ path: shot("error_form_son.png"), fullPage: true });
    console.log(
      "Frames:",
      page.frames().map((f) => f.url().slice(0, 120)),
    );
    throw new Error("Không tìm thấy iframe form đánh giá");
  }

  await dismissInfoInFrame(frame);
  await selectStar(frame, rating);
  await enterReview(frame, reviewText);
  await addImage(frame, page, imagePath);
  await sleep(800);

  const submitted = await submitReview(frame);
  if (!submitted) {
    await page.screenshot({ path: shot("error_submit_son.png") });
    throw new Error("Không click được Đăng");
  }

  // Thank-you nằm trong iframe — bắt đầu poll ngay, không đợi
  const saved = await finishThankYouAndSaveLink(page, placeUrl, 30_000);
  await sleep(500);
  await page.screenshot({
    path: shot(saved ? "ok_submit_son.png" : "warn_submit_son.png"),
  });
  console.log(
    saved
      ? "🎉 Đánh giá xong — link đã lưu, đã nhấn Xong"
      : "⚠️ Đã Đăng nhưng chưa lưu được link / Xong",
  );
} catch (e) {
  console.error("Lỗi:", e.message || e);
  try {
    await page.screenshot({ path: shot("error_flow_son.png"), fullPage: true });
  } catch {
    /* ignore */
  }
}

await browser.disconnect();
console.log("Disconnect — Chrome #56 vẫn sống.");
