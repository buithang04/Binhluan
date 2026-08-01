/**
 * Google Maps review automation — form trong iframe ReviewsService.LoadWriteWidget
 */
import type { ElementHandle, Frame, Page } from "puppeteer";
import { existsSync } from "fs";
import type { MapsReviewPayload } from "@apm/shared";
import { attachProxyAuthToPage } from "./proxy-auth.js";
import { HumanCursor } from "./humanize.js";
import { evalSafe } from "./maps-eval.js";
import {
  cleanupMapsPhotoTemps,
  prepareMapsPhotoForUpload,
  sweepStaleMapsPhotoTemps,
} from "./prepare-maps-photo.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));

type ProxyAuth = {
  username?: string | null;
  password?: string | null;
};

/** Mở tab Bài đánh giá / Reviews trên panel bên trái (nếu đang ở Tổng quan). */
async function openReviewsTab(page: Page) {
  const tabSelectors = [
    'button[aria-label*="Bài đánh giá" i]',
    'button[role="tab"][aria-label*="đánh giá" i]',
    'button[aria-label*="Reviews" i]',
    'button[role="tab"][aria-label*="Reviews" i]',
    '[role="tab"][aria-label*="Bài đánh giá" i]',
    '[role="tab"][aria-label*="Reviews" i]',
  ];
  for (const sel of tabSelectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const selected = await page.evaluate((node) => {
        const a = node as HTMLElement;
        return (
          a.getAttribute("aria-selected") === "true" ||
          a.getAttribute("aria-current") === "page" ||
          /selected|active/i.test(a.className || "")
        );
      }, el);
      if (selected) return true;
      await page.evaluate((node) => {
        (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
      }, el);
      await sleep(200);
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
          delay: 40,
        });
      } else {
        await el.click();
      }
      console.log("[maps-review] đã mở tab Bài đánh giá");
      await sleep(1200);
      return true;
    } catch {
      /* next */
    }
  }
  // Fallback: click theo text
  const byText = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button, [role="tab"], a, div[role="tab"]'),
    ) as HTMLElement[];
    const tab = nodes.find((n) => {
      const t = (n.textContent || "").trim();
      return /^(Bài đánh giá|Reviews)$/i.test(t) || /^Bài đánh giá$/i.test(t);
    });
    if (!tab) return false;
    if (tab.getAttribute("aria-selected") === "true") return true;
    tab.click();
    return true;
  });
  if (byText) {
    console.log("[maps-review] đã mở tab Bài đánh giá (text)");
    await sleep(1200);
  }
  return byText;
}

/** Cuộn panel trái Maps để lộ nút viết đánh giá. */
async function scrollPlacePanel(page: Page, deltaY: number) {
  await page.evaluate((dy) => {
    const panel =
      document.querySelector('[role="main"]') ||
      document.querySelector(".m6QErb") ||
      document.querySelector('[aria-label*="Thông tin về" i]') ||
      document.scrollingElement;
    if (panel && "scrollTop" in panel) {
      (panel as HTMLElement).scrollTop += dy;
    } else {
      window.scrollBy(0, dy);
    }
  }, deltaY);
  await sleep(400);
}

/** Thử chọn sao ngay trên trang place (panel trái) — hay mở form với sao đã chọn. */
async function tryRateOnPlacePanel(
  page: Page,
  rating: number,
  human: HumanCursor,
): Promise<boolean> {
  const want = Math.min(5, Math.max(1, Math.round(rating)));
  console.log(`[maps-review] thử sao có ngữ nghĩa trên place panel (${want}★)`);

  // Không đoán bằng "5 phần tử cùng hàng": Maps có nhiều hàng 5 icon không phải
  // sao đánh giá. Chỉ click phần tử thật sự có semantics rating.
  const selectors = [
    `button[aria-label="${want} sao"]`,
    `button[aria-label="${want} stars"]`,
    `button[aria-label="${want} star"]`,
    `[role="radio"][aria-label*="${want} sao" i]`,
    `[role="radio"][aria-label*="${want} star" i]`,
    `[role="button"][aria-label*="${want} sao" i]`,
    `[role="button"][aria-label*="${want} star" i]`,
    `[data-rating="${want}"][role="radio"]`,
    `[data-rating="${want}"][jsaction*="rate"]`,
  ];
  for (const selector of selectors) {
    const candidates = await page.$$(selector);
    for (const candidate of candidates) {
      const visible = await candidate
        .evaluate((el) => {
          const box = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el as Element);
          return (
            box.width >= 8 &&
            box.height >= 8 &&
            box.bottom > 0 &&
            box.right > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        })
        .catch(() => false);
      if (!visible) continue;
      try {
        await human.clickElement(candidate);
        await sleep(rand(800, 1400));
        console.log(`[maps-review] đã bấm sao trên place (${selector})`);
        return true;
      } catch {
        /* thử candidate tiếp */
      }
    }
  }
  return false;
}

async function dismissSpuriousReviewMenus(page: Page) {
  // Menu "Chia sẻ / Báo vi phạm" mở nhầm khi bấm nút gần «Viết đánh giá»
  await page
    .evaluate(() => {
      const body = document.body?.innerText || "";
      if (!/Báo bài đánh giá|Report review|Chia sẻ bài đánh giá|Share review/i.test(body)) {
        return;
      }
      // Đóng bằng nút Đóng / click ngoài / Escape sẽ làm ở ngoài
      const close = Array.from(
        document.querySelectorAll("button, [role='button'], [aria-label]"),
      ).find((el) => {
        const t =
          ((el as HTMLElement).getAttribute("aria-label") || "") +
          " " +
          ((el as HTMLElement).textContent || "");
        return /^(Đóng|Close|Dismiss)$/i.test(t.trim()) || /đóng menu|close menu/i.test(t);
      }) as HTMLElement | undefined;
      close?.click();
    })
    .catch(() => undefined);
  await sleep(300);
}

function isNewReviewLabel(aria: string, text: string): boolean {
  const t = `${aria} ${text}`;
  if (/Báo bài|Report review|Chia sẻ bài|Share review|Sao chép/i.test(t)) return false;
  if (/Chỉnh sửa bài đánh giá|Edit your review|Edit review/i.test(t)) return false;
  return /Viết bài đánh giá|Write a review/i.test(t);
}

/** Bấm「Viết bài đánh giá / Write a review」— không bấm Chỉnh sửa; false = không thấy nút (thử writereview URL). */
async function clickReviewButton(page: Page, human: HumanCursor): Promise<boolean> {
  const selectors = [
    'button.S9kvJb[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Write a review"]',
    'button[aria-label*="Viết bài đánh giá" i]',
    'button[aria-label*="Write a review" i]',
    'button.S9kvJb[aria-label*="Viết bài" i]',
  ];

  const tryClick = async (): Promise<boolean> => {
    for (const sel of selectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const meta = await el
            .evaluate((node) => {
              const h = node as HTMLElement;
              const box = h.getBoundingClientRect();
              return {
                aria: h.getAttribute("aria-label") || "",
                text: (h.textContent || "").trim().slice(0, 80),
                visible: box.width >= 8 && box.height >= 8 && box.bottom > 0,
              };
            })
            .catch(() => null);
          if (!meta?.visible || !isNewReviewLabel(meta.aria, meta.text)) continue;

          await page.evaluate((node) => {
            (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
          }, el);
          await sleep(rand(200, 400));
          let clicked = false;
          try {
            await human.clickElement(el);
            clicked = true;
          } catch {
            clicked = await page
              .evaluate((node) => {
                try {
                  (node as HTMLElement).click();
                  return true;
                } catch {
                  return false;
                }
              }, el)
              .catch(() => false);
          }
          if (!clicked) continue;
          console.log(
            `[maps-review] đã bấm VIẾT bài đánh giá mới (${sel} · ${meta.aria.slice(0, 40)})`,
          );
          await sleep(500);
          await dismissSpuriousReviewMenus(page);
          return true;
        }
      } catch {
        /* next */
      }
    }
    const hit = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, div[role='button']"),
      ) as HTMLElement[];
      const btn = nodes.find((n) => {
        const aria = n.getAttribute("aria-label") || "";
        const text = (n.textContent || "").trim();
        const t = `${aria} ${text}`;
        if (/Báo bài|Report review|Chia sẻ bài|Share review|Sao chép/i.test(t)) {
          return false;
        }
        if (/Chỉnh sửa|Edit your review|Edit review/i.test(t)) return false;
        return /Viết bài đánh giá|Write a review/i.test(t);
      });
      if (!btn) return false;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return true;
    });
    if (hit) {
      console.log("[maps-review] đã bấm VIẾT bài đánh giá mới (text fallback)");
      await sleep(500);
      await dismissSpuriousReviewMenus(page);
      return true;
    }
    return false;
  };

  // Ưu tiên tab Bài đánh giá — nút viết ổn định hơn trên Tổng quan (hay lẫn menu khác)
  await openReviewsTab(page).catch(() => undefined);
  await sleep(600);
  if (await tryClick()) return true;

  // Tổng quan
  if (await tryClick()) return true;

  // Cuộn panel trái
  for (let i = 0; i < 8; i++) {
    await scrollPlacePanel(page, 280);
    if (await tryClick()) return true;
  }

  return false;
}

/** Xác minh review đã lên sau submit (khi không bắt được màn cảm ơn). */
/** Mail đã có review tại place — Google hiện nút Chỉnh sửa (1 mail / 1 địa điểm). */
async function detectAccountAlreadyReviewedAtPlace(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], a"),
      ) as HTMLElement[];
      return nodes.some((n) => {
        const t = `${n.getAttribute("aria-label") || ""} ${(n.textContent || "").trim()}`;
        return /Chỉnh sửa bài đánh giá|Edit your review/i.test(t);
      });
    })
    .catch(() => false);
}

async function verifyReviewPosted(page: Page, reviewText: string): Promise<boolean> {
  const snippet = reviewText.trim().slice(0, 48);
  for (const ctx of [page.mainFrame(), ...page.frames()]) {
    try {
      const hit = await ctx.evaluate((snip) => {
        const body = document.body?.innerText || "";
        if (/Chỉnh sửa bài đánh giá|Edit your review/i.test(body)) return true;
        if (
          /cảm ơn|thank you|đã đăng|review (has been )?posted|your review/i.test(
            body,
          )
        ) {
          return true;
        }
        if (snip.length >= 10 && body.includes(snip)) return true;
        return false;
      }, snippet);
      if (hit) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Điểm số form review trong 1 frame — BẮT BUỘC WriteWidget / textarea / nút Đăng. */
async function scoreReviewFrame(frame: Frame): Promise<number> {
  const url = frame.url() || "";
  const isWidgetUrl = /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(
    url,
  );
  try {
    const score = await frame.evaluate(() => {
      const href = location.href || "";
      const isWidget = /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(
        href,
      );
      const hasTextarea = !!document.querySelector(
        'textarea, div[contenteditable="true"][role="textbox"], div[role="textbox"]',
      );
      const hasPost = !!document.querySelector('button[jsname="IJM3w"]');
      const hasRadiogroup = !!document.querySelector('div[role="radiogroup"]');
      const radioCount = document.querySelectorAll('[role="radio"]').length;

      if (!isWidget && !hasTextarea && !hasPost) {
        const inDialog = !!document.querySelector('[role="dialog"]');
        const starBtns = Array.from(
          document.querySelectorAll(
            '[role="dialog"] button, [role="dialog"] [role="radio"], [role="dialog"] [role="button"], [role="radiogroup"] [role="radio"]',
          ),
        ).filter((el) => {
          const label = (el.getAttribute("aria-label") || "").trim();
          if (/,\s*\d+\s*(review|bài)|Sao chép|Báo bài|Chia sẻ/i.test(label)) {
            return false;
          }
          return (
            /^[1-5]\s*(sao|stars?)$/i.test(label) ||
            /\b[1-5]\s*(sao|stars?)\b/i.test(label) ||
            /^(Một|Hai|Ba|Bốn|Năm|One|Two|Three|Four|Five)\s+sao/i.test(label) ||
            /^(One|Two|Three|Four|Five)\s+stars?/i.test(label)
          );
        });
        if (
          inDialog &&
          ((hasRadiogroup && radioCount >= 5) || starBtns.length >= 5)
        ) {
          return 55;
        }
        // Radiogroup 5 sao trên trang (kể cả ngoài dialog) = form bước chọn sao
        if (hasRadiogroup && radioCount >= 5 && starBtns.length >= 3) {
          return 55;
        }
        return 0;
      }

      let s = 0;
      if (isWidget) s += 50;
      if (hasTextarea) s += 40;
      if (hasPost) s += 20;
      if (hasRadiogroup || radioCount >= 5) s += 15;
      // Stub LoadWriteWidget chưa load (body trống) — không đủ để chọn sao
      const bodyLen = (document.body?.innerText || "").trim().length;
      if (isWidget && bodyLen < 8 && !hasTextarea && !hasPost && radioCount === 0) {
        return 15;
      }
      return s;
    });
    // URL widget nhưng evaluate trả thấp do đang load — giữ sàn nhẹ, không nhận form
    if (isWidgetUrl && score < 15) return 15;
    return score;
  } catch {
    // Cross-origin / frame đơ — chưa chắc đã có form
    return isWidgetUrl ? 15 : 0;
  }
}

async function waitReviewFrame(page: Page, timeoutMs = 35_000): Promise<Frame> {
  const start = Date.now();
  let bestFrame: Frame | null = null;
  let bestScore = 0;
  let sawWriteWidgetDom = false;
  let nudged = false;
  let reclicked = false;

  while (Date.now() - start < timeoutMs) {
    // Iframe có trong DOM dù chưa kịp vào page.frames()
    const domWidget = await page
      .evaluate(() => {
        const ifr = document.querySelector(
          'iframe[src*="LoadWriteWidget"], iframe[src*="writereview"], iframe[src*="WriteWidget"], iframe[src*="bscframe"]',
        ) as HTMLIFrameElement | null;
        return ifr ? (ifr.src || "").slice(0, 120) : null;
      })
      .catch(() => null);
    if (domWidget) {
      if (!sawWriteWidgetDom) {
        console.log(`[maps-review] thấy LoadWriteWidget trong DOM — chờ nội dung form…`);
        sawWriteWidgetDom = true;
      }
      // Stub lâu không load → bấm sao VI / radiogroup trên dialog để kích hoạt widget
      if (!nudged && Date.now() - start > 5_000) {
        nudged = true;
        console.log(`[maps-review] stub WriteWidget — thử bấm sao để mở form…`);
        await page
          .evaluate(() => {
            const labels = [
              "Năm sao",
              "Five stars",
              "5 sao",
              "Bốn sao",
              "4 sao",
              "Ba sao",
            ];
            for (const L of labels) {
              const el = document.querySelector(
                `[role="radio"][aria-label="${L}"], [aria-label="${L}"]`,
              ) as HTMLElement | null;
              if (el) {
                el.click();
                return L;
              }
            }
            const radios = document.querySelectorAll(
              '[role="radiogroup"] [role="radio"]',
            );
            if (radios.length >= 5) {
              (radios[4] as HTMLElement).click();
              return "radio-5";
            }
            return null;
          })
          .catch(() => null);
        await sleep(1200);
      }
      // Vẫn stub sau ~12s → KHÔNG Escape (Escape = đóng form / hỏi hủy).
      // Chỉ bấm lại «Viết» nếu disclaimer/widget đã biến mất.
      if (!reclicked && Date.now() - start > 12_000) {
        reclicked = true;
        const stillOpen = await page
          .evaluate(() => {
            const hasIfr = !!document.querySelector(
              'iframe[src*="LoadWriteWidget"], iframe[src*="WriteWidget"], iframe[src*="writereview"]',
            );
            const body = document.body?.innerText || "";
            const hasDisclaimer =
              /Google không xác minh|Google does not verify|Nhập bài đánh giá|Share more about/i.test(
                body,
              );
            return hasIfr || hasDisclaimer;
          })
          .catch(() => true);
        if (stillOpen) {
          console.log(
            `[maps-review] stub WriteWidget lâu nhưng form vẫn mở — tiếp tục chờ (không bấm lại / không Escape)`,
          );
        } else {
          console.log(`[maps-review] form đã mất — bấm lại Viết đánh giá…`);
          await page
            .evaluate(() => {
              const btn = Array.from(
                document.querySelectorAll("button, [role='button']"),
              ).find((n) => {
                const t =
                  ((n as HTMLElement).getAttribute("aria-label") || "") +
                  " " +
                  ((n as HTMLElement).textContent || "");
                if (/Báo bài|Chia sẻ bài|Report|Share review/i.test(t)) return false;
                if (/Chỉnh sửa|Edit your review|Edit review/i.test(t)) return false;
                return /Viết bài đánh giá|Write a review/i.test(t);
              }) as HTMLElement | undefined;
              btn?.click();
              return !!btn;
            })
            .catch(() => false);
          await sleep(2000);
        }
      }
    }

    for (const frame of page.frames()) {
      const url = frame.url() || "";
      const isWidget = /LoadWriteWidget|writereview|WriteWidget|bscframe/i.test(url);
      let score = await scoreReviewFrame(frame);
      // Main Maps có 5 sao VI trong dialog / radiogroup = form bước 1
      if (score < 40 && /google\.(com|com\.\w+)\/maps/i.test(url)) {
        const mainStars = await frame
          .evaluate(() => {
            const labels = Array.from(document.querySelectorAll("[aria-label]")).map(
              (el) => (el.getAttribute("aria-label") || "").trim(),
            );
            const vi = labels.filter((t) =>
              /^(Một|Hai|Ba|Bốn|Năm|One|Two|Three|Four|Five)\s+(sao|stars?)$/i.test(
                t,
              ),
            );
            return (
              vi.length >= 5 ||
              document.querySelectorAll('[role="radiogroup"] [role="radio"]').length >=
                5
            );
          })
          .catch(() => false);
        if (mainStars) score = 55;
      }
      if (score < 40) continue;
      if (score > bestScore) {
        bestScore = score;
        bestFrame = frame;
      }
      if (score >= 55) {
        console.log(
          `[maps-review] form frame score=${score} url=${url.slice(0, 80)}`,
        );
        return frame;
      }
      if (isWidget && score >= 40) {
        // Đợi nội dung widget (bscframe) fill
        const ready = await frame
          .evaluate(() => {
            const t = (document.body?.innerText || "").trim();
            return (
              t.length >= 8 ||
              !!document.querySelector(
                'textarea, [role="textbox"], [role="radiogroup"], [data-rating], [role="radio"], button[jsname="IJM3w"]',
              )
            );
          })
          .catch(() => false);
        if (ready) {
          console.log(
            `[maps-review] form frame score=${score} ready url=${url.slice(0, 80)}`,
          );
          return frame;
        }
      }
    }
    if (bestFrame && bestScore >= 55 && Date.now() - start > 6_000) {
      console.log(`[maps-review] form frame score=${bestScore} (ready)`);
      return bestFrame;
    }
    // score 40–54 = widget URL chưa có sao/textarea — tiếp tục chờ, không nhận sớm
    await sleep(450);
  }

  if (bestFrame && bestScore >= 55) {
    console.log(`[maps-review] form frame score=${bestScore} (timeout best)`);
    return bestFrame;
  }
  if (bestFrame && bestScore >= 40) {
    console.warn(
      `[maps-review] form frame score=${bestScore} (chưa đủ nội dung — không nhận stub)`,
    );
  }
  throw new Error(
    sawWriteWidgetDom
      ? "LoadWriteWidget có trong DOM nhưng nội dung form trống (bscframe chưa load) — thử lại hoặc kiểm tra session"
      : "Không tìm thấy iframe form đánh giá (WriteWidget/textarea)",
  );
}

/** Maps VI: "Một sao"…"Năm sao" — không phải chỉ "1 sao"/"5 sao". */
const VI_STAR_ARIA: Record<number, string[]> = {
  1: ["Một sao", "Mot sao", "One star", "1 sao", "1 star"],
  2: ["Hai sao", "Two stars", "Two star", "2 sao", "2 stars"],
  3: ["Ba sao", "Three stars", "Three star", "3 sao", "3 stars"],
  4: ["Bốn sao", "Bon sao", "Four stars", "Four star", "4 sao", "4 stars"],
  5: ["Năm sao", "Nam sao", "Five stars", "Five star", "5 sao", "5 stars"],
};

function matchViStarLabel(label: string, n: number): boolean {
  const raw = (label || "").trim();
  if (!raw) return false;
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words: Record<number, string[]> = {
    1: ["mot sao", "one star", "1 sao", "1 star"],
    2: ["hai sao", "two star", "2 sao", "2 star"],
    3: ["ba sao", "three star", "3 sao", "3 star"],
    4: ["bon sao", "four star", "4 sao", "4 star"],
    5: ["nam sao", "five star", "5 sao", "5 star"],
  };
  if ((words[n] || []).some((w) => t === w || t.startsWith(w + " ") || t.includes(w))) {
    return true;
  }
  return new RegExp(`\\b${n}\\s*(sao|stars?)\\b`, "i").test(raw);
}

function ratingFromStarLabel(label: string): number | null {
  for (let n = 5; n >= 1; n--) {
    if (matchViStarLabel(label, n)) return n;
  }
  return null;
}

/** Đọc số sao đang chọn — Maps VI hay set data-rating trên radiogroup (0→chưa, 1..5→đã chọn). */
async function readSelectedRating(frame: Frame): Promise<number | null> {
  try {
    return await frame.evaluate(() => {
      const labelOf = (el: Element) =>
        (
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("title") || "")
        ).trim();
      const fromLabel = (el: Element): number | null => {
        const raw = labelOf(el);
        const t = raw
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const map: Array<[RegExp, number]> = [
          [/\bnam sao\b|five stars?|\b5\s*(sao|stars?)\b/, 5],
          [/\bbon sao\b|four stars?|\b4\s*(sao|stars?)\b/, 4],
          [/\bba sao\b|three stars?|\b3\s*(sao|stars?)\b/, 3],
          [/\bhai sao\b|two stars?|\b2\s*(sao|stars?)\b/, 2],
          [/\bmot sao\b|one stars?|\b1\s*(sao|stars?)\b/, 1],
        ];
        for (const [re, n] of map) {
          if (re.test(t)) return n;
        }
        return null;
      };
      const isYellowish = (css: string): boolean =>
        /rgb\(\s*(2(4[0-9]|5[0-5])|255)\s*,\s*(1[4-9]\d|2[0-2]\d)\s*,\s*\d+|#[fF][a-fA-F0-9]{2}[0-9a-fA-F]{0,4}|#f[abe]|gold|orange|yellow|fabb|fea|ffc04|fbbc04|f4b400/i.test(
          css,
        );

      const isFilledLook = (el: Element): boolean => {
        if (el.getAttribute("aria-checked") === "true") return true;
        if (el.getAttribute("aria-pressed") === "true") return true;
        if (el.getAttribute("aria-selected") === "true") return true;
        if (/\b(selected|checked|active|filled|Fq92eb|jqiLkb)\b/i.test(el.className || "")) {
          return true;
        }
        const st = getComputedStyle(el as HTMLElement);
        if (isYellowish(st.color + " " + st.fill + " " + st.backgroundColor)) return true;
        for (const s of Array.from(el.querySelectorAll("path, polygon, circle, svg"))) {
          const cs = getComputedStyle(s as Element);
          const fill =
            (cs.fill || "") +
            " " +
            (s.getAttribute("fill") || "") +
            " " +
            (cs.color || "");
          if (fill.includes("none")) continue;
          if (isYellowish(fill)) return true;
        }
        return false;
      };

      // 1) radiogroup "Xếp hạng theo sao" data-rating (0→chưa, 1..5→đã chọn)
      const rankGroups = Array.from(
        document.querySelectorAll(
          '[role="radiogroup"][aria-label*="Xếp hạng" i], [role="radiogroup"][aria-label*="star" i], div.lv4IMd[role="radiogroup"]',
        ),
      ) as HTMLElement[];
      const groups =
        rankGroups.length > 0
          ? rankGroups
          : (Array.from(document.querySelectorAll('[role="radiogroup"]')) as HTMLElement[]);
      for (const group of groups) {
        for (const attr of ["data-rating", "data-value", "aria-valuenow"]) {
          const v = Number(group.getAttribute(attr));
          if (v >= 1 && v <= 5) return v;
        }
        // Sao đã chọn: aria-checked trên .s2xyy
        const checked = group.querySelector(
          'div.s2xyy[role="radio"][aria-checked="true"], [role="radio"][aria-checked="true"]',
        ) as HTMLElement | null;
        if (checked) {
          const d = Number(checked.getAttribute("data-rating"));
          if (d >= 1 && d <= 5) return d;
          const lb = fromLabel(checked);
          if (lb) return lb;
        }
        // SVG fill đổi màu (không còn #80868b) = sao đã tô
        const radios = Array.from(
          group.querySelectorAll('div.s2xyy[role="radio"], [role="radio"]'),
        ).filter((el) => el.getAttribute("data-rating") !== "0") as HTMLElement[];
        let filled = 0;
        for (let i = 0; i < radios.length && i < 5; i++) {
          const path = radios[i]!.querySelector("path");
          const fill = (path?.getAttribute("fill") || "").toLowerCase();
          const painted =
            fill &&
            fill !== "#80868b" &&
            fill !== "none" &&
            !fill.includes("80868b");
          if (painted || isFilledLook(radios[i]!)) filled = i + 1;
          else break;
        }
        if (filled >= 1) return filled;
        const gl = fromLabel(group);
        if (gl) return gl;
      }

      // 2) radio đang checked / selected (toàn document)
      const checked = document.querySelector(
        '[role="radio"][aria-checked="true"], [role="radio"][aria-selected="true"], [role="radio"][aria-pressed="true"]',
      ) as HTMLElement | null;
      if (checked) {
        const lb = fromLabel(checked);
        if (lb) return lb;
        const d = Number(checked.getAttribute("data-rating"));
        if (d >= 1 && d <= 5) return d;
        const p = Number(checked.getAttribute("aria-posinset"));
        if (p >= 1 && p <= 5) return p;
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Click sao trong DOM — theo đúng Maps VI:
 * radiogroup[aria-label="Xếp hạng theo sao"] > div.s2xyy[role=radio][data-rating=1..5]
 * aria-label: Một/Hai/Ba/Bốn/Năm sao
 */
async function clickStarInDom(
  frame: Frame,
  value: number,
): Promise<{ ok: boolean; via: string; selected: number | null; detail?: string }> {
  const rating = Math.min(5, Math.max(1, Math.round(value)));
  const viLabels = VI_STAR_ARIA[rating] || [`${rating} sao`];

  // 0) Click Puppeteer thật trên selector Maps VI (.s2xyy / aria-label) — ổn định hơn dispatchEvent
  const exactSels = [
    `[role="radiogroup"][aria-label*="Xếp hạng" i] div.s2xyy[role="radio"][data-rating="${rating}"]`,
    `div.lv4IMd[role="radiogroup"] div.s2xyy[role="radio"][data-rating="${rating}"]`,
    `div.s2xyy[role="radio"][data-rating="${rating}"]`,
    ...viLabels.map(
      (l) =>
        `[role="radiogroup"][aria-label*="Xếp hạng" i] [role="radio"][aria-label="${l}"]`,
    ),
    ...viLabels.map((l) => `div.s2xyy[role="radio"][aria-label="${l}"]`),
    ...viLabels.map((l) => `[role="radio"][aria-label="${l}"]`),
  ];
  for (const sel of exactSels) {
    try {
      const handle = await frame.$(sel);
      if (!handle) continue;
      const box = await handle.boundingBox();
      if (!box || box.width < 4 || box.height < 4) continue;
      await handle.evaluate((el) => {
        const h = el as HTMLElement;
        h.scrollIntoView({ block: "center", inline: "nearest" });
        try {
          h.focus?.();
        } catch {
          /* ignore */
        }
        for (const type of [
          "pointerover",
          "mouseover",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ] as const) {
          h.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window }),
          );
        }
        h.click();
      });
      await sleep(500);
      let selected = await readSelectedRating(frame);
      if (selected === rating) {
        return { ok: true, via: "s2xyy-exact", selected, detail: sel.slice(0, 70) };
      }
      // Click chuột CDP theo box
      await handle.click({ delay: 70 }).catch(() => undefined);
      await sleep(600);
      selected = await readSelectedRating(frame);
      if (selected === rating) {
        return { ok: true, via: "s2xyy-mouse", selected, detail: sel.slice(0, 70) };
      }
      // Đọc radiogroup data-rating (Maps VI hay set ở đây)
      const groupVal = await frame
        .evaluate(() => {
          const g =
            document.querySelector(
              '[role="radiogroup"][aria-label*="Xếp hạng" i], div.lv4IMd[role="radiogroup"]',
            ) || document.querySelector('[role="radiogroup"]');
          return g ? Number(g.getAttribute("data-rating") || 0) : 0;
        })
        .catch(() => 0);
      if (groupVal === rating) {
        return {
          ok: true,
          via: "s2xyy-group",
          selected: groupVal,
          detail: sel.slice(0, 70),
        };
      }
      return {
        ok: true,
        via: "s2xyy-clicked",
        selected,
        detail: sel.slice(0, 70),
      };
    } catch {
      /* next */
    }
  }

  // 1) Fallback evaluate + fire()
  return frame.evaluate(
    (want, labels) => {
      const fire = (el: Element) => {
        const h = el as HTMLElement;
        h.scrollIntoView({ block: "center", inline: "nearest" });
        try {
          h.focus?.();
        } catch {
          /* ignore */
        }
        for (const type of [
          "pointerover",
          "mouseover",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ] as const) {
          h.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window }),
          );
        }
        try {
          h.click();
        } catch {
          /* ignore */
        }
      };

      const labelOf = (el: Element) =>
        (
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("title") || "")
        ).trim();

      const matchRatingLabel = (label: string, n: number) => {
        const raw = (label || "").trim();
        if (!raw) return false;
        const t = raw
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const words: Record<number, string[]> = {
          1: ["mot sao", "one star", "1 sao", "1 star"],
          2: ["hai sao", "two star", "2 sao", "2 star"],
          3: ["ba sao", "three star", "3 sao", "3 star"],
          4: ["bon sao", "four star", "4 sao", "4 star"],
          5: ["nam sao", "five star", "5 sao", "5 star"],
        };
        if ((words[n] || []).some((w) => t === w || t.startsWith(w + " "))) return true;
        return new RegExp(`\\b${n}\\s*(sao|stars?)\\b`, "i").test(raw);
      };

      const readSelected = (): number | null => {
        const groups = Array.from(
          document.querySelectorAll(
            '[role="radiogroup"][aria-label*="Xếp hạng" i], [role="radiogroup"][aria-label*="star" i], div.lv4IMd[role="radiogroup"]',
          ),
        );
        for (const g of groups) {
          const v = Number(g.getAttribute("data-rating") || 0);
          if (v >= 1 && v <= 5) return v;
        }
        const checked = document.querySelector(
          '[role="radio"][aria-checked="true"], .s2xyy[aria-checked="true"]',
        ) as HTMLElement | null;
        if (checked) {
          const d = Number(checked.getAttribute("data-rating"));
          if (d >= 1 && d <= 5) return d;
          for (let n = 5; n >= 1; n--) {
            if (matchRatingLabel(labelOf(checked), n)) return n;
          }
        }
        return null;
      };

      const group =
        document.querySelector('[role="radiogroup"][aria-label*="Xếp hạng" i]') ||
        document.querySelector('div.lv4IMd[role="radiogroup"]') ||
        document.querySelector('[role="radiogroup"]');
      const scope = group || document;

      for (const L of labels as string[]) {
        const el = scope.querySelector(
          `div.s2xyy[role="radio"][aria-label="${L}"], [role="radio"][aria-label="${L}"]`,
        );
        if (el) {
          fire(el);
          return { ok: true, via: "aria-vi", selected: readSelected(), detail: L };
        }
      }
      const byData = scope.querySelector(
        `div.s2xyy[role="radio"][data-rating="${want}"], [role="radio"][data-rating="${want}"]`,
      );
      if (byData) {
        fire(byData);
        return { ok: true, via: "data-rating", selected: readSelected() };
      }
      return { ok: false, via: "none", selected: null as number | null };
    },
    rating,
    viLabels,
  );
}

const CONFIDENT_STAR_VIA =
  /^(data-rating|aria-label|aria-vi|aria-posinset|radiogroup-index|row5|index|s2xyy)/i;

/** Poll đọc sao sau click — Maps cập nhật data-rating radiogroup hơi chậm. */
async function waitSelectedRating(
  frame: Frame,
  want: number,
  timeoutMs = 2500,
): Promise<number | null> {
  const start = Date.now();
  let last: number | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await readSelectedRating(frame);
    if (last === want) return last;
    await sleep(200);
  }
  return last;
}

/** Quét mọi frame (kể cả main) để chọn sao. */
async function selectStar(page: Page, value: number, _human: HumanCursor) {
  const rating = Math.min(5, Math.max(1, Math.round(value)));
  console.log(`[maps-review] selectStar-v5 quét mọi frame (${rating}★)`);
  const waitStart = Date.now();
  let emptyFormRounds = 0;

  // Đã chọn sẵn (vd. vừa bấm sao trên place panel)
  for (const frame of page.frames()) {
    const cur = await readSelectedRating(frame);
    if (cur === rating) {
      console.log(
        `[maps-review] sao đã chọn sẵn ${rating}★ (frame=${frame.url().slice(0, 60)})`,
      );
      return;
    }
  }

  // Chờ UI sao xuất hiện ở bất kỳ frame nào (form thật)
  while (Date.now() - waitStart < 10_000) {
    let found = false;
    for (const frame of page.frames()) {
      const score = await scoreReviewFrame(frame);
      if (score < 40) continue;
      const ok = await frame
        .evaluate(
          () =>
            !!document.querySelector(
              'div[role="radiogroup"], [data-rating], [role="radio"], div.s2xyy',
            ),
        )
        .catch(() => false);
      if (ok) {
        found = true;
        break;
      }
    }
    if (found) break;
    await sleep(350);
  }

  let lastVia = "none";
  let lastDetail = "";
  let confidentHits = 0;

  for (let attempt = 0; attempt < 10; attempt++) {
    // Chỉ click trong frame form review thật (WriteWidget / có textarea).
    const scoredFrames = await Promise.all(
      page.frames().map(async (frame) => ({
        frame,
        score: await scoreReviewFrame(frame),
      })),
    );
    const frames = scoredFrames
      .filter(({ score }) => score >= 40)
      .sort((a, b) => b.score - a.score)
      .map(({ frame }) => frame);

    if (!frames.length) {
      emptyFormRounds += 1;
      if (emptyFormRounds >= 3) {
        throw new Error(
          `Chưa mở được form viết đánh giá (không có WriteWidget/textarea) — không chọn sao được`,
        );
      }
      // Không bấm lại Viết khi đang chờ — dễ đóng modal vừa mở
      await sleep(800);
      continue;
    }
    emptyFormRounds = 0;

    for (const frame of frames) {
      await dismissCancelReviewPrompt(frame).catch(() => undefined);
      await closeInfoPopover(frame).catch(() => undefined);

      // Kiểm tra trước khi click
      let selected = await readSelectedRating(frame);
      if (selected === rating) {
        console.log(
          `[maps-review] chọn ${rating}★ OK (precheck, attempt=${attempt + 1})`,
        );
        return;
      }

      const dom = await clickStarInDom(frame, rating).catch(() => ({
        ok: false as const,
        via: "err",
        selected: null as number | null,
        detail: "evaluate_failed",
      }));
      lastVia = dom.via;
      lastDetail = dom.detail || "";
      await sleep(rand(350, 650));

      // Poll — radiogroup data-rating đổi 0→N sau click (Maps hơi chậm)
      selected =
        (await waitSelectedRating(frame, rating, 2200)) ??
        (await readSelectedRating(frame)) ??
        dom.selected;
      if (selected === rating) {
        console.log(
          `[maps-review] chọn ${rating}★ OK (via=${dom.via}, frame=${frame.url().slice(0, 60)}, attempt=${attempt + 1})`,
        );
        return;
      }

      // Đọc thẳng radiogroup (Maps VI hay set đúng dù aria-checked trống)
      const groupVal = await frame
        .evaluate(() => {
          const g =
            document.querySelector(
              '[role="radiogroup"][aria-label*="Xếp hạng" i], [role="radiogroup"][aria-label*="star" i], div.lv4IMd[role="radiogroup"]',
            ) || document.querySelector('[role="radiogroup"]');
          if (!g) return -1;
          const v = Number(
            g.getAttribute("data-rating") ||
              g.getAttribute("data-value") ||
              g.getAttribute("aria-valuenow") ||
              0,
          );
          return Number.isFinite(v) ? v : -1;
        })
        .catch(() => -1);
      if (groupVal === rating) {
        console.log(
          `[maps-review] chọn ${rating}★ OK (radiogroup data-rating=${groupVal}, via=${dom.via})`,
        );
        return;
      }

      // KHÔNG trust sớm khi selected/group còn null — lần trước tin ảo → Đăng xám
      if (dom.ok && CONFIDENT_STAR_VIA.test(dom.via)) {
        confidentHits += 1;
        console.warn(
          `[maps-review] click ${dom.via} nhưng selected=${selected} group=${groupVal} ≠ ${rating} — thử lại (hit ${confidentHits})`,
        );
      }

      // Mouse click thật theo bounding box (iframe-aware)
      try {
        const handle =
          (await frame.$(
            (VI_STAR_ARIA[rating] || [])
              .map((l) => `[aria-label="${l}"]`)
              .concat([
                `div.s2xyy[role="radio"][data-rating="${rating}"]`,
                `[role="radio"][data-rating="${rating}"]`,
                `[role="radio"][aria-posinset="${rating}"]`,
                `[aria-label="${rating} sao"]`,
                `[aria-label="${rating} stars"]`,
              ])
              .join(", "),
          )) || null;
        if (handle) {
          const box = await handle.boundingBox();
          if (box && box.width > 2 && box.height > 2) {
            await page.mouse.move(
              box.x + box.width / 2,
              box.y + box.height / 2,
              { steps: 4 },
            );
            await sleep(80);
            await page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
              { delay: 70 },
            );
            await sleep(rand(450, 700));
            selected =
              (await waitSelectedRating(frame, rating, 1500)) ??
              (await readSelectedRating(frame));
            if (selected === rating) {
              console.log(
                `[maps-review] chọn ${rating}★ OK (mouse, attempt=${attempt + 1})`,
              );
              return;
            }
            const g2 = await frame
              .evaluate(() => {
                const g =
                  document.querySelector(
                    '[role="radiogroup"][aria-label*="Xếp hạng" i], div.lv4IMd[role="radiogroup"]',
                  ) || document.querySelector('[role="radiogroup"]');
                return g ? Number(g.getAttribute("data-rating") || 0) : 0;
              })
              .catch(() => 0);
            if (g2 === rating) {
              console.log(
                `[maps-review] chọn ${rating}★ OK (mouse+radiogroup, attempt=${attempt + 1})`,
              );
              return;
            }
          }
        }
      } catch {
        /* next frame */
      }

      // Chỉ tin Đăng enable KHI đã đọc đúng sao
      const postEnabled = await frame
        .evaluate(() => {
          const b = document.querySelector(
            'button[jsname="IJM3w"]',
          ) as HTMLButtonElement | null;
          return (
            !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true"
          );
        })
        .catch(() => false);
      if (postEnabled) {
        selected = await readSelectedRating(frame);
        if (selected === rating) {
          console.log(
            `[maps-review] chọn ${rating}★ — Đăng enable + selected verified`,
          );
          return;
        }
      }
    }

    // Thử sao trên dialog main page (Maps đôi khi để radiogroup ngoài iframe)
    if (attempt >= 1) {
      const mainHit = await tryStarsInOpenDialog(page, rating, _human);
      if (mainHit) {
        for (const frame of page.frames()) {
          const sel = await readSelectedRating(frame);
          if (sel === rating) {
            console.log(`[maps-review] chọn ${rating}★ OK (main dialog)`);
            return;
          }
        }
        // Main dialog click có thể mở bước tiếp — chờ selected
        await sleep(800);
        for (const frame of page.frames()) {
          if ((await readSelectedRating(frame)) === rating) {
            console.log(`[maps-review] chọn ${rating}★ OK (main dialog delayed)`);
            return;
          }
        }
      }
    }

    // KHÔNG keyboard.type(rating) — gõ nhầm "5" vào ô bình luận (đã thấy trên UI)

    await sleep(350 + attempt * 120);
  }

  // Dump mọi frame để debug
  const dumps: unknown[] = [];
  for (const frame of page.frames()) {
    const dump = await frame
      .evaluate(() => {
        const labels = Array.from(document.querySelectorAll("[aria-label]"))
          .map((el) => el.getAttribute("aria-label") || "")
          .filter((t) => /sao|star|rating|đánh giá/i.test(t))
          .slice(0, 8);
        return {
          url: location.href.slice(0, 100),
          groups: document.querySelectorAll('div[role="radiogroup"]').length,
          ratings: Array.from(document.querySelectorAll("[data-rating]"))
            .map((el) => el.getAttribute("data-rating"))
            .slice(0, 8),
          radios: document.querySelectorAll('[role="radio"]').length,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          textareas: document.querySelectorAll("textarea").length,
          labels,
          snip: (document.body?.innerText || "").slice(0, 180),
        };
      })
      .catch(() => ({ url: frame.url().slice(0, 80), err: true }));
    dumps.push(dump);
  }
  console.warn(
    `[maps-review] selectStar fail lastVia=${lastVia} detail=${lastDetail} dumps=`,
    JSON.stringify(dumps),
  );
  throw new Error(
    `Không chọn được ${rating} sao (via=${lastVia}; ${JSON.stringify(dumps).slice(0, 500)})`,
  );
}

/**
 * Đóng banner "Bạn có muốn hủy bài đánh giá này không?" → bấm Không.
 * (Thường bị mở do Escape / click nhầm ngoài form — làm nút Đăng xám, không bấm được.)
 */
async function dismissCancelReviewPrompt(frame: Frame) {
  const clicked = await frame.evaluate(() => {
    const body = document.body?.innerText || "";
    if (!/hủy bài đánh giá|cancel (this )?review|want to discard/i.test(body)) {
      return false;
    }
    const nodes = Array.from(
      document.querySelectorAll("button, span, a, div[role='button']"),
    ) as HTMLElement[];
    // Ưu tiên "Không" / No — giữ draft
    const no = nodes.find((el) => {
      const t = (el.textContent || "").trim();
      return /^(Không|No|Keep)$/i.test(t);
    });
    if (no) {
      no.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    console.log('[maps-review] đã bấm "Không" — bỏ hỏi hủy đánh giá');
    await sleep(500);
  }
  return clicked;
}

/**
 * Đóng popover thông tin "Đăng công khai trên Google / Cách bài đăng của bạn…"
 * (bật do hover/click icon ⓘ). Popover này che form → click chuột vào sao/ô nhập
 * bị chặn. Đóng bằng cách bấm lại nút ⓘ đang mở (aria-expanded) — KHÔNG Escape
 * (Escape mở hộp "Hủy bài đánh giá?").
 */
async function closeInfoPopover(frame: Frame): Promise<boolean> {
  try {
    const closed = await frame.evaluate(() => {
      const tip = /Cách bài đăng của bạn|how your (post|contribution)|xuất hiện|được sử dụng/i;
      const bodyText = document.body?.innerText || "";
      if (!tip.test(bodyText)) return false;

      // Nút mở popover thường có aria-expanded="true" + nhãn liên quan "công khai/thông tin"
      const toggles = Array.from(
        document.querySelectorAll('[aria-expanded="true"]'),
      ) as HTMLElement[];
      for (const t of toggles) {
        const label = (t.getAttribute("aria-label") || "") + " " + (t.textContent || "");
        if (/công khai|public|thông tin|info|đăng/i.test(label) || label.trim() === "") {
          t.click();
          return true;
        }
      }
      return false;
    });
    if (closed) {
      console.log('[maps-review] đã đóng popover "Đăng công khai trên Google"');
      await sleep(300);
    }
    return closed;
  } catch {
    return false;
  }
}

/** Không click heading nữa — dễ kích hoạt hộp hủy đánh giá. */
async function prepareReviewForm(frame: Frame) {
  await dismissCancelReviewPrompt(frame);
  await closeInfoPopover(frame);
  await sleep(200);
}

/** Tìm ô nhập trên MỌI frame form review — form Maps hay đổi frame sau khi chọn sao. */
async function enterReview(frame: Frame, text: string, human: HumanCursor) {
  const body = text.trim();
  if (!body) throw new Error("Nội dung đánh giá trống");
  const page = frame.page();
  const frames = await reviewFormFrames(page, frame).catch(() => [frame]);
  const candidates = frames.length ? frames : [frame];
  for (const ctx of candidates) {
    const ok = await enterReviewInFrame(ctx, body, human).catch((e) => {
      console.warn(
        `[maps-review] enterReview frame lỗi: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    });
    if (ok) return;
  }
  throw new Error("Không nhập được bình luận");
}

async function enterReviewInFrame(frame: Frame, body: string, human: HumanCursor) {
  const selectors = [
    'textarea[aria-label="Nhập bài đánh giá"]',
    'textarea[jsname="YPqjbf"]',
    'textarea[placeholder*="trải nghiệm" i]',
    'textarea[placeholder*="Mô tả cụ thể" i]',
    'textarea[aria-label*="đánh giá" i]',
    'textarea[aria-label*="review" i]',
    'textarea[aria-label*="Mô tả" i]',
    'textarea[placeholder*="Mô tả" i]',
    'textarea[placeholder*="experience" i]',
    'textarea[placeholder*="Share" i]',
    "textarea",
    'div[contenteditable="true"][aria-label*="đánh giá" i]',
    'div[contenteditable="true"][aria-label*="review" i]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  const minFilled = Math.min(8, body.length);

  // Chờ ô nhập xuất hiện
  const waitStart = Date.now();
  while (Date.now() - waitStart < 8_000) {
    const has = await frame
      .evaluate(
        () =>
          !!document.querySelector(
            'textarea[aria-label="Nhập bài đánh giá"], textarea[jsname="YPqjbf"], textarea, div[contenteditable="true"], div[role="textbox"]',
          ),
      )
      .catch(() => false);
    if (has) break;
    await sleep(300);
  }

  // Đóng popover ⓘ che form trước khi thao tác
  await closeInfoPopover(frame);
  await dismissCancelReviewPrompt(frame);

  const filledLen = async (sel: string) =>
    frame.evaluate((s) => {
      const el = document.querySelector(s) as
        | HTMLTextAreaElement
        | HTMLElement
        | null;
      if (!el) return 0;
      if ("value" in el && typeof (el as HTMLTextAreaElement).value === "string") {
        return ((el as HTMLTextAreaElement).value || "").trim().length;
      }
      return (el.textContent || "").trim().length;
    }, sel);

  for (const sel of selectors) {
    let el: ElementHandle<Element> | null = null;
    try {
      el = await frame.waitForSelector(sel, { timeout: 4000, visible: true });
    } catch {
      continue;
    }
    if (!el) continue;

    // 1) Focus bằng JS
    await frame
      .evaluate((s) => {
        const ta = document.querySelector(s) as HTMLTextAreaElement | null;
        if (ta) {
          ta.scrollIntoView({ block: "center", inline: "nearest" });
          ta.focus();
        }
      }, sel)
      .catch(() => undefined);

    // 2) Di chuột như người rồi focus lại
    await human.moveToElement(el).catch(() => undefined);
    await human.pause(120, 280);
    await frame
      .evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.focus(), sel)
      .catch(() => undefined);

    // 3) Gõ tay tốc độ random (khôi phục nhịp humanize — không tăng tốc bài dài)
    const page = frame.page();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await sleep(rand(120, 280));
    await page.keyboard.press("Backspace");
    await sleep(rand(150, 350));

    // Ưu tiên human.typeIntoElement (random đầy đủ); fallback vòng gõ tay tương đương
    let typedAll = true;
    try {
      await human.typeIntoElement(el, body);
    } catch {
      const typingDeadline = Date.now() + 180_000;
      for (let i = 0; i < body.length; i++) {
        if (Date.now() > typingDeadline) {
          console.warn("[maps-review] gõ quá 180s — dừng gõ tay, set thẳng nội dung");
          typedAll = false;
          break;
        }
        const ch = body[i]!;
        await page.keyboard.type(ch, { delay: 0 });
        let delay = rand(120, 280);
        if (" .,!?;:\n".includes(ch)) delay += rand(80, 220);
        if (".@_".includes(ch)) delay += rand(60, 160);
        if (i > 0 && i % randInt(5, 12) === 0) delay += rand(200, 550);
        if (body.length > 40 && i === Math.floor(body.length / 2)) {
          delay += rand(300, 700);
        }
        await sleep(delay);
      }
      await sleep(rand(280, 650));
    }

    await frame
      .evaluate((s) => {
        const ta = document.querySelector(s) as HTMLTextAreaElement | null;
        if (!ta) return;
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: ta.value }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      }, sel)
      .catch(() => undefined);
    await sleep(rand(300, 600));

    if (typedAll && (await filledLen(sel)) >= minFilled) {
      console.log(`[maps-review] đã nhập bình luận (gõ tay random)`);
      return true;
    }

    // 4) Fallback cuối: set value trực tiếp
    await frame
      .evaluate(
        (s, val) => {
          const el = document.querySelector(s) as HTMLElement | null;
          if (!el) return;
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            const proto =
              el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, val);
            else (el as HTMLTextAreaElement).value = val;
          } else {
            el.focus();
            el.textContent = val;
          }
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        sel,
        body,
      )
      .catch(() => undefined);
    await sleep(rand(300, 600));
    if ((await filledLen(sel)) >= minFilled) {
      console.log(`[maps-review] đã nhập bình luận (fallback set value)`);
      return true;
    }
  }
  return false;
}

/** Chờ nút Đăng (jsname=IJM3w) sẵn sàng — trước hết đóng hộp hỏi hủy nếu có. */
async function waitPostButtonEnabled(frame: Frame, rating: number, timeoutMs = 45_000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    await dismissCancelReviewPrompt(frame);

    const state = await frame.evaluate(() => {
      const cancelOpen = /hủy bài đánh giá|cancel (this )?review|want to discard/i.test(
        document.body?.innerText || "",
      );
      const b = document.querySelector(
        'button[jsname="IJM3w"]',
      ) as HTMLButtonElement | null;
      if (!b) return { found: false, enabled: false, cancelOpen };
      const disabled =
        b.disabled ||
        b.getAttribute("aria-disabled") === "true" ||
        b.hasAttribute("disabled");
      // Material đôi khi không set disabled attr nhưng form đang hỏi hủy → coi như chưa sẵn
      return { found: true, enabled: !disabled && !cancelOpen, cancelOpen };
    });

    if (state.found && state.enabled) return true;

    attempt += 1;
    if (attempt === 6 || attempt === 12 || attempt === 20) {
      await clickStarInDom(frame, rating).catch(() => undefined);
      await frame.evaluate(() => {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
        if (ta) {
          ta.focus();
          ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: ta.value }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }).catch(() => undefined);
    }
    await sleep(500);
  }
  return false;
}

/** Cuộn form/iframe để nút Đăng (jsname=IJM3w) lộ ra — footer .CjDtQ / .kEocrb. */
async function scrollPostButtonIntoView(frame: Frame) {
  await frame.evaluate(() => {
    const btn =
      (document.querySelector('button[jsname="IJM3w"]') as HTMLElement | null) ||
      ([...document.querySelectorAll("button")].find((b) =>
        /^Đăng$/i.test(
          (b.querySelector('[jsname="V67aGc"]')?.textContent || b.textContent || "").trim(),
        ),
      ) as HTMLElement | undefined) ||
      null;
    if (!btn) return;

    // Cuộn mọi ancestor overflow trước
    let node: HTMLElement | null = btn;
    while (node) {
      const style = window.getComputedStyle(node);
      const oy = style.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        node.scrollHeight > node.clientHeight + 8
      ) {
        const nr = node.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        node.scrollTop += br.top - nr.top - nr.height * 0.4;
      }
      node = node.parentElement;
    }

    // Footer chứa Huỷ / Đăng
    const footer =
      (btn.closest(".CjDtQ, .LxeJme, .kEocrb") as HTMLElement | null) ||
      (document.querySelector(".CjDtQ.LxeJme") as HTMLElement | null);
    footer?.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" as ScrollBehavior });
    btn.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant" as ScrollBehavior,
    });
  });
  await sleep(rand(200, 350));

  const page = frame.page();
  // Cuộn chuột: xuống một chút rồi lên để lộ thanh Đăng (như thao tác tay)
  await page.mouse.wheel({ deltaY: 180 }).catch(() => undefined);
  await sleep(120);
  await page.mouse.wheel({ deltaY: -280 }).catch(() => undefined);
  await sleep(150);
  await page.mouse.wheel({ deltaY: -160 }).catch(() => undefined);
  await sleep(200);
}

async function clickPostButton(frame: Frame, human: HumanCursor): Promise<boolean> {
  // DOM chuẩn Maps VI: button[jsname=IJM3w] > span[jsname=V67aGc] "Đăng"
  let handle =
    (await frame.$('button[jsname="IJM3w"]')) ||
    (await frame.$('button.nCP5yc[jsname="IJM3w"]'));
  if (!handle) {
    // Fallback theo text
    const handles = await frame.$$("button");
    for (const h of handles) {
      const t = await h
        .evaluate(
          (el) =>
            (
              el.querySelector('[jsname="V67aGc"]')?.textContent ||
              el.textContent ||
              ""
            ).trim(),
        )
        .catch(() => "");
      if (/^Đăng$/i.test(t)) {
        handle = h;
        break;
      }
    }
  }
  // Không throw — sau Đăng thành công nút biến mất (form đóng)
  if (!handle) return false;

  await scrollPostButtonIntoView(frame).catch(() => undefined);
  const box = await handle.boundingBox().catch(() => null);
  if (box && box.height >= 2 && box.width >= 2) {
    try {
      await human.clickElement(handle);
      return true;
    } catch {
      /* fallback */
    }
    try {
      await frame.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        delay: 60,
      });
      return true;
    } catch {
      /* evaluate */
    }
  }

  const clicked = await frame
    .evaluate(() => {
      const btn =
        (document.querySelector('button[jsname="IJM3w"]') as HTMLElement | null) ||
        ([...document.querySelectorAll("button")].find((b) =>
          /^Đăng$/i.test(
            (b.querySelector('[jsname="V67aGc"]')?.textContent || b.textContent || "").trim(),
          ),
        ) as HTMLElement | undefined);
      if (!btn) return false;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.focus();
      btn.click();
      btn.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
      );
      return true;
    })
    .catch(() => false);
  return clicked;
}

/** Nút Đăng có thể nằm ở frame khác sau khi form đổi bước — tìm đúng frame trước. */
async function resolveSubmitFrame(frame: Frame): Promise<Frame> {
  const page = frame.page();
  const frames = await reviewFormFrames(page, frame).catch(() => [frame]);
  for (const ctx of frames.length ? frames : [frame]) {
    const btn = await ctx.$('button[jsname="IJM3w"]').catch(() => null);
    if (btn) return ctx;
  }
  return frame;
}

/** Form/nút Đăng đã đóng sau bấm Đăng → coi như đã submit. */
async function reviewFormClosedAfterPost(frame: Frame): Promise<boolean> {
  const page = frame.page();
  for (const ctx of [frame, ...page.frames()]) {
    const state = await ctx
      .evaluate(() => {
        const post = document.querySelector('button[jsname="IJM3w"]');
        const ta =
          document.querySelector('textarea[aria-label="Nhập bài đánh giá"]') ||
          document.querySelector('textarea[jsname="YPqjbf"]') ||
          document.querySelector("textarea");
        const writing = /LoadWriteWidget|writereview|WriteWidget/i.test(
          location.href || "",
        );
        const thanks = /cảm ơn|thank you|đã đăng|posted/i.test(
          document.body?.innerText || "",
        );
        return {
          hasPost: !!post,
          hasTa: !!ta,
          writing,
          thanks,
        };
      })
      .catch(() => null);
    if (!state) continue;
    if (state.thanks) return true;
    // Nút Đăng + textarea biến mất → form đã đóng sau submit
    if (!state.hasPost && !state.hasTa && !state.writing) return true;
    if (!state.hasPost && !state.hasTa) return true;
  }
  // Iframe WriteWidget biến mất trên page
  const stillWidget = page.frames().some((f) =>
    /LoadWriteWidget|writereview|WriteWidget/i.test(f.url() || ""),
  );
  const anyPost = await page
    .frames()
    .reduce(async (prev, f) => {
      if (await prev) return true;
      return !!(await f.$('button[jsname="IJM3w"]').catch(() => null));
    }, Promise.resolve(false));
  return !stillWidget && !anyPost;
}

async function submitReview(frame: Frame, rating: number, human: HumanCursor) {
  frame = await resolveSubmitFrame(frame);
  await prepareReviewForm(frame);
  const ready = await waitPostButtonEnabled(frame, rating, 45_000);
  if (!ready) {
    throw new Error(
      'Nút Đăng chưa sẵn sàng (có thể đang hỏi "Hủy bài đánh giá?" hoặc thiếu sao/nội dung)',
    );
  }

  await dismissCancelReviewPrompt(frame);

  // Cuộn lộ footer Huỷ/Đăng TRƯỚC khi bấm
  await scrollPostButtonIntoView(frame);
  await sleep(rand(200, 400));

  const ok1 = await clickPostButton(frame, human);
  console.log(`[maps-review] bấm Đăng lần 1 ok=${ok1}`);
  if (!ok1) {
    throw new Error("Không tìm thấy nút Đăng (jsname=IJM3w)");
  }
  await sleep(rand(600, 1000));

  // Đã Đăng xong → form/nút biến mất = thành công (đừng bấm lần 2 rồi báo lỗi)
  if (await reviewFormClosedAfterPost(frame)) {
    console.log("[maps-review] form Đăng đã đóng sau lần 1 — coi như đã đăng");
    return;
  }

  // Form còn → thử lần 2 (cuộn lại)
  const stillHasPost = await frame.$('button[jsname="IJM3w"]').catch(() => null);
  if (!stillHasPost) {
    console.log("[maps-review] không còn nút Đăng sau lần 1 — OK");
    return;
  }

  await scrollPostButtonIntoView(frame);
  await dismissCancelReviewPrompt(frame);
  const ok2 = await clickPostButton(frame, human);
  console.log(`[maps-review] bấm Đăng lần 2 (sau cuộn) ok=${ok2}`);
  await sleep(500);
  if (await reviewFormClosedAfterPost(frame)) {
    console.log("[maps-review] form Đăng đã đóng sau lần 2 — OK");
    return;
  }
  if (!ok2) {
    // Nút mất giữa chừng = đã đăng, không throw
    console.warn(
      "[maps-review] lần 2 không bấm được nhưng form có thể đã đóng — tiếp tục xác minh",
    );
    return;
  }

  await sleep(400);
  if (await dismissCancelReviewPrompt(frame)) {
    await sleep(300);
    if (await frame.$('button[jsname="IJM3w"]').catch(() => null)) {
      await scrollPostButtonIntoView(frame);
      await clickPostButton(frame, human);
    }
  }
}

async function countReviewPhotos(frame: Frame): Promise<number> {
  try {
    return await frame.evaluate(() => {
      const roots: ParentNode[] = [];
      for (const s of [
        '[role="dialog"]',
        '[aria-modal="true"]',
        'form',
        'body',
      ]) {
        for (const el of Array.from(document.querySelectorAll(s))) {
          if (!roots.includes(el)) roots.push(el);
        }
      }
      if (!roots.includes(document.body)) roots.push(document.body);

      const visible = (el: Element, min = 16) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return (
          r.width >= min &&
          r.height >= min &&
          r.bottom > 0 &&
          r.right > 0 &&
          r.top < (window.innerHeight || 2000) &&
          r.left < (window.innerWidth || 2000)
        );
      };

      const isAddPhotoLabel = (t: string) =>
        /Thêm ảnh|Add photo|Add photos|ảnh và video|Add videos/i.test(t);

      // 1) data-photo-id (Maps chuẩn)
      let best = 0;
      for (const root of roots) {
        const byId = (root as ParentNode).querySelectorAll("[data-photo-id]").length;
        if (byId > best) best = byId;
      }
      if (best > 0) return best;

      // 2) Nút Xóa / Remove / Gỡ trên thumbnail (Maps VI hay dùng nhiều nhãn)
      const removeRe =
        /^(Xóa|Xoá|Gỡ|Remove|Delete|Close)?\s*(ảnh|photo|hình|image|video)?$/i;
      const removeLoose =
        /Xóa ảnh|Xoá ảnh|Gỡ ảnh|Remove photo|Delete photo|Remove image|Xóa hình|Close photo|Bỏ ảnh/i;
      const removeBtns = Array.from(
        document.querySelectorAll(
          "button, [role='button'], div[aria-label], span[aria-label], [jsaction]",
        ),
      ).filter((el) => {
        if (!visible(el, 8)) return false;
        const label = (
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("title") || "") +
          " " +
          (el.getAttribute("data-tooltip") || "")
        ).trim();
        if (!label) return false;
        if (isAddPhotoLabel(label)) return false;
        return removeLoose.test(label) || removeRe.test(label);
      });
      if (removeBtns.length > best) best = removeBtns.length;
      if (best > 0) return best;

      // 3) Vùng gần nút "Thêm ảnh và video": đếm ô thumbnail (có X / img / bg)
      const addNodes = Array.from(
        document.querySelectorAll(
          'div[jsname="kZV5qc"], div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button, div[role="button"], div[jsname]',
        ),
      ).filter((el) => {
        const t =
          ((el as HTMLElement).getAttribute("aria-label") || "") +
          " " +
          ((el as HTMLElement).textContent || "");
        return isAddPhotoLabel(t);
      }) as HTMLElement[];

      for (const add of addNodes) {
        // Leo lên vài cấp để lấy hàng thumbnail + nút Thêm ảnh
        let section: HTMLElement | null = add;
        for (let i = 0; i < 6 && section; i++) {
          const kids = Array.from(section.children) as HTMLElement[];
          const tiles = kids.filter((k) => {
            if (k === add || k.contains(add)) return false;
            const t =
              (k.getAttribute("aria-label") || "") + " " + (k.textContent || "");
            if (isAddPhotoLabel(t)) return false;
            const r = k.getBoundingClientRect();
            // Thumbnail Maps thường ~48–200px
            if (r.width < 36 || r.height < 36 || r.width > 280 || r.height > 280) {
              return false;
            }
            if (!visible(k, 36)) return false;
            const hasMedia =
              !!k.querySelector(
                "img, canvas, video, [style*='background-image'], [data-photo-id]",
              ) ||
              /url\(/i.test(k.getAttribute("style") || "") ||
              !!k.querySelector(
                "button, [role='button'], [aria-label*='Xóa' i], [aria-label*='Remove' i], [aria-label*='Gỡ' i]",
              );
            // Ô vuông/chữ nhật gần nhau trong hàng ảnh
            const ratio = r.width / Math.max(1, r.height);
            return hasMedia || (ratio > 0.55 && ratio < 1.8);
          });
          if (tiles.length > best) best = tiles.length;

          // Đếm img / canvas trực tiếp trong section
          const medias = Array.from(
            section.querySelectorAll(
              "img, canvas, video, [data-photo-id], div[style*='background-image']",
            ),
          ).filter((el) => {
            if (!visible(el, 36)) return false;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width > 280 || r.height > 280) return false;
            // Bỏ icon nhỏ / avatar siêu nhỏ
            if (r.width < 40 || r.height < 40) return false;
            const src =
              (el as HTMLImageElement).src ||
              el.getAttribute("src") ||
              el.getAttribute("style") ||
              "";
            // Bỏ logo/star icon chung nếu quá nhỏ đã lọc
            if (/maps\/vt|gstatic\.com\/images\/branding|favicon/i.test(src)) {
              return false;
            }
            return true;
          });
          // Unique by gần vị trí
          const uniq: Element[] = [];
          for (const m of medias) {
            const r = (m as HTMLElement).getBoundingClientRect();
            if (
              uniq.some((u) => {
                const ur = (u as HTMLElement).getBoundingClientRect();
                return Math.abs(ur.left - r.left) < 12 && Math.abs(ur.top - r.top) < 12;
              })
            ) {
              continue;
            }
            uniq.push(m);
          }
          if (uniq.length > best) best = uniq.length;
          section = section.parentElement;
        }
      }
      if (best > 0) return best;

      // 4) Fallback toàn form: img blob/googleusercontent kích thước thumbnail
      const imgs = Array.from(
        document.querySelectorAll(
          'img[src*="blob:"], img[src^="data:image"], img[src*="googleusercontent"], img[src*="lh3.google"], img[src*="ggpht"], img[src*="google.com"]',
        ),
      ) as HTMLImageElement[];
      const previewImgs = imgs.filter((img) => {
        if (!visible(img, 40)) return false;
        const r = img.getBoundingClientRect();
        return r.width <= 260 && r.height <= 260;
      });
      if (previewImgs.length > best) best = previewImgs.length;

      // 5) Nút X nhỏ góc thumbnail (không có aria) — đếm cụm ô cạnh Thêm ảnh theo vị trí
      if (addNodes[0]) {
        const addBox = addNodes[0].getBoundingClientRect();
        const candidates = Array.from(
          document.querySelectorAll("div, button, span, img, canvas"),
        ).filter((el) => {
          if (addNodes.some((a) => a === el || a.contains(el))) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 48 || r.height < 48 || r.width > 220 || r.height > 220) {
            return false;
          }
          // Cùng hàng / gần nút Thêm ảnh (thường bên trái hoặc cùng strip)
          const sameRow = Math.abs(r.top - addBox.top) < 80;
          const near =
            r.bottom > addBox.top - 40 &&
            r.top < addBox.bottom + 120 &&
            r.right > 0;
          if (!sameRow && !near) return false;
          const ratio = r.width / Math.max(1, r.height);
          return ratio > 0.5 && ratio < 2.2;
        });
        // Dedup overlapping
        const tiles: DOMRect[] = [];
        for (const el of candidates) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (
            tiles.some(
              (t) => Math.abs(t.left - r.left) < 20 && Math.abs(t.top - r.top) < 20,
            )
          ) {
            continue;
          }
          tiles.push(r);
        }
        if (tiles.length > best) best = tiles.length;
      }

      return best;
    });
  } catch {
    return 0;
  }
}

/** Dump DOM ảnh để debug khi đếm = 0 dù đã accept file. */
async function dumpPhotoDom(page: Page, frame: Frame) {
  const dumps: unknown[] = [];
  const frames = [
    ...new Set([frame, page.mainFrame(), ...(await reviewFormFrames(page, frame))]),
  ];
  for (const ctx of [...frames, ...page.frames()].slice(0, 12)) {
    const dump = await ctx
      .evaluate(() => {
        const labels = Array.from(document.querySelectorAll("[aria-label]"))
          .map((el) => el.getAttribute("aria-label") || "")
          .filter((t) => /ảnh|photo|image|xóa|remove|gỡ|thêm/i.test(t))
          .slice(0, 12);
        const imgs = Array.from(document.querySelectorAll("img"))
          .map((img) => {
            const r = img.getBoundingClientRect();
            return {
              w: Math.round(r.width),
              h: Math.round(r.height),
              src: (img.src || "").slice(0, 60),
            };
          })
          .filter((x) => x.w >= 20 && x.h >= 20)
          .slice(0, 10);
        return {
          url: location.href.slice(0, 90),
          photoIds: document.querySelectorAll("[data-photo-id]").length,
          addBtn: !!document.querySelector(
            'div[jsname="kZV5qc"], div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf',
          ),
          fileInputs: document.querySelectorAll('input[type="file"]').length,
          labels,
          imgs,
        };
      })
      .catch(() => null);
    if (dump) dumps.push(dump);
  }
  console.warn(`[maps-review] photo-dom dump: ${JSON.stringify(dumps).slice(0, 1800)}`);
}

/** Đếm ảnh trên mọi frame (form + main + WriteWidget). */
async function countReviewPhotosAnywhere(page: Page, prefer?: Frame | null) {
  let best = 0;
  const seen = new Set<Frame>();
  const tryOne = async (ctx: Frame) => {
    if (seen.has(ctx)) return;
    seen.add(ctx);
    const n = await countReviewPhotos(ctx).catch(() => 0);
    if (n > best) best = n;
  };
  if (prefer) await tryOne(prefer);
  for (const ctx of await reviewFormFrames(page, prefer)) await tryOne(ctx);
  await tryOne(page.mainFrame());
  // Quét mọi frame — thumbnail đôi khi nằm frame khác WriteWidget
  for (const ctx of page.frames()) await tryOne(ctx);
  return best;
}

/** Frame form review — ưu tiên widget WriteWidget / có textarea. */
async function reviewFormFrames(page: Page, prefer?: Frame | null): Promise<Frame[]> {
  const scored = await Promise.all(
    page.frames().map(async (frame) => ({
      frame,
      score: await scoreReviewFrame(frame),
    })),
  );
  const ordered = scored
    .filter(({ score }) => score >= 25)
    .sort((a, b) => b.score - a.score)
    .map(({ frame }) => frame);
  if (prefer && !ordered.includes(prefer)) ordered.unshift(prefer);
  // Luôn thử cả WriteWidget / bscframe dù score thấp
  for (const f of page.frames()) {
    if (/LoadWriteWidget|writereview|WriteWidget|bscframe/i.test(f.url() || "")) {
      if (!ordered.includes(f)) ordered.push(f);
    }
  }
  return [...new Set(ordered)];
}

async function clickAddPhotoButton(frame: Frame, page: Page, human?: HumanCursor) {
  for (const ctx of await reviewFormFrames(page, frame)) {
    // DOM chuẩn: div[jsname=kZV5qc] > div.nNzjpf-…-haAclf — text "Thêm ảnh và video"
    const clicked = await ctx
      .evaluate(() => {
        const sels = [
          'div[jsname="kZV5qc"]',
          "div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf",
          'div.jJtFZe[jsname="kZV5qc"]',
          'button[aria-label*="Thêm ảnh" i]',
          'button[aria-label*="Add photo" i]',
          'button[aria-label*="Add photos" i]',
          '[role="button"][aria-label*="Thêm ảnh" i]',
        ];
        for (const s of sels) {
          const el = document.querySelector(s) as HTMLElement | null;
          if (!el) continue;
          const t = (el.getAttribute("aria-label") || "") + " " + (el.textContent || "");
          if (
            /Thêm ảnh|Add photo|ảnh và video|Add photos|Add videos/i.test(t) ||
            s.includes("kZV5qc") ||
            s.includes("haAclf")
          ) {
            el.scrollIntoView({ block: "center", inline: "nearest" });
            el.click();
            return s;
          }
        }
        const btn = [...document.querySelectorAll("button, div[role='button'], div[jsname]")]
          .find((b) =>
            /Thêm ảnh và video|Thêm ảnh|Add photos? and videos?|Add photo/i.test(
              ((b as HTMLElement).getAttribute("aria-label") || "") +
                " " +
                ((b as HTMLElement).textContent || ""),
            ),
          ) as HTMLElement | undefined;
        if (!btn) return null;
        btn.scrollIntoView({ block: "center", inline: "nearest" });
        btn.click();
        return "text-Thêm ảnh và video";
      })
      .catch(() => null);
    if (clicked) {
      console.log(`[maps-review] đã bấm Thêm ảnh (${clicked})`);
      await sleep(rand(350, 600));
      await ctx
        .evaluate(() => {
          const item = [
            ...document.querySelectorAll(
              "button, div[role='menuitem'], div[role='button'], span",
            ),
          ].find((b) =>
            /^(Tải lên|Upload|Browse|Từ máy tính|From (your )?device|Chọn tệp|Choose file)/i.test(
              ((b as HTMLElement).textContent || "").trim(),
            ),
          ) as HTMLElement | undefined;
          item?.click();
          return !!item;
        })
        .catch(() => false);
      return true;
    }
    if (human) {
      const handle = await ctx
        .$(
          'div[jsname="kZV5qc"], div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i]',
        )
        .catch(() => null);
      if (handle) {
        await human.clickElement(handle).catch(() => undefined);
        console.log("[maps-review] đã bấm Thêm ảnh (mouse)");
        await sleep(rand(400, 700));
        return true;
      }
    }
  }
  return false;
}

async function findImageFileInput(frame: Frame, page: Page) {
  const tryFrame = async (ctx: Frame) => {
    const inputs = await ctx.$$('input[type="file"]');
    for (const input of inputs) {
      const meta = await ctx
        .evaluate((el) => {
          if (el.getAttribute("data-binhluan-upload") === "1") {
            return { ok: false, multiple: false, accept: "" };
          }
          const accept = (el.getAttribute("accept") || "").toLowerCase();
          const acceptOk =
            !accept ||
            accept.includes("image") ||
            accept.includes("*") ||
            accept.includes("jfif") ||
            accept.includes("jpeg") ||
            accept.includes("png") ||
            accept.includes("webp") ||
            accept.includes("heic") ||
            accept.includes("video");
          return {
            ok: acceptOk,
            multiple: el.hasAttribute("multiple"),
            accept,
          };
        }, input)
        .catch(() => null);
      if (meta?.ok) {
        return { input, multiple: meta.multiple, frame: ctx, accept: meta.accept };
      }
    }
    return null;
  };

  for (const ctx of await reviewFormFrames(page, frame)) {
    try {
      const hit = await tryFrame(ctx);
      if (hit) {
        console.log(
          `[maps-review] tìm thấy input[type=file] accept=${hit.accept || "(any)"} multiple=${hit.multiple}`,
        );
        return hit;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Chờ preview ảnh — timeout ngắn; FileChooser accept mới là nguồn tin chính. */
async function waitPhotoPreviewIncrease(
  page: Page,
  frame: Frame,
  beforeCount: number,
  minAdded = 1,
  timeoutMs = 18_000,
) {
  const start = Date.now();
  let last = beforeCount;
  while (Date.now() - start < timeoutMs) {
    const count = await countReviewPhotosAnywhere(page, frame);
    last = count;
    if (count >= beforeCount + minAdded) {
      console.log(
        `[maps-review] preview OK ${count} (trước=${beforeCount}, +${count - beforeCount}, chờ=${Date.now() - start}ms)`,
      );
      return { ok: true as const, count, frame };
    }
    await sleep(500);
  }
  return { ok: false as const, count: last, frame };
}

/** Đóng hộp thoại Open — KHÔNG Escape khi đang trong form review (Escape = hỏi hủy). */
async function dismissNativeFileDialog(page: Page, opts?: { allowEscape?: boolean }) {
  if (opts?.allowEscape === false) return;
  const writing = page.frames().some((f) =>
    /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(f.url()),
  );
  if (writing) {
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(200);
}

/**
 * Upload ảnh không để kẹt hộp thoại Windows Open.
 * Ưu tiên input.uploadFile thật; chỉ click "Thêm ảnh" kèm waitForFileChooser + accept.
 */
async function uploadViaInputOrChooser(
  frame: Frame,
  page: Page,
  filePaths: string[],
  human?: HumanCursor,
) {
  const found = await findImageFileInput(frame, page);
  const uploadFrame = found?.frame ?? frame;
  if (found?.input) {
    const toUpload =
      found.multiple || filePaths.length === 1 ? filePaths : [filePaths[0]!];
    await found.input.uploadFile(...toUpload);
    await found.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log(`[maps-review] uploadFile trực tiếp ${toUpload.length} file`);
    return { ok: true as const, frame: uploadFrame };
  }

  // Chưa có input — bấm Thêm ảnh nhưng phải bắt FileChooser ngay, không để dialog treo
  console.log("[maps-review] chưa có input — FileChooser + Thêm ảnh");
  try {
    const client = await page.createCDPSession();
    await client
      .send("Page.setInterceptFileChooserDialog", { enabled: true })
      .catch(() => undefined);
  } catch {
    /* ignore */
  }

  const chooserPromise = page.waitForFileChooser({ timeout: 12_000 }).catch(() => null);
  await sleep(80);
  if (human) {
    await clickAddPhotoButton(frame, page, human);
  } else {
    await clickAddPhotoButton(frame, page);
  }
  const chooser = await chooserPromise;
  if (chooser) {
    console.log(`[maps-review] FileChooser OK — accept ${filePaths.length} file`);
    await chooser.accept(filePaths);
    return { ok: true as const, frame: uploadFrame };
  }

  // Thử lại: tìm input sau click (một số UI tạo input ẩn)
  console.warn("[maps-review] FileChooser không bắt được — thử input sau click");
  await sleep(500);
  const again = await findImageFileInput(frame, page);
  if (again?.input) {
    await again.input.uploadFile(
      ...(again.multiple || filePaths.length === 1 ? filePaths : [filePaths[0]!]),
    );
    await again.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log(`[maps-review] uploadFile sau click Thêm ảnh`);
    return { ok: true as const, frame: again.frame ?? uploadFrame };
  }

  await dismissNativeFileDialog(page);
  return { ok: false as const, frame: uploadFrame };
}

async function addImage(
  frame: Frame,
  page: Page,
  filePath?: string | null,
  _isAdditional = false,
  human?: HumanCursor,
) {
  if (!filePath || !existsSync(filePath)) return false;
  const beforeCount = await countReviewPhotosAnywhere(page, frame);
  // Click Thêm ảnh trước khi tìm input (luồng cũ ổn định)
  if (_isAdditional || !(await findImageFileInput(frame, page))) {
    await clickAddPhotoButton(frame, page, human);
    await sleep(rand(250, 450));
  }
  const upload = await uploadViaInputOrChooser(frame, page, [filePath], human);
  if (!upload.ok) {
    await dismissNativeFileDialog(page);
    return false;
  }
  // Chờ ngắn — nếu accept OK mà đếm chưa kịp vẫn coi thử thêm ở addImages
  const waited = await waitPhotoPreviewIncrease(page, upload.frame, beforeCount, 1, 12_000);
  await dismissNativeFileDialog(page);
  return waited.ok || upload.ok;
}

/** Upload nhiều ảnh ngay sau chọn sao — tin FileChooser/uploadFile, không treo 90s vì đếm DOM. */
async function addImages(
  frame: Frame,
  page: Page,
  filePaths: string[],
  human?: HumanCursor,
): Promise<{ count: number; accepted: boolean }> {
  const missing = filePaths.filter((p) => p && !existsSync(p));
  const existing = filePaths.filter((p) => p && existsSync(p));
  if (missing.length) {
    console.warn(`[maps-review] thiếu file ảnh trên disk: ${missing.join(", ")}`);
  }
  if (!existing.length) return { count: 0, accepted: false };

  await sweepStaleMapsPhotoTemps().catch(() => undefined);

  const prepared: string[] = [];
  const temps: string[] = [];
  let accepted = false;
  try {
    // Chuẩn hóa song song — nhanh hơn làm tuần tự
    const preparedList = await Promise.all(
      existing.map((p) => prepareMapsPhotoForUpload(p)),
    );
    for (const out of preparedList) {
      prepared.push(out.path);
      temps.push(...out.tempPaths);
    }

    console.log(`[maps-review] upload ${prepared.length} ảnh (batch FileChooser)`);

    const beforeCount = 0;

    let found = await findImageFileInput(frame, page);
    if (found?.input) {
      await found.input.uploadFile(
        ...(found.multiple || prepared.length === 1 ? prepared : [prepared[0]!]),
      );
      await found.input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      accepted = true;
      console.log(`[maps-review] uploadFile input sẵn có ${prepared.length} file`);
    } else {
      try {
        const client = await page.createCDPSession();
        await client
          .send("Page.setInterceptFileChooserDialog", { enabled: true })
          .catch(() => undefined);
      } catch {
        /* ignore */
      }
      const chooserPromise = page
        .waitForFileChooser({ timeout: 8_000 })
        .catch(() => null);
      await sleep(40);
      await clickAddPhotoButton(frame, page, human);
      const chooser = await chooserPromise;
      if (chooser) {
        console.log(
          `[maps-review] FileChooser OK — accept ${prepared.length} file`,
        );
        await chooser.accept(prepared);
        accepted = true;
      } else {
        await sleep(400);
        found = await findImageFileInput(frame, page);
        if (found?.input) {
          await found.input.uploadFile(
            ...(found.multiple || prepared.length === 1
              ? prepared
              : [prepared[0]!]),
          );
          await found.input.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          accepted = true;
          console.log(`[maps-review] uploadFile sau Thêm ảnh`);
        }
      }
    }

    if (!accepted) {
      console.warn("[maps-review] chưa accept được file — thử từng ảnh");
      let uploaded = 0;
      for (let i = 0; i < prepared.length; i++) {
        const ok = await addImage(frame, page, prepared[i], i > 0, human);
        if (ok) {
          uploaded += 1;
          accepted = true;
        }
        await sleep(rand(400, 700));
      }
      const finalCount = await countReviewPhotosAnywhere(page, frame);
      return {
        count: Math.max(uploaded, Math.max(0, finalCount - beforeCount)),
        accepted,
      };
    }

    // Accept OK — chờ preview rất ngắn rồi tiếp (Maps gắn thumbnail nền)
    const waited = await waitPhotoPreviewIncrease(
      page,
      found?.frame ?? frame,
      beforeCount,
      prepared.length,
      6_000,
    );
    const added = Math.max(0, waited.count - beforeCount);
    if (waited.ok || added >= prepared.length) {
      console.log(`[maps-review] upload batch OK ${prepared.length} ảnh`);
      return { count: prepared.length, accepted: true };
    }
    if (added > 0) {
      console.log(
        `[maps-review] preview=${waited.count} (thêm=${added}) — accept OK, tiếp tục`,
      );
      return { count: Math.max(added, prepared.length), accepted: true };
    }

    // Đếm DOM = 0 nhưng đã accept — tin upload, không dump/chờ dài
    console.warn(
      `[maps-review] preview đếm=0 nhưng đã accept ${prepared.length} file — tin upload`,
    );
    await sleep(rand(400, 700));
    return { count: prepared.length, accepted: true };
  } finally {
    await sleep(600);
    await cleanupMapsPhotoTemps(temps);
  }
}

/** Chỉ nhận URL review Maps thật — loại gstatic / CSS / widget. */
function isGoodReviewLink(u: string | null | undefined): u is string {
  if (!u || typeof u !== "string") return false;
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (
    /gstatic\.com|googleapis\.com\/.*\.(css|js)|\/_\/mss\/|boq-one-google|OneGoogleWidget|\.(css|js)(\?|$)/i.test(
      s,
    )
  ) {
    return false;
  }
  return /maps\/reviews|\/maps\/contrib\/\d+|local\/reviews|review\/data|maps\.app\.goo\.gl|goo\.gl\/maps|share\.google/i.test(
    s,
  );
}

function normalizeReviewHref(href: string | null | undefined): string | null {
  if (!href || typeof href !== "string") return null;
  let h = href.trim();
  if (!h || h === "#" || h.startsWith("javascript:")) return null;
  if (h.startsWith("//")) h = `https:${h}`;
  else if (h.startsWith("/")) h = `https://www.google.com${h}`;
  return /^https?:\/\//i.test(h) ? h : null;
}

const THANK_YOU_EVAL_BODY = `
  var abs = function(href) {
    if (!href) return null;
    var h = String(href).trim();
    if (!h || h === "#" || h.indexOf("javascript:") === 0) return null;
    if (/^https?:\\/\\//i.test(h)) return h;
    if (h.indexOf("//") === 0) return "https:" + h;
    if (h.charAt(0) === "/") return "https://www.google.com" + h;
    return h;
  };
  var candidates = [];
  var push = function(h) {
    var a = abs(h);
    if (a) candidates.push(a);
  };
  var root = document.querySelector("[data-view-profile-post-link]");
  if (root) push(root.getAttribute("data-view-profile-post-link"));
  var els = document.querySelectorAll("[data-view-profile-post-link], [data-href], [data-url], [data-review-url], [data-share-url]");
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    push(el.getAttribute("data-view-profile-post-link"));
    push(el.getAttribute("data-href"));
    push(el.getAttribute("data-url"));
    push(el.getAttribute("data-review-url"));
    push(el.getAttribute("data-share-url"));
  }
  var anchors = document.querySelectorAll("a[href]");
  for (var j = 0; j < anchors.length; j++) {
    var href = anchors[j].getAttribute("href") || "";
    if (/maps\\/reviews|contrib|local\\/reviews|review\\/data|goo\\.gl|maps\\.app\\.goo\\.gl|share\\.google/i.test(href)) {
      push(href);
    }
  }
  var nodes = document.querySelectorAll("a, button, div[role='button'], span");
  for (var k = 0; k < nodes.length; k++) {
    var n = nodes[k];
    var label = (n.getAttribute("aria-label") || "") + " " + (n.textContent || "");
    if (/xem bài|view (your )?review|view on google|xem trên google|see (your )?review|chia sẻ|share/i.test(label)) {
      push(n.getAttribute("href"));
      push(n.getAttribute("data-href"));
      var nested = n.querySelector && n.querySelector("a[href]");
      if (nested) push(nested.getAttribute("href"));
    }
  }
  var doneBtn = document.querySelector('button[jsname="done-button"]');
  var body = ((document.body && document.body.innerText) || "").slice(0, 4000);
  var thank =
    !!doneBtn ||
    !!document.querySelector("#thank-you-title") ||
    !!root ||
    candidates.length > 0 ||
    /\\+\\d+\\s*điểm/i.test(body) ||
    /cảm ơn|thank you|đã đăng|review (has been )?posted|your review/i.test(body);
  var prefer = null;
  for (var p = 0; p < candidates.length; p++) {
    if (/maps\\/reviews|review\\/data|\\/maps\\/contrib|goo\\.gl|maps\\.app\\.goo\\.gl|share\\.google/i.test(candidates[p])) {
      prefer = candidates[p];
      break;
    }
  }
  var pointsEl = document.querySelector(".xy1tk");
  return {
    has: thank,
    link: prefer || candidates[0] || null,
    all: candidates.slice(0, 12),
    points: pointsEl && pointsEl.textContent ? pointsEl.textContent.trim() : null,
    bodyHit: body.slice(0, 180)
  };
`;

async function tryCaptureLinkByViewReviewClick(
  page: Page,
  ctx: Frame,
): Promise<string | null> {
  try {
    const browser = page.browser();
    const beforePages = await browser.pages();
    const beforeUrls = new Set(beforePages.map((p) => p.url()));

    const clicked = await evalSafe<string | null>(
      ctx,
      `
      var nodes = Array.prototype.slice.call(document.querySelectorAll("a, button, div[role='button'], span[role='button']"));
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var label = ((n.getAttribute("aria-label") || "") + " " + (n.textContent || "")).trim();
        if (!/xem bài|view (your )?review|view on google|xem trên google|see (your )?review|xem đánh giá|chia sẻ|share/i.test(label)) continue;
        var href = n.getAttribute("href");
        if (href && /maps\\/reviews|contrib|local\\/reviews|goo\\.gl/i.test(href)) { n.click(); return href; }
        var a = n.tagName === "A" ? n : (n.querySelector && n.querySelector("a[href]"));
        if (a) {
          var h2 = a.getAttribute("href");
          if (h2) { a.click(); return h2; }
        }
        n.click();
        return "clicked";
      }
      return null;
      `,
    );

    if (!clicked) return null;
    const direct = normalizeReviewHref(
      clicked !== "clicked" ? clicked : null,
    );
    if (isGoodReviewLink(direct)) {
      console.log(`[maps-review] link từ nút Xem/Chia sẻ: ${direct}`);
      return direct;
    }

    await sleep(1800);

    const fromDialog = await evalSafe<string | null>(
      page,
      `
      var abs = function(h) {
        if (!h) return null;
        var s = String(h).trim();
        if (!s) return null;
        if (s.indexOf("//") === 0) s = "https:" + s;
        else if (s.charAt(0) === "/") s = "https://www.google.com" + s;
        return s;
      };
      var inputs = document.querySelectorAll("input[type='text'], input[readonly], input, textarea");
      for (var i = 0; i < inputs.length; i++) {
        var v = abs(inputs[i].value || inputs[i].getAttribute("value"));
        if (v && /maps\\/reviews|\\/maps\\/contrib|goo\\.gl|maps\\.app\\.goo\\.gl|share\\.google/i.test(v) && !/gstatic\\.com|\\/_\\/mss\\//i.test(v)) return v;
      }
      var as = document.querySelectorAll("a[href]");
      for (var j = 0; j < as.length; j++) {
        var h = abs(as[j].getAttribute("href"));
        if (h && /maps\\/reviews|\\/maps\\/contrib|goo\\.gl|maps\\.app\\.goo\\.gl/i.test(h) && !/gstatic\\.com|\\/_\\/mss\\//i.test(h)) return h;
      }
      return null;
      `,
    );
    const dialogNorm = normalizeReviewHref(fromDialog);
    if (
      dialogNorm &&
      (isGoodReviewLink(dialogNorm) ||
        /goo\.gl|share\.google/i.test(dialogNorm))
    ) {
      console.log(`[maps-review] link từ dialog chia sẻ: ${dialogNorm}`);
      return dialogNorm;
    }

    for (const p of await browser.pages()) {
      const u = p.url();
      if (!beforeUrls.has(u) && isGoodReviewLink(u)) {
        console.log(`[maps-review] link từ tab mới: ${u}`);
        return u;
      }
      if (isGoodReviewLink(u)) return u;
    }
    const cur = page.url();
    if (isGoodReviewLink(cur)) return cur;
  } catch (e) {
    console.warn(
      "[maps-review] tryCaptureLinkByViewReviewClick:",
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

/**
 * Bắt màn cảm ơn — dùng evalSafe (tránh __name từ tsx).
 * Commit gốc dùng arrow evaluate; tsx hiện inject __name → fail.
 */
async function finishThankYou(page: Page, timeoutMs = 45_000) {
  const start = Date.now();
  let bestLink: string | null = null;
  let bestPoints: string | null = null;
  let sawThank = false;
  let lastDump = "";

  while (Date.now() - start < timeoutMs) {
    const stillWriting = page.frames().some((f) =>
      /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(f.url()),
    );

    for (const ctx of [page.mainFrame(), ...page.frames()]) {
      try {
        const info = await evalSafe<{
          has: boolean;
          link: string | null;
          all: string[];
          points: string | null;
          bodyHit: string;
        }>(ctx, THANK_YOU_EVAL_BODY);

        if (!info) continue;

        const good =
          (isGoodReviewLink(info.link) && info.link) ||
          info.all?.map(normalizeReviewHref).find((u) => isGoodReviewLink(u)) ||
          null;
        if (good) bestLink = good;
        if (info.points) bestPoints = info.points;
        if (!info.has) continue;
        sawThank = true;
        lastDump = `cands=${info.all?.length || 0} raw=${(info.link || "").slice(0, 90)} body=${(info.bodyHit || "").replace(/\\s+/g, " ").slice(0, 100)}`;

        if (!bestLink) {
          const fromClick = await tryCaptureLinkByViewReviewClick(page, ctx);
          if (fromClick) bestLink = fromClick;
        }

        if (!bestLink && Date.now() - start < 22_000) {
          await sleep(500);
          continue;
        }

        await evalSafe(
          ctx,
          `
          var btn = document.querySelector('button[jsname="done-button"]');
          if (!btn) {
            var buttons = document.querySelectorAll("button");
            for (var i = 0; i < buttons.length; i++) {
              if (/Xong|Done|Đóng|Close/i.test(buttons[i].textContent || "")) { btn = buttons[i]; break; }
            }
          }
          if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          `,
        );
        await sleep(800);
        console.log(
          `[maps-review] bắt được màn cảm ơn link=${bestLink || "n/a"} ${lastDump}`,
        );
        return {
          ok: true as const,
          reviewLink: bestLink,
          pointsText: bestPoints || info.points,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          !/detached|Target closed|Execution context|Cannot find context/i.test(
            msg,
          )
        ) {
          console.warn("[maps-review] finishThankYou frame eval:", msg);
        }
      }
    }

    if (!stillWriting && Date.now() - start > 14_000) {
      console.log(
        `[maps-review] form đánh giá đã đóng — coi như đã đăng (link=${bestLink || "n/a"}, thank=${sawThank}) ${lastDump}`,
      );
      return {
        ok: true as const,
        reviewLink: bestLink,
        pointsText: bestPoints,
      };
    }
    await sleep(500);
  }
  console.log(
    `[maps-review] finishThankYou timeout link=${bestLink || "n/a"} thank=${sawThank} ${lastDump}`,
  );
  return {
    ok: true as const,
    reviewLink: bestLink,
    pointsText: bestPoints,
  };
}

async function resolveReviewLinkFromPlace(
  page: Page,
  placeUrl: string,
  reviewText: string,
): Promise<string | null> {
  const snippet = reviewText.trim().slice(0, 40);
  try {
    await page.goto(placeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await sleep(rand(1500, 2500));
    await openReviewsTab(page).catch(() => undefined);
    await sleep(800);
    for (let i = 0; i < 5; i++) await scrollPlacePanel(page, 240);

    let link = await collectReviewLinkCandidates(page, snippet);
    if (link) {
      console.log(`[maps-review] lấy được reviewLink từ place: ${link}`);
      return link;
    }
    link = await tryShareOwnReviewLink(page);
    if (link) {
      console.log(`[maps-review] lấy được reviewLink từ Chia sẻ: ${link}`);
      return link;
    }
    link = await resolveReviewLinkFromContrib(page, snippet);
    if (link) {
      console.log(`[maps-review] lấy được reviewLink từ contrib: ${link}`);
      return link;
    }
    console.warn("[maps-review] không tìm thấy reviewLink trên place/contrib");
    return null;
  } catch (e) {
    console.warn(
      "[maps-review] resolveReviewLinkFromPlace failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function collectReviewLinkCandidates(
  page: Page,
  snippet: string,
): Promise<string | null> {
  const raw = await evalSafe<string[]>(
    page,
    `
    var snip = a0;
    var out = [];
    var push = function(h) {
      if (!h || typeof h !== "string") return;
      var s = h.trim();
      if (!s || s === "#" || s.indexOf("javascript:") === 0) return;
      if (s.indexOf("//") === 0) s = "https:" + s;
      else if (s.charAt(0) === "/") s = "https://www.google.com" + s;
      if (!/^https?:\\/\\//i.test(s)) return;
      if (/gstatic\\.com|\\/_\\/mss\\/|boq-one-google|\\.(css|js)(\\?|$)/i.test(s)) return;
      if (!/maps\\/reviews|\\/maps\\/contrib|local\\/reviews|review\\/data|contrib\\/\\d+|goo\\.gl|maps\\.app\\.goo\\.gl|share\\.google/i.test(s)) return;
      if (out.indexOf(s) === -1) out.push(s);
    };
    var as = document.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) push(as[i].getAttribute("href"));
    var ds = document.querySelectorAll("[data-href], [data-url], [data-review-url], [data-share-url]");
    for (var d = 0; d < ds.length; d++) {
      push(ds[d].getAttribute("data-href"));
      push(ds[d].getAttribute("data-url"));
      push(ds[d].getAttribute("data-review-url"));
      push(ds[d].getAttribute("data-share-url"));
    }
    var buttons = document.querySelectorAll("button, a, [role='button']");
    for (var b = 0; b < buttons.length; b++) {
      var n = buttons[b];
      var label = (n.getAttribute("aria-label") || "") + " " + (n.textContent || "");
      if (!/Chỉnh sửa bài đánh giá|Edit your review|Đánh giá của bạn|Your review|Chia sẻ|Share/i.test(label)) continue;
      var near = n.closest("div, article, section, li") || n.parentElement;
      if (near) {
        var links = near.querySelectorAll("a[href]");
        for (var L = 0; L < links.length; L++) push(links[L].getAttribute("href"));
      }
      if (n.tagName === "A") push(n.getAttribute("href"));
    }
    if (snip && snip.length >= 8) {
      var nodes = document.querySelectorAll("div, span, p");
      for (var j = 0; j < nodes.length; j++) {
        if ((nodes[j].textContent || "").indexOf(snip) === -1) continue;
        var card = nodes[j].closest("[data-review-id], article, li, .jftiEf") || nodes[j].parentElement;
        if (!card) continue;
        var la = card.querySelectorAll("a[href]");
        for (var k = 0; k < la.length; k++) push(la[k].getAttribute("href"));
      }
    }
    return out;
    `,
    snippet,
  );

  const candidates = Array.isArray(raw)
    ? raw.filter((x) => typeof x === "string")
    : [];
  console.log(
    `[maps-review] collectReviewLinkCandidates n=${candidates.length}` +
      (candidates[0] ? ` first=${candidates[0].slice(0, 80)}` : ""),
  );
  return (
    candidates.find((u) => isGoodReviewLink(u)) ||
    candidates.map(normalizeReviewHref).find((u) => isGoodReviewLink(u)) ||
    null
  );
}

async function tryShareOwnReviewLink(page: Page): Promise<string | null> {
  try {
    const opened = await evalSafe<boolean>(
      page,
      `
      var nodes = Array.prototype.slice.call(document.querySelectorAll("button, a, [role='button'], div[role='button']"));
      var edit = null;
      for (var i = 0; i < nodes.length; i++) {
        var label = (nodes[i].getAttribute("aria-label") || "") + " " + (nodes[i].textContent || "");
        if (/Chỉnh sửa bài đánh giá|Edit your review|Đánh giá của bạn|Your review/i.test(label)) { edit = nodes[i]; break; }
      }
      var root = edit ? (edit.closest("div, article, section, li") || edit.parentElement) : null;
      var scope = root ? Array.prototype.slice.call(root.querySelectorAll("button, a, [role='button'], div[role='button']")) : nodes;
      var share = null;
      for (var s = 0; s < scope.length; s++) {
        var lab = (scope[s].getAttribute("aria-label") || "") + " " + (scope[s].textContent || "");
        if (/^(Chia sẻ|Share)$/i.test((scope[s].textContent || "").trim()) || /chia sẻ|share (review|link)?/i.test(lab)) { share = scope[s]; break; }
      }
      if (!share) return false;
      share.click();
      return true;
      `,
    );
    if (!opened) return null;
    await sleep(1500);
    const fromDialog = await evalSafe<string | null>(
      page,
      `
      var abs = function(h) {
        if (!h) return null;
        var s = String(h).trim();
        if (!s) return null;
        if (s.indexOf("//") === 0) s = "https:" + s;
        else if (s.charAt(0) === "/") s = "https://www.google.com" + s;
        return s;
      };
      var inputs = document.querySelectorAll("input[type='text'], input[readonly], input, textarea");
      for (var i = 0; i < inputs.length; i++) {
        var v = abs(inputs[i].value || inputs[i].getAttribute("value"));
        if (v && /maps\\/reviews|\\/maps\\/contrib|goo\\.gl|maps\\.app\\.goo\\.gl|share\\.google/i.test(v) && !/gstatic\\.com|\\/_\\/mss\\//i.test(v)) return v;
      }
      var as = document.querySelectorAll("a[href]");
      for (var j = 0; j < as.length; j++) {
        var h = abs(as[j].getAttribute("href"));
        if (h && /maps\\/reviews|\\/maps\\/contrib|goo\\.gl|maps\\.app\\.goo\\.gl/i.test(h) && !/gstatic\\.com|\\/_\\/mss\\//i.test(h)) return h;
      }
      return null;
      `,
    );
    const n = normalizeReviewHref(fromDialog);
    if (
      n &&
      (isGoodReviewLink(n) || /goo\.gl|maps\.app\.goo\.gl|share\.google/i.test(n))
    ) {
      return n;
    }
  } catch (e) {
    console.warn(
      "[maps-review] tryShareOwnReviewLink:",
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

async function resolveReviewLinkFromContrib(
  page: Page,
  snippet: string,
): Promise<string | null> {
  try {
    await page.goto("https://www.google.com/maps/contrib/?hl=vi", {
      waitUntil: "domcontentloaded",
      timeout: 40_000,
    });
    await sleep(2000);
    await evalSafe(
      page,
      `
      var tabs = Array.prototype.slice.call(document.querySelectorAll("button, a, [role='tab']"));
      for (var i = 0; i < tabs.length; i++) {
        var label = ((tabs[i].getAttribute("aria-label") || "") + " " + (tabs[i].textContent || "")).trim();
        if (/^(Đánh giá|Reviews)$/i.test(label) || /bài đánh giá|reviews/i.test(label)) { tabs[i].click(); break; }
      }
      `,
    );
    await sleep(1500);
    for (let i = 0; i < 3; i++) {
      await evalSafe(
        page,
        `
        var el = document.querySelector("[role='main']") || document.scrollingElement;
        if (el && "scrollTop" in el) el.scrollTop += 400;
        else window.scrollBy(0, 400);
        `,
      );
      await sleep(400);
    }
    return await collectReviewLinkCandidates(page, snippet);
  } catch (e) {
    console.warn(
      "[maps-review] resolveReviewLinkFromContrib:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function dismissMapsOverlays(page: Page) {
  await page
    .evaluate(() => {
      // Không bấm OK/Đóng/Tiếp tục toàn trang — dễ đụng form viết đánh giá.
      const exact =
        /^(Accept all|Reject all|I agree|Agree|Got it|Đồng ý|Chấp nhận tất cả|Tôi đồng ý|Để sau|Not now|No thanks)$/i;
      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], span"),
      ) as HTMLElement[];
      for (const n of nodes) {
        const t = (n.textContent || "").trim();
        if (exact.test(t)) {
          try {
            n.click();
          } catch {
            /* ignore */
          }
        }
      }
      // Chỉ đóng dialog cookie. Disclaimer "Google không xác minh…" nằm *trong* form viết — không đóng.
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const d of dialogs) {
        const el = d as HTMLElement;
        const text = (el.innerText || "").slice(0, 800);
        const isWriteForm =
          !!el.querySelector(
            'textarea, [role="textbox"], [role="radiogroup"], [role="radio"], button[jsname="IJM3w"], iframe[src*="WriteWidget"], iframe[src*="LoadWriteWidget"], iframe[src*="writereview"], iframe[src*="bscframe"]',
          ) ||
          /viết bài đánh giá|write a review|đăng bài|post review|share more about|không xác minh các bài|Google does not verify|xuất bản|publish|đánh giá của bạn|your review/i.test(
            text,
          );
        if (isWriteForm) continue;

        if (
          !/cookie|Accept all|Reject all|Chúng tôi sử dụng cookie|We use cookies|pháp lý|tiết lộ|publicly|công khai trên Google/i.test(
            text,
          )
        ) {
          continue;
        }
        // Không đóng nếu dialog cũng chứa disclaimer review
        if (/không xác minh|Google does not verify|viết bài đánh giá|write a review/i.test(text)) {
          continue;
        }
        const closeBtn = Array.from(
          d.querySelectorAll("button, [aria-label], [role='button']"),
        ).find((btn) => {
          const a = (btn.getAttribute("aria-label") || "").toLowerCase();
          const t = (btn.textContent || "").trim();
          return (
            /close|đóng|dismiss|got it|accept|đồng ý|chấp nhận/i.test(a + " " + t) ||
            /^(Đóng|Close|Got it|Accept all|Đồng ý|Chấp nhận tất cả)$/i.test(t)
          );
        }) as HTMLElement | undefined;
        if (closeBtn) {
          try {
            closeBtn.click();
          } catch {
            /* ignore */
          }
        }
      }
    })
    .catch(() => undefined);
  await sleep(400);
}

/** Lấy ftid 0x…:0x… từ URL Maps place. */
function extractMapsFtid(placeUrl: string): string | null {
  const m =
    placeUrl.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/) ||
    placeUrl.match(/(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  return m?.[1] ?? null;
}

/** ChIJ place_id từ DOM trang place (writereview cần cái này, không dùng ftid). */
async function extractChijPlaceId(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const html = document.documentElement?.innerHTML || "";
      const patterns = [
        /place_id["']?\s*[:=]\s*["'](ChIJ[^"']+)["']/i,
        /["']placeid["']\s*:\s*["'](ChIJ[^"']+)["']/i,
        /\[\\"placeid\\"\s*,\s*\\"ChIJ/,
        /"(ChIJ[\w-]{22,})"/g,
      ];
      for (const re of patterns.slice(0, 3)) {
        const m = html.match(re);
        if (m?.[1]) return m[1];
      }
      const all = html.match(/"(ChIJ[\w-]{22,})"/g) || [];
      const counts = new Map<string, number>();
      for (const raw of all) {
        const id = raw.slice(1, -1);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      let best: string | null = null;
      let bestN = 0;
      for (const [id, n] of counts) {
        if (n > bestN) {
          best = id;
          bestN = n;
        }
      }
      return best;
    })
    .catch(() => null);
}

/** Snapshot ngay sau khi bấm Viết đánh giá — biết form có nhúc nhích không. */
async function logAfterWriteClick(page: Page, tag: string) {
  const snap = await page
    .evaluate(() => {
      const iframes = Array.from(document.querySelectorAll("iframe"))
        .map((i) => (i.getAttribute("src") || "").slice(0, 100))
        .filter(Boolean)
        .slice(0, 6);
      return {
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        textareas: document.querySelectorAll("textarea").length,
        radios: document.querySelectorAll('[role="radio"]').length,
        writeBtns: Array.from(document.querySelectorAll("button,[role='button']")).filter(
          (b) =>
            /Viết bài đánh giá|Write a review/i.test(
              (b.getAttribute("aria-label") || "") + (b.textContent || ""),
            ),
        ).length,
        snip: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 280),
        iframes,
        url: location.href.slice(0, 120),
      };
    })
    .catch(() => null);
  const frameUrls = page.frames().map((f) => f.url().slice(0, 90));
  console.log(
    `[maps-review] after-write(${tag})=`,
    JSON.stringify({ snap, frameUrls }).slice(0, 900),
  );
}

/** Chẩn đoán vì sao form không mở (đăng nhập / dialog / frame). */
async function diagnoseMissingReviewForm(page: Page): Promise<string> {
  const info = await page
    .evaluate(() => {
      const body = (document.body?.innerText || "").slice(0, 500);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .map((d) => ((d as HTMLElement).innerText || "").slice(0, 120))
        .slice(0, 3);
      const labels = Array.from(document.querySelectorAll("[aria-label]"))
        .map((el) => el.getAttribute("aria-label") || "")
        .filter((t) => /sao|star|đánh giá|review|write|viết|sign in|đăng nhập/i.test(t))
        .slice(0, 10);
      return { body, dialogs, labels, url: location.href.slice(0, 120) };
    })
    .catch(() => ({ body: "", dialogs: [] as string[], labels: [] as string[], url: "" }));
  const frames = page.frames().map((f) => f.url().slice(0, 100));
  return JSON.stringify({ ...info, frames }).slice(0, 900);
}

/**
 * Sau khi bấm Viết đánh giá — thử chọn sao ngay trong dialog vừa mở
 * (Maps hay hiện bước chọn sao trước khi có textarea).
 */
async function tryStarsInOpenDialog(
  page: Page,
  rating: number,
  human: HumanCursor,
): Promise<boolean> {
  const want = Math.min(5, Math.max(1, Math.round(rating)));
  // CHỈ nhãn chữ (Bốn sao / Four stars) — KHÔNG "4 sao" trên page
  // (dễ trúng rating place / histogram → click ngoài = đóng modal).
  const wordLabels = (VI_STAR_ARIA[want] || []).filter(
    (l) => !/^\d+\s*(sao|stars?)$/i.test(l.trim()),
  );

  // Ưu tiên click trong iframe WriteWidget (sao thật nằm đây)
  for (const frame of page.frames()) {
    const url = frame.url() || "";
    if (!/LoadWriteWidget|writereview|WriteWidget/i.test(url)) continue;
    const hit = await frame
      .evaluate((wantStar, labels) => {
        const radios = Array.from(
          document.querySelectorAll('[role="radiogroup"] [role="radio"]'),
        ) as HTMLElement[];
        if (radios.length < 5) return null;
        for (const L of labels as string[]) {
          const el = document.querySelector(
            `[role="radio"][aria-label="${L}"], [aria-label="${L}"]`,
          ) as HTMLElement | null;
          if (el) {
            el.click();
            return L;
          }
        }
        const byData = document.querySelector(
          `[role="radio"][data-rating="${wantStar}"]`,
        ) as HTMLElement | null;
        if (byData) {
          byData.click();
          return `data-${wantStar}`;
        }
        const idx = radios[wantStar - 1];
        if (idx) {
          idx.click();
          return `index-${wantStar}`;
        }
        return null;
      }, want, wordLabels)
      .catch(() => null);
    if (hit) {
      await sleep(rand(500, 900));
      console.log(`[maps-review] đã bấm ${want}★ trong WriteWidget (${hit})`);
      return true;
    }
  }

  // Dialog trên main — chỉ radio trong radiogroup ≥5, nhãn chữ VI/EN
  const hit = await page
    .evaluate((wantStar, labels) => {
      const norm = (s: string) =>
        s
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const wantNorms = (labels as string[]).map(norm);
      const groups = Array.from(
        document.querySelectorAll('[role="radiogroup"]'),
      ) as HTMLElement[];
      for (const g of groups) {
        const radios = Array.from(
          g.querySelectorAll('[role="radio"]'),
        ) as HTMLElement[];
        if (radios.length < 5) continue;
        // Phải nằm trong dialog viết / gần WriteWidget — không phải place panel
        const root = g.closest('[role="dialog"]') || g;
        const ctx = ((root as HTMLElement).innerText || "").slice(0, 400);
        const inWrite =
          /không xác minh|write a review|viết bài|đăng|post|your review|bài đánh giá của bạn/i.test(
            ctx,
          ) || !!document.querySelector('iframe[src*="LoadWriteWidget"]');
        if (!inWrite && !g.closest('[role="dialog"]')) continue;

        for (const n of radios) {
          const label = (n.getAttribute("aria-label") || "").trim();
          const t = norm(label);
          if (!wantNorms.some((w) => t === w || t.startsWith(w))) continue;
          const box = n.getBoundingClientRect();
          if (box.width < 8 || box.height < 8) continue;
          n.click();
          return label.slice(0, 40);
        }
        const byData = radios.find(
          (n) => n.getAttribute("data-rating") === String(wantStar),
        );
        if (byData) {
          byData.click();
          return `data-${wantStar}`;
        }
      }
      return null;
    }, want, wordLabels)
    .catch(() => null);
  if (hit) {
    await sleep(rand(500, 900));
    console.log(`[maps-review] đã bấm ${want}★ dialog (safe: ${hit})`);
    return true;
  }
  void human;
  return false;
}

/** Widget review mở nhưng bắt đăng nhập lại (thường do LOGIN IP máy ≠ MAPS proxy). */
async function detectReviewWidgetSignIn(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (/ReviewsWidgetUi\/signin|ServiceLogin|accounts\.google\.com\/v3\/signin/i.test(frame.url())) {
      return true;
    }
  }
  const dom = await page
    .evaluate(() => {
      const ifr = Array.from(document.querySelectorAll("iframe")).some((i) =>
        /ReviewsWidgetUi\/signin|ServiceLogin/i.test(i.getAttribute("src") || ""),
      );
      const body = document.body?.innerText || "";
      return (
        ifr ||
        /Sign in to write a review|Đăng nhập để viết|Sign in to continue/i.test(body)
      );
    })
    .catch(() => false);
  return Boolean(dom);
}

/** Thử vượt màn signin trong widget (chọn account đã login / Continue). */
async function tryPassReviewWidgetSignIn(
  page: Page,
  email?: string | null,
): Promise<boolean> {
  if (!(await detectReviewWidgetSignIn(page))) return true;
  console.log(`[maps-review] WriteWidget đang signin — thử chọn account…`);

  for (const frame of page.frames()) {
    const u = frame.url();
    if (!/ReviewsWidgetUi\/signin|ServiceLogin|accounts\.google/i.test(u)) continue;
    const clicked = await frame
      .evaluate((want) => {
        const nodes = Array.from(
          document.querySelectorAll(
            'div[data-identifier], li, button, div[role="link"], div[role="button"], a',
          ),
        ) as HTMLElement[];
        // Ưu tiên đúng email
        if (want) {
          const hit = nodes.find((n) =>
            (n.getAttribute("data-identifier") || n.textContent || "")
              .toLowerCase()
              .includes(want.toLowerCase()),
          );
          if (hit) {
            hit.click();
            return "email";
          }
        }
        const cont = nodes.find((n) => {
          const t = (n.textContent || "").trim();
          return /^(Continue|Tiếp tục|Next|Tiếp theo|Use another account)$/i.test(t) === false &&
            /Continue|Tiếp tục|Next|@gmail|Choose an account/i.test(t + (n.getAttribute("data-identifier") || ""));
        });
        // Account tile
        const tile = nodes.find((n) => {
          const id = n.getAttribute("data-identifier") || "";
          return /@/.test(id);
        });
        if (tile) {
          tile.click();
          return "tile";
        }
        const btn = nodes.find((n) =>
          /^(Continue|Tiếp tục|Next|Tiếp theo)$/i.test((n.textContent || "").trim()),
        );
        if (btn) {
          btn.click();
          return "continue";
        }
        void cont;
        return null;
      }, email || null)
      .catch(() => null);
    if (clicked) {
      console.log(`[maps-review] đã bấm signin widget via=${clicked}`);
      await sleep(2500);
    }
  }

  // Chờ form thật sau signin
  for (let i = 0; i < 20; i++) {
    if (!(await detectReviewWidgetSignIn(page))) {
      console.log(`[maps-review] đã qua màn signin widget`);
      return true;
    }
    await sleep(500);
  }
  return !(await detectReviewWidgetSignIn(page));
}

/**
 * Xác minh Google session còn sống (trước khi viết review).
 * LOGIN hay chạy IP máy — cookie còn nhưng Maps/proxy có thể bắt login lại.
 */
export async function assertGoogleSessionForMaps(page: Page, email?: string | null): Promise<void> {
  console.log(`[maps-review] kiểm tra session Google…`);
  await page
    .goto("https://myaccount.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    .catch(() => undefined);
  await sleep(1500);
  const info = await page
    .evaluate((wantEmail) => {
      const url = location.href;
      const body = (document.body?.innerText || "").slice(0, 500);
      const signedIn =
        /myaccount\.google\.com/i.test(url) &&
        !/ServiceLogin|signin\/|accounts\.google\.com\/v3\/signin/i.test(url);
      const emailHit = wantEmail
        ? body.toLowerCase().includes(String(wantEmail).toLowerCase()) ||
          !!document.querySelector(
            `[data-email="${wantEmail}"], [aria-label*="${wantEmail}" i]`,
          )
        : signedIn;
      return { url: url.slice(0, 120), signedIn, emailHit, snip: body.slice(0, 160) };
    }, email || null)
    .catch(() => ({ url: "", signedIn: false, emailHit: false, snip: "" }));

  console.log(`[maps-review] session check=`, JSON.stringify(info));
  if (!info.signedIn) {
    throw new Error(
      `Google chưa đăng nhập (đang ở ${info.url || "login"}) — mở profile đăng nhập rồi chạy lại MAPS.`,
    );
  }
  if (email && !info.emailHit) {
    console.warn(
      `[maps-review] session có nhưng không thấy email ${email} trên myaccount — vẫn thử viết review`,
    );
  }
}
async function tryOpenWritereviewUrl(
  page: Page,
  chij: string,
  rating: number,
  human: HumanCursor,
  accountEmail?: string | null,
  waitMs = 35_000,
): Promise<Frame | null> {
  const writeUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(chij)}`;
  console.log(`[maps-review] mở writereview (viết bài mới) ChIJ=${chij}`);
  await page.goto(writeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(rand(1500, 2500));
  await dismissMapsOverlays(page);
  await logAfterWriteClick(page, "writereview");
  if (await detectReviewWidgetSignIn(page)) {
    const ok = await tryPassReviewWidgetSignIn(page, accountEmail);
    if (!ok) {
      throw new Error(
        "Form writereview bắt đăng nhập lại — kiểm tra session Chrome profile.",
      );
    }
  }
  await tryStarsInOpenDialog(page, rating, human);
  try {
    return await waitReviewFrame(page, waitMs);
  } catch {
    return null;
  }
}

async function openWriteReviewForm(
  page: Page,
  placeUrl: string,
  rating: number,
  human: HumanCursor,
  accountEmail?: string | null,
): Promise<Frame> {
  // Đã mở sẵn?
  try {
    return await waitReviewFrame(page, 2_500);
  } catch {
    /* continue */
  }

  await dismissMapsOverlays(page);
  const chijBefore = await extractChijPlaceId(page);
  if (chijBefore) {
    console.log(`[maps-review] place_id ChIJ=${chijBefore}`);
    const viaUrl = await tryOpenWritereviewUrl(
      page,
      chijBefore,
      rating,
      human,
      accountEmail,
    );
    if (viaUrl) return viaUrl;
  }

  console.log(`[maps-review] chưa thấy form — bấm nút Viết bài đánh giá (mới)`);
  const browser = page.browser();
  void browser;
  const frameWait = page
    .waitForFrame(
      (f) => /WriteWidget|writereview|ReviewsService|LoadWriteWidget/i.test(f.url()),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await clickReviewButton(page, human);
  await sleep(rand(2000, 3200));
  // KHÔNG Escape / KHÔNG dismiss overlay ngay sau click — disclaimer
  // "Google không xác minh…" nằm trong form viết; dismiss cũ từng đóng form (= nhìn như "out").
  const attached = await frameWait;
  if (attached) {
    console.log(`[maps-review] bắt được frame form: ${attached.url().slice(0, 100)}`);
  }
  await logAfterWriteClick(page, "1");
  if (await detectReviewWidgetSignIn(page)) {
    const ok = await tryPassReviewWidgetSignIn(page, accountEmail);
    if (!ok) {
      throw new Error(
        "Form đánh giá mở nhưng Google bắt ĐĂNG NHẬP lại trong widget — session không đủ để viết review. Mở Chrome profile, xác nhận đã vào được myaccount.google.com, rồi chạy lại.",
      );
    }
  }
  await tryStarsInOpenDialog(page, rating, human);
  // Chờ dài hơn — proxy chậm, WriteWidget hay attach sau 5–20s
  try {
    return await waitReviewFrame(page, 35_000);
  } catch {
    /* tiếp tục fallback */
  }

  // Nếu iframe/disclaimer vẫn còn — form đang mở, CHỜ thêm (đừng bấm lại / đổi tab = tắt modal)
  const formStillThere = await page
    .evaluate(() => {
      const hasIfr = !!document.querySelector(
        'iframe[src*="LoadWriteWidget"], iframe[src*="WriteWidget"], iframe[src*="writereview"]',
      );
      const body = document.body?.innerText || "";
      return (
        hasIfr ||
        /Google không xác minh|Google does not verify|Nhập bài đánh giá|Một sao|Năm sao|Five stars/i.test(
          body,
        )
      );
    })
    .catch(() => false);
  if (formStillThere) {
    console.log(
      `[maps-review] form vẫn thấy (iframe/disclaimer) — chờ thêm, không bấm lại Viết`,
    );
    try {
      return await waitReviewFrame(page, 25_000);
    } catch {
      /* fallback */
    }
  }

  // Thử lại nút chỉ khi form đã mất hẳn
  console.log(`[maps-review] form chưa mở — thử lại nút Viết đánh giá`);
  await openReviewsTab(page).catch(() => undefined);
  await clickReviewButton(page, human);
  await sleep(2500);
  await logAfterWriteClick(page, "2");
  await tryStarsInOpenDialog(page, rating, human);
  try {
    return await waitReviewFrame(page, 20_000);
  } catch {
    /* fallback writereview URL */
  }

  const diagBeforeNav = await diagnoseMissingReviewForm(page);
  console.warn(`[maps-review] trước writereview diagnose=${diagBeforeNav}`);

  const chij = (await extractChijPlaceId(page)) || chijBefore || null;
  if (chij) {
    const viaUrl = await tryOpenWritereviewUrl(page, chij, rating, human, accountEmail, 20_000);
    if (viaUrl) return viaUrl;
  } else {
    const ftid = extractMapsFtid(placeUrl);
    console.warn(
      `[maps-review] không có ChIJ — bỏ qua writereview ftid (hay 404): ${ftid || "n/a"}`,
    );
  }

  // Quay lại place rồi thử click lần cuối — chờ WriteWidget lâu hơn
  console.log(`[maps-review] quay lại placeUrl rồi bấm Viết đánh giá lần cuối`);
  await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(2000);
  await dismissMapsOverlays(page);
  await openReviewsTab(page).catch(() => undefined);
  const frameWait2 = page
    .waitForFrame(
      (f) => /WriteWidget|writereview|LoadWriteWidget/i.test(f.url()),
      { timeout: 25_000 },
    )
    .catch(() => null);
  await clickReviewButton(page, human);
  await sleep(3000);
  const attached2 = await frameWait2;
  if (attached2) {
    console.log(`[maps-review] frame form lần cuối: ${attached2.url().slice(0, 100)}`);
  }
  await logAfterWriteClick(page, "3-reload");
  await tryStarsInOpenDialog(page, rating, human);
  try {
    return await waitReviewFrame(page, 28_000);
  } catch {
    /* diagnose */
  }

  const diag = await diagnoseMissingReviewForm(page);
  console.warn(`[maps-review] form không mở — diagnose=${diag}`);
  if (/đăng nhập|sign in|log in/i.test(diag) || /đăng nhập|sign in|log in/i.test(diagBeforeNav)) {
    throw new Error(
      "Google yêu cầu đăng nhập để viết đánh giá — kiểm tra session Chrome của profile",
    );
  }
  throw new Error(
    `Không mở được form viết đánh giá sau khi bấm nút (WriteWidget/textarea). ${diag.slice(0, 400)}`,
  );
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const err = new Error("MAPS_REVIEW aborted (timeout/cancel)");
    (err as { code?: string }).code = "ABORTED";
    throw err;
  }
}

async function withStepTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `[maps-review] bước "${label}" treo quá ${Math.round(ms / 1000)}s`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function postMapsReview(
  page: Page,
  payload: MapsReviewPayload,
  opts?: {
    proxy?: ProxyAuth | null;
    /** Đưa Chrome lên foreground — launch (1 lần), window (OS), tab (chỉ tab). */
    keepFocus?: (opts?: { os?: "launch" | "window" | "tab" }) => Promise<void>;
    signal?: AbortSignal;
    accountEmail?: string | null;
    checkSession?: boolean;
  },
): Promise<{
  ok: boolean;
  reviewLink: string | null;
  pointsText: string | null;
  placeUrl: string;
}> {
  await attachProxyAuthToPage(page, opts?.proxy);
  const signal = opts?.signal;
  const keepFocus = async (focusOpts?: { os?: "launch" | "window" | "tab" }) => {
    if (!opts?.keepFocus) return;
    await opts.keepFocus(focusOpts).catch(() => undefined);
  };

  const human = new HumanCursor(page);
  await withStepTimeout("human.init", 15_000, () => human.init());

  assertNotAborted(signal);
  // Luôn kiểm tra session trước khi viết review (tránh WriteWidget → signin)
  if (opts?.checkSession !== false) {
    await withStepTimeout("assertGoogleSession", 50_000, () =>
      assertGoogleSessionForMaps(page, opts?.accountEmail),
    );
    assertNotAborted(signal);
  }

  console.log(`[maps-review] goto placeUrl…`);
  await keepFocus({ os: "launch" });
  // Watchdog: phát hiện Chrome chết ngay sau khi vào Maps
  const chromeDied = () => page.isClosed() || !page.browser().connected;
  await page.goto(payload.placeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  console.log(`[maps-review] place loaded → warmUp`);
  if (chromeDied()) {
    throw new Error(
      "Chrome/tab đã đóng ngay sau khi vào Maps — không phải do proxy (tab bị đóng hoặc process chết)",
    );
  }
  await sleep(rand(800, 1400));
  if (chromeDied()) {
    throw new Error(
      "Chrome/tab chết ~1s sau Maps — khả năng tab-limiter hoặc process kill",
    );
  }
  await keepFocus({ os: "window" });
  await dismissMapsOverlays(page);
  await withStepTimeout("warmUp", 20_000, () => human.warmUp());
  console.log(`[maps-review] warmUp xong`);
  assertNotAborted(signal);

  if (await detectAccountAlreadyReviewedAtPlace(page)) {
    const err = new Error(
      "ALREADY_REVIEWED_AT_PLACE: Mail đã có bình luận tại địa điểm này (Google hiển thị Chỉnh sửa). Chọn mail khác.",
    );
    (err as { code?: string }).code = "ALREADY_REVIEWED_AT_PLACE";
    throw err;
  }

  await keepFocus({ os: "window" });
  assertNotAborted(signal);

  let frame: Frame | null = null;
  let ratedOnPlace = false;

  const chijEarly = await extractChijPlaceId(page);
  if (chijEarly) {
    console.log(
      `[maps-review] thử writereview URL trước (viết bài mới) ChIJ=${chijEarly}`,
    );
    frame = await tryOpenWritereviewUrl(
      page,
      chijEarly,
      payload.rating,
      human,
      opts?.accountEmail,
    );
  }

  if (!frame) {
    console.log(`[maps-review] thử rate trên place panel (${payload.rating}★)`);
    ratedOnPlace = await withStepTimeout("tryRateOnPlacePanel", 25_000, () =>
      tryRateOnPlacePanel(page, payload.rating, human),
    );
    console.log(`[maps-review] ratedOnPlace=${ratedOnPlace}`);
    await sleep(rand(600, 1100));

    try {
      frame = await waitReviewFrame(page, ratedOnPlace ? 8_000 : 2_500);
    } catch {
      frame = null;
    }
  }

  if (!frame) {
    frame = await openWriteReviewForm(
      page,
      payload.placeUrl,
      payload.rating,
      human,
      opts?.accountEmail,
    );
  }
  console.log(`[maps-review] có form frame → selectStar`);
  await keepFocus({ os: "window" });
  assertNotAborted(signal);

  // Chọn / xác nhận sao trên mọi frame (iframe widget + dialog)
  try {
    await selectStar(page, payload.rating, human);
  } catch (e) {
    assertNotAborted(signal);
    if (ratedOnPlace) {
      console.warn(
        `[maps-review] selectStar lỗi nhưng đã bấm sao trên place panel — tiếp tục: ${e instanceof Error ? e.message : e}`,
      );
    } else {
      console.warn(
        `[maps-review] selectStar lần 1 lỗi: ${e instanceof Error ? e.message : e} — mở lại form`,
      );
      // Chỉ bấm lại Viết nếu form đã mất — bấm khi đang mở = tắt modal
      const open = await page
        .evaluate(() => {
          return (
            !!document.querySelector(
              'iframe[src*="LoadWriteWidget"], iframe[src*="WriteWidget"]',
            ) ||
            /Google không xác minh|Nhập bài đánh giá|Một sao|Năm sao/i.test(
              document.body?.innerText || "",
            )
          );
        })
        .catch(() => false);
      if (!open) {
        await clickReviewButton(page, human).catch(() => undefined);
        await sleep(1500);
      } else {
        console.log(`[maps-review] form vẫn mở — không bấm lại Viết, chờ selectStar`);
      }
      frame = await waitReviewFrame(page, 20_000);
      await keepFocus({ os: "window" });
      await selectStar(page, payload.rating, human);
    }
  }
  // Form có thể đổi frame sau khi chọn sao
  frame = await waitReviewFrame(page, 12_000).catch(() => frame);
  await sleep(rand(400, 900));
  await keepFocus({ os: "window" });
  assertNotAborted(signal);

  if (!frame) {
    throw new Error("Không tìm thấy form viết đánh giá sau khi chọn sao");
  }

  const imagePaths =
    payload.imagePaths?.filter(Boolean) ??
    (payload.imagePath ? [payload.imagePath] : []);

  // 1) Upload ảnh NGAY sau chọn sao (trước khi gõ nội dung) — nhanh hơn, Maps gắn thumbnail song song
  let uploadResult = { count: 0, accepted: false };
  if (imagePaths.length) {
    await keepFocus({ os: "window" });
    assertNotAborted(signal);
    frame = (await waitReviewFrame(page, 8_000).catch(() => frame)) ?? frame;
    uploadResult = await addImages(frame, page, imagePaths, human);
    console.log(
      `[maps-review] sau sao → upload ảnh accepted=${uploadResult.accepted} count=${uploadResult.count}/${imagePaths.length}`,
    );
    if (!uploadResult.accepted && uploadResult.count <= 0) {
      throw new Error(
        `Upload ảnh thất bại: không accept được file (${uploadResult.count}/${imagePaths.length})`,
      );
    }
  }

  // 2) Gõ nội dung bình luận (ảnh đang xử lý / đã có trên form)
  try {
    await keepFocus({ os: "tab" });
    frame = (await waitReviewFrame(page, 8_000).catch(() => frame)) ?? frame;
    await enterReview(frame, payload.reviewText, human);
  } catch (e) {
    assertNotAborted(signal);
    console.warn(
      `[maps-review] enterReview lần 1 lỗi: ${e instanceof Error ? e.message : e} — retry`,
    );
    frame = await waitReviewFrame(page, 15_000);
    await keepFocus({ os: "window" });
    await selectStar(page, payload.rating, human).catch(() => undefined);
    await enterReview(frame, payload.reviewText, human);
  }

  // 3) Cuộn + Đăng (jsname=IJM3w)
  await keepFocus({ os: "window" });
  assertNotAborted(signal);
  frame = (await waitReviewFrame(page, 8_000).catch(() => frame)) ?? frame;
  if (uploadResult.accepted || uploadResult.count > 0) {
    console.log(
      `[maps-review] sẵn sàng Đăng — ảnh accepted=${uploadResult.accepted} preview≈${uploadResult.count}`,
    );
    await sleep(rand(400, 700));
  }
  // Bắt URL review từ network (nếu Google trả về trong response)
  let networkLink: string | null = null;
  const onResp = (res: { url: () => string }) => {
    try {
      const u = res.url();
      if (isGoodReviewLink(u)) networkLink = u;
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResp);

  await submitReview(frame, payload.rating, human);
  await keepFocus({ os: "window" });
  const thanks = await finishThankYou(page);
  page.off("response", onResp);

  let reviewLink = thanks.reviewLink || networkLink;
  let ok = thanks.ok;
  let pointsText = thanks.pointsText;

  if (!ok) {
    const verified = await verifyReviewPosted(page, payload.reviewText);
    if (verified) {
      console.log(
        "[maps-review] không bắt màn cảm ơn nhưng review đã xác minh trên place — coi thành công",
      );
      ok = true;
    } else {
      console.warn(
        "[maps-review] không bắt được màn cảm ơn — kiểm tra lại trên Chrome",
      );
    }
  }

  // Thiếu link → scrape lại từ trang place (đánh giá của bạn / card nội dung)
  if (ok && !isGoodReviewLink(reviewLink)) {
    reviewLink = null;
    await keepFocus({ os: "window" });
    reviewLink = await resolveReviewLinkFromPlace(
      page,
      payload.placeUrl,
      payload.reviewText,
    );
  }

  if (!isGoodReviewLink(reviewLink)) reviewLink = null;

  return {
    ok,
    reviewLink,
    pointsText,
    placeUrl: payload.placeUrl,
  };
}
