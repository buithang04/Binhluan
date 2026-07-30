/**
 * Google Maps review automation — form trong iframe ReviewsService.LoadWriteWidget
 */
import type { ElementHandle, Frame, Page } from "puppeteer";
import { existsSync } from "fs";
import type { MapsReviewPayload } from "@apm/shared";
import { attachProxyAuthToPage } from "./proxy-auth.js";
import { HumanCursor } from "./humanize.js";
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

async function clickReviewButton(page: Page, human: HumanCursor) {
  // CHỈ nút viết/chỉnh sửa — KHÔNG dùng jsaction*="review" (dễ trúng Báo/Chia sẻ)
  const selectors = [
    'button.S9kvJb[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Write a review"]',
    'button[aria-label*="Viết bài đánh giá" i]',
    'button[aria-label*="Write a review" i]',
    'button[aria-label*="Chỉnh sửa bài đánh giá" i]',
    'button[aria-label*="Edit your review" i]',
    'button.S9kvJb[aria-label*="đánh giá" i]',
  ];

  const isWriteBtn = (aria: string, text: string) => {
    const t = `${aria} ${text}`;
    if (/Báo bài|Report review|Chia sẻ bài|Share review|Sao chép/i.test(t)) return false;
    return /Viết bài đánh giá|Write a review|Chỉnh sửa bài đánh giá|Edit your review/i.test(
      t,
    );
  };

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
          if (!meta?.visible || !isWriteBtn(meta.aria, meta.text)) continue;

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
            `[maps-review] đã bấm viết đánh giá (${sel} · ${meta.aria.slice(0, 40)})`,
          );
          await sleep(500);
          await dismissSpuriousReviewMenus(page);
          return true;
        }
      } catch {
        /* next */
      }
    }
    // Text trong panel — vẫn lọc Báo/Chia sẻ
    const hit = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, div[role='button']"),
      ) as HTMLElement[];
      const btn = nodes.find((n) => {
        const t = (n.getAttribute("aria-label") || "") + " " + (n.textContent || "");
        if (/Báo bài|Report review|Chia sẻ bài|Share review|Sao chép/i.test(t)) {
          return false;
        }
        return /Viết bài đánh giá|Write a review|Chỉnh sửa bài đánh giá|Edit your review/i.test(
          t,
        );
      });
      if (!btn) return false;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return true;
    });
    if (hit) {
      console.log("[maps-review] đã bấm viết đánh giá (text fallback)");
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

  throw new Error(
    "Không tìm thấy nút Viết/Chỉnh sửa đánh giá — mở tab «Bài đánh giá» hoặc kiểm tra place URL",
  );
}

/** Place đã có review của account (nút Chỉnh sửa) — tránh đăng trùng. */
async function detectExistingReview(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, [role='button'], a"),
    ) as HTMLElement[];
    return nodes.some((n) =>
      /Chỉnh sửa bài đánh giá|Edit your review/i.test(
        (n.getAttribute("aria-label") || "") + " " + (n.textContent || ""),
      ),
    );
  });
}

/** Xác minh review đã lên sau submit (khi không bắt được màn cảm ơn). */
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
                return /Viết bài đánh giá|Write a review|Chỉnh sửa bài đánh giá|Edit your review/i.test(
                  t,
                );
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

      // 1) radiogroup.data-rating: chưa chọn = "0", đã chọn = "1".."5"
      for (const group of Array.from(
        document.querySelectorAll('[role="radiogroup"]'),
      ) as HTMLElement[]) {
        for (const attr of ["data-rating", "data-value", "aria-valuenow"]) {
          const v = Number(group.getAttribute(attr));
          if (v >= 1 && v <= 5) return v;
        }
        // aria-label trên group đôi khi chứa số sao
        const gl = fromLabel(group);
        if (gl) return gl;
      }

      // 2) radio đang checked / selected
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

      // 3) Đếm sao tô màu từ trái → phải trong radiogroup (5 radio)
      for (const group of Array.from(
        document.querySelectorAll('[role="radiogroup"]'),
      )) {
        const radios = Array.from(
          group.querySelectorAll('[role="radio"]'),
        ).filter((el) => el.getAttribute("data-rating") !== "0") as HTMLElement[];
        if (radios.length < 3) continue;
        let filled = 0;
        for (let i = 0; i < radios.length && i < 5; i++) {
          if (isFilledLook(radios[i]!)) filled = i + 1;
          else break; // hàng sao: tô liên tục từ trái
        }
        // Nếu không liên tục, lấy max index đã tô
        if (filled === 0) {
          radios.forEach((el, i) => {
            if (isFilledLook(el)) {
              const r =
                fromLabel(el) ||
                Number(el.getAttribute("data-rating")) ||
                i + 1;
              if (r >= 1 && r <= 5 && r > filled) filled = r;
            }
          });
        }
        if (filled >= 1) return filled;
      }

      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Click sao trong DOM (ưu tiên aria-label VI: Một/Hai/Ba/Bốn/Năm sao).
 */
async function clickStarInDom(
  frame: Frame,
  value: number,
): Promise<{ ok: boolean; via: string; selected: number | null; detail?: string }> {
  const rating = Math.min(5, Math.max(1, Math.round(value)));
  const viLabels = VI_STAR_ARIA[rating] || [`${rating} sao`];

  // 1) Puppeteer handle theo aria-label VI (ổn định hơn evaluate lớn)
  for (const label of viLabels) {
    try {
      const handle =
        (await frame.$(`[role="radio"][aria-label="${label}"]`)) ||
        (await frame.$(`[aria-label="${label}"]`)) ||
        (await frame.$(`button[aria-label="${label}"]`));
      if (!handle) continue;
      const box = await handle.boundingBox();
      if (!box || box.width < 4 || box.height < 4) continue;
      await handle.evaluate((el) => {
        (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
        (el as HTMLElement).click();
      });
      await sleep(600);
      let selected = await readSelectedRating(frame);
      if (selected === rating) {
        return { ok: true, via: "aria-vi", selected, detail: label };
      }
      // Click lần 2 bằng mouse tọa độ
      await handle.click({ delay: 60 }).catch(() => undefined);
      await sleep(700);
      selected = await readSelectedRating(frame);
      // Đã bấm đúng nhãn VI — tin radiogroup / visual; nếu vẫn null thì vẫn báo ok+via để selectStar poll
      return {
        ok: true,
        via: selected === rating ? "aria-vi-mouse" : "aria-vi-clicked",
        selected,
        detail: label,
      };
    } catch {
      /* next label */
    }
  }

  // 2) data-rating đúng số (1..5) — bỏ data-rating=0
  try {
    const byData =
      (await frame.$(`[role="radio"][data-rating="${rating}"]`)) ||
      (await frame.$(`[data-rating="${rating}"]`));
    if (byData) {
      await byData.evaluate((el) => (el as HTMLElement).click());
      await sleep(400);
      const selected = await readSelectedRating(frame);
      if (selected === rating) {
        return { ok: true, via: "data-rating", selected };
      }
    }
  } catch {
    /* continue */
  }

  // 3) Đúng 5 radio trong radiogroup → click theo index
  try {
    const radios = await frame.$$('[role="radiogroup"] [role="radio"]');
    const usable = [];
    for (const r of radios) {
      const dr = await r.evaluate((el) => el.getAttribute("data-rating"));
      if (dr === "0") continue;
      usable.push(r);
    }
    const list = usable.length >= 5 ? usable.slice(0, 5) : radios.slice(0, 5);
    if (list.length >= rating) {
      const target = list[rating - 1]!;
      await target.evaluate((el) => {
        (el as HTMLElement).scrollIntoView({ block: "center" });
        (el as HTMLElement).click();
      });
      await sleep(400);
      const selected = await readSelectedRating(frame);
      return {
        ok: selected === rating,
        via: "radiogroup-index",
        selected,
        detail: `n=${list.length}`,
      };
    }
  } catch {
    /* continue */
  }

  // 4) evaluate fallback (VI label + data-rating)
  try {
    return await frame.evaluate(
      (want, labels) => {
        const fire = (el: Element) => {
          const h = el as HTMLElement;
          h.scrollIntoView({ block: "center", inline: "nearest" });
          try {
            h.focus?.();
          } catch {
            /* ignore */
          }
          h.click();
        };
        const labelOf = (el: Element) =>
          ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).trim();
        const norm = (s: string) =>
          s
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const matchLabel = (label: string) => {
          const t = norm(label);
          for (const L of labels) {
            if (t === norm(L) || t.includes(norm(L))) return true;
          }
          return new RegExp(`\\b${want}\\s*(sao|stars?)\\b`, "i").test(label);
        };
        const readSelected = (): number | null => {
          const checked = document.querySelector(
            '[role="radio"][aria-checked="true"]',
          ) as HTMLElement | null;
          if (!checked) return null;
          const lb = labelOf(checked);
          const t = norm(lb);
          if (/nam sao|five star|\b5\s*sao/.test(t)) return 5;
          if (/bon sao|four star|\b4\s*sao/.test(t)) return 4;
          if (/ba sao|three star|\b3\s*sao/.test(t)) return 3;
          if (/hai sao|two star|\b2\s*sao/.test(t)) return 2;
          if (/mot sao|one star|\b1\s*sao/.test(t)) return 1;
          const d = Number(checked.getAttribute("data-rating"));
          return d >= 1 && d <= 5 ? d : null;
        };

        for (const L of labels) {
          const el = document.querySelector(
            `[role="radio"][aria-label="${L}"], [aria-label="${L}"]`,
          ) as HTMLElement | null;
          if (el) {
            fire(el);
            return { ok: true, via: "aria-label", selected: readSelected(), detail: L };
          }
        }
        const byData = document.querySelector(
          `[role="radio"][data-rating="${want}"], [data-rating="${want}"]`,
        ) as HTMLElement | null;
        if (byData) {
          fire(byData);
          return { ok: true, via: "data-rating", selected: readSelected() };
        }
        const radios = Array.from(
          document.querySelectorAll('[role="radiogroup"] [role="radio"]'),
        ).filter((el) => el.getAttribute("data-rating") !== "0") as HTMLElement[];
        if (radios.length >= want) {
          fire(radios[want - 1]!);
          return { ok: true, via: "index", selected: readSelected() };
        }
        // Quét mọi aria-label
        const hit = Array.from(
          document.querySelectorAll("[aria-label], [role='radio']"),
        ).find((el) => matchLabel(labelOf(el))) as HTMLElement | undefined;
        if (hit) {
          fire(hit);
          return { ok: true, via: "aria-scan", selected: readSelected() };
        }
        return {
          ok: false,
          via: "none",
          selected: null,
          detail: `labels=${labels.slice(0, 3).join("|")}`,
        };
      },
      rating,
      viLabels,
    );
  } catch (e) {
    return {
      ok: false,
      via: "err",
      selected: null,
      detail: e instanceof Error ? e.message.slice(0, 80) : "evaluate_failed",
    };
  }
}

const CONFIDENT_STAR_VIA =
  /^(data-rating|aria-label|aria-vi|aria-vi-mouse|aria-vi-clicked|aria-posinset|aria-scan|radiogroup-index|row5|index)/i;

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

  for (let attempt = 0; attempt < 6; attempt++) {
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

      // Poll — radiogroup data-rating đổi 0→N sau click
      selected =
        (await waitSelectedRating(frame, rating, 2800)) ??
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
          const g = document.querySelector('[role="radiogroup"]');
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

      // Đã click đúng aria-label VI (Một/…/Năm sao) — chấp nhận sớm
      if (dom.ok && /aria-vi/i.test(dom.via) && dom.detail) {
        if (selected != null && selected >= 1 && selected <= 5 && selected === rating) {
          console.log(
            `[maps-review] chọn ${rating}★ OK via=${dom.via} selected=${selected}`,
          );
          return;
        }
        // attempt≥1: đã bấm nhãn VI rõ ràng — tin (tránh loop đóng/mở modal)
        if (attempt >= 1) {
          console.warn(
            `[maps-review] chọn ${rating}★ TRUST "${dom.detail}" (readSelected=${selected}, group=${groupVal})`,
          );
          return;
        }
        console.warn(
          `[maps-review] sau ${dom.via} selected=${selected} group=${groupVal}, muốn ${rating} — thử lại`,
        );
      }

      if (dom.ok && CONFIDENT_STAR_VIA.test(dom.via)) {
        console.warn(
          `[maps-review] click ${dom.via} nhưng selected=${selected} ≠ ${rating} — thử tiếp`,
        );
      }

      // Mouse click thật theo bounding box (iframe-aware)
      try {
        const handle =
          (await frame.$(
            (VI_STAR_ARIA[rating] || [])
              .map((l) => `[aria-label="${l}"]`)
              .concat([
                `[data-rating="${rating}"]`,
                `[role="radio"][aria-posinset="${rating}"]`,
                `[aria-label="${rating} sao"]`,
                `[aria-label="${rating} stars"]`,
              ])
              .join(", "),
          )) || null;
        // Không lấy theo index [rating-1] trên mọi radio — dễ click nhầm nút khác
        if (!handle) {
          const radios = await frame.$$(
            '[role="radiogroup"] [role="radio"], [role="radiogroup"] [data-rating], div[role="radiogroup"] button',
          );
          if (radios.length >= rating) {
            const candidate = radios[rating - 1]!;
            const label = await candidate.evaluate(
              (el) =>
                (el.getAttribute("aria-label") || "") +
                " " +
                (el.getAttribute("data-rating") || ""),
            );
            if (
              !label.trim() ||
              new RegExp(`${rating}\\s*(sao|star)|data-rating.?${rating}|^\\s*${rating}\\s*$`, "i").test(
                label,
              ) ||
              radios.length === 5
            ) {
              const box = await candidate.boundingBox();
              if (box && box.width > 2 && box.height > 2) {
                await page.mouse.click(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                  { delay: 70 },
                );
                await sleep(rand(400, 700));
                selected = await readSelectedRating(frame);
                if (selected === rating) {
                  console.log(
                    `[maps-review] chọn ${rating}★ OK (radiogroup mouse, attempt=${attempt + 1})`,
                  );
                  return;
                }
              }
            }
          }
        }
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
            await sleep(rand(350, 550));
            selected = await readSelectedRating(frame);
            if (selected === rating) {
              console.log(
                `[maps-review] chọn ${rating}★ OK (mouse, attempt=${attempt + 1})`,
              );
              return;
            }
            console.warn(
              `[maps-review] mouse click sao nhưng selected=${selected} ≠ ${rating}`,
            );
          }
        }
      } catch {
        /* next frame */
      }

      // Đăng đã enable → sao đã ăn (một số UI enable sớm)
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
    'textarea[aria-label*="đánh giá" i]',
    'textarea[aria-label*="review" i]',
    'textarea[aria-label*="Mô tả" i]',
    'textarea[placeholder*="trải nghiệm" i]',
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
            'textarea, div[contenteditable="true"], div[role="textbox"]',
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

    // 1) Focus bằng JS trước — bàn phím gõ được kể cả khi có lớp phủ che (overlay
    //    chỉ chặn click chuột, không chặn keyboard vào element đang focus).
    await frame
      .evaluate((s) => {
        const ta = document.querySelector(s) as HTMLTextAreaElement | null;
        if (ta) {
          ta.scrollIntoView({ block: "center", inline: "nearest" });
          ta.focus();
        }
      }, sel)
      .catch(() => undefined);

    // 2) Vẫn di chuột như người (best effort) rồi focus lại (phòng click trúng overlay)
    await human.moveToElement(el).catch(() => undefined);
    await human.pause(80, 200);
    await frame
      .evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.focus(), sel)
      .catch(() => undefined);

    // 3) Xóa nội dung cũ + gõ từng ký tự (nhịp người, bài dài gõ nhanh hơn,
    //    có deadline cứng — quá hạn thì dừng gõ và set thẳng value)
    const page = frame.page();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await sleep(rand(120, 260));
    await page.keyboard.press("Backspace");
    await sleep(rand(150, 320));
    const speed = body.length > 160 ? 0.45 : body.length > 90 ? 0.7 : 1;
    const typingDeadline = Date.now() + 90_000;
    let typedAll = true;
    for (let i = 0; i < body.length; i++) {
      if (Date.now() > typingDeadline) {
        console.warn(
          "[maps-review] gõ quá 90s — dừng gõ tay, set thẳng nội dung",
        );
        typedAll = false;
        break;
      }
      const ch = body[i]!;
      await page.keyboard.type(ch, { delay: 0 });
      let delay = rand(90, 220);
      if (" .,!?;:\n".includes(ch)) delay += rand(60, 180);
      if (i > 0 && i % randInt(6, 12) === 0) delay += rand(150, 420);
      await sleep(delay * speed);
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
      console.log(`[maps-review] đã nhập bình luận (gõ tay, focus JS)`);
      return true;
    }

    // 4) Fallback cuối: set value trực tiếp (textarea hoặc contenteditable)
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

/** Cuộn form/iframe để nút Đăng nằm trong vùng nhìn thấy (ưu tiên cuộn lên/vào giữa). */
async function scrollPostButtonIntoView(frame: Frame) {
  await frame.evaluate(() => {
    const btn = document.querySelector('button[jsname="IJM3w"]') as HTMLElement | null;
    if (!btn) return;

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
        const delta = br.top - nr.top - nr.height * 0.55;
        node.scrollTop += delta;
      }
      node = node.parentElement;
    }

    btn.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant" as ScrollBehavior,
    });
  });
  await sleep(rand(250, 450));

  const page = frame.page();
  // Cuộn chuột lên để lộ footer Đăng (không cuộn xuống trước)
  await page.mouse.wheel({ deltaY: -220 }).catch(() => undefined);
  await sleep(180);
  await page.mouse.wheel({ deltaY: -120 }).catch(() => undefined);
  await sleep(220);
}

async function clickPostButton(frame: Frame, human: HumanCursor) {
  const handle = await frame.$('button[jsname="IJM3w"]');
  if (!handle) throw new Error("Không tìm thấy button[jsname=IJM3w]");
  const box = await handle.boundingBox();
  if (!box || box.height < 2 || box.width < 2) {
    return false;
  }
  await human.clickElement(handle);
  return true;
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

  await clickPostButton(frame, human);
  console.log("[maps-review] bấm Đăng lần 1");
  await sleep(rand(280, 520));

  await scrollPostButtonIntoView(frame);
  await dismissCancelReviewPrompt(frame);

  const ok = await clickPostButton(frame, human);
  if (!ok) {
    await scrollPostButtonIntoView(frame);
    if (!(await clickPostButton(frame, human))) {
      throw new Error("Nút Đăng không click được sau khi cuộn");
    }
  }
  console.log("[maps-review] đã bấm Đăng lần 2 (sau cuộn)");

  await sleep(500);
  if (await dismissCancelReviewPrompt(frame)) {
    await sleep(300);
    await scrollPostButtonIntoView(frame);
    await clickPostButton(frame, human);
  }
}

async function countReviewPhotos(frame: Frame) {
  try {
    return await frame.evaluate(() => {
      const root =
        (document.querySelector('[role="dialog"], [aria-modal="true"]') as HTMLElement | null) ||
        document.body;
      const byId = root.querySelectorAll("[data-photo-id]").length;
      if (byId > 0) return byId;

      // Thumbnail sau upload: nhiều class Maps / lgbiNe / ảnh blob
      const thumbs = root.querySelectorAll(
        '[data-photo-id], div[style*="background-image"][style*="blob"], div[style*="googleusercontent"], img[src*="googleusercontent"], img[src*="blob:"], img[src^="data:image"], img[src*="lh3.google"]',
      );
      let n = 0;
      for (const el of Array.from(thumbs)) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width >= 36 && r.height >= 36 && r.bottom > 0 && r.right > 0) n += 1;
      }
      if (n > 0) return n;

      const imgs = Array.from(
        root.querySelectorAll(
          'img[src*="googleusercontent"], img[src*="blob:"], img[src^="data:"], img[src*="lh3.google"]',
        ),
      ) as HTMLImageElement[];
      const previews = imgs.filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width >= 36 && r.height >= 36 && r.bottom > 0 && r.right > 0;
      });
      return previews.length;
    });
  } catch {
    return 0;
  }
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
  return [...new Set(ordered)];
}

async function clickAddPhotoButton(frame: Frame, page: Page, human: HumanCursor) {
  for (const ctx of await reviewFormFrames(page, frame)) {
    const handle = await ctx
      .$(
        'div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i], button[aria-label*="Add photo" i], button[aria-label*="Add photos" i]',
      )
      .catch(() => null);
    if (handle) {
      await human.clickElement(handle).catch(() => undefined);
      console.log("[maps-review] đã bấm Thêm ảnh");
      await sleep(rand(400, 700));
      return true;
    }
    const clicked = await ctx
      .evaluate(() => {
        const btn = [...document.querySelectorAll("button, div[role='button']")].find(
          (b) => /Thêm ảnh|Add photo|Add photos|Thêm hình/i.test(b.textContent || ""),
        ) as HTMLElement | undefined;
        if (!btn) return false;
        btn.scrollIntoView({ block: "center", inline: "nearest" });
        btn.click();
        return true;
      })
      .catch(() => false);
    if (clicked) {
      console.log("[maps-review] đã bấm Thêm ảnh (text fallback)");
      await sleep(rand(400, 700));
      return true;
    }
  }
  return false;
}

async function findImageFileInput(frame: Frame, page: Page) {
  for (const ctx of await reviewFormFrames(page, frame)) {
    try {
      const inputs = await ctx.$$('input[type="file"]');
      for (const input of inputs) {
        const meta = await ctx.evaluate((el) => {
          const accept = (el.getAttribute("accept") || "").toLowerCase();
          const acceptOk =
            !accept ||
            accept.includes("image") ||
            accept.includes("*") ||
            accept.includes("jfif") ||
            accept.includes("jpeg") ||
            accept.includes("png") ||
            accept.includes("webp") ||
            accept.includes("heic");
          // Maps hay để input display:none + size 0 — vẫn uploadFile được
          return {
            ok: acceptOk,
            multiple: el.hasAttribute("multiple"),
            accept,
          };
        }, input);
        if (meta.ok) {
          console.log(
            `[maps-review] tìm thấy input[type=file] accept=${meta.accept || "(any)"} multiple=${meta.multiple}`,
          );
          return { input, multiple: meta.multiple, frame: ctx };
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Fallback: mọi frame (kể cả score thấp / bscframe)
  for (const ctx of page.frames()) {
    try {
      const inputs = await ctx.$$('input[type="file"]');
      for (const input of inputs) {
        const accept = await input.evaluate((el) =>
          (el.getAttribute("accept") || "").toLowerCase(),
        );
        if (
          accept &&
          !/image|\*|jfif|jpeg|png|webp|heic|video/i.test(accept)
        ) {
          continue;
        }
        console.log(
          `[maps-review] input[type=file] fallback frame=${ctx.url().slice(0, 60)} accept=${accept || "(any)"}`,
        );
        const multiple = await input.evaluate((el) => el.hasAttribute("multiple"));
        return { input, multiple, frame: ctx };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Chờ preview ảnh xuất hiện sau upload. */
async function waitPhotoPreviewIncrease(
  page: Page,
  frame: Frame,
  beforeCount: number,
  minAdded = 1,
  timeoutMs = 30_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of await reviewFormFrames(page, frame)) {
      const count = await countReviewPhotos(ctx);
      if (count >= beforeCount + minAdded) return { ok: true as const, count, frame: ctx };
    }
    await sleep(450);
  }
  return { ok: false as const, count: beforeCount, frame };
}

/** Đóng hộp thoại Open — KHÔNG Escape khi đang trong form review (Escape = hỏi hủy). */
async function dismissNativeFileDialog(page: Page, opts?: { allowEscape?: boolean }) {
  if (opts?.allowEscape === false) return;
  // Chỉ Escape nếu không còn iframe viết review
  const writing = page.frames().some((f) =>
    /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(f.url()),
  );
  if (writing) {
    // Đang form review: Escape dễ mở "Hủy bài đánh giá?" → bỏ qua
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(200);
}

/**
 * Upload ảnh không để lại hộp thoại Windows Open.
 * Ưu tiên input.uploadFile; chỉ click "Thêm ảnh" kèm waitForFileChooser + accept ngay.
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
    if (found.multiple && filePaths.length > 1) {
      await found.input.uploadFile(...filePaths);
    } else {
      await found.input.uploadFile(filePaths[0]!);
    }
    await found.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return { ok: true as const, frame: uploadFrame };
  }

  // Chưa có input — bấm Thêm ảnh nhưng phải bắt FileChooser ngay, không để dialog treo
  console.log("[maps-review] chưa có input[type=file] — mở FileChooser qua Thêm ảnh");
  const chooserPromise = page.waitForFileChooser({ timeout: 12_000 }).catch(() => null);
  // Click sau khi đã listen — tránh miss event
  await sleep(50);
  if (human) {
    await clickAddPhotoButton(frame, page, human);
  } else {
    for (const ctx of await reviewFormFrames(page, frame)) {
      const clicked = await ctx
        .evaluate(() => {
          const el =
            document.querySelector(
              'div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i], button[aria-label*="Add photo" i]',
            ) ||
            [...document.querySelectorAll("button, div[role='button']")].find((b) =>
              /Thêm ảnh|Add photo|Thêm hình/i.test(b.textContent || ""),
            );
          if (!el) return false;
          (el as HTMLElement).click();
          return true;
        })
        .catch(() => false);
      if (clicked) break;
    }
  }
  const chooser = await chooserPromise;
  if (chooser) {
    console.log(`[maps-review] FileChooser OK — accept ${filePaths.length} file`);
    await chooser.accept(filePaths);
    return { ok: true as const, frame: uploadFrame };
  }
  console.warn("[maps-review] FileChooser không bắt được — thử tìm input sau click");

  // Thử lại: tìm input sau click (một số UI tạo input ẩn)
  await sleep(400);
  const again = await findImageFileInput(frame, page);
  if (again?.input) {
    await again.input.uploadFile(...(again.multiple ? filePaths : [filePaths[0]!]));
    await again.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
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
  const beforeCount = await countReviewPhotos(frame);
  const upload = await uploadViaInputOrChooser(frame, page, [filePath], human);
  if (!upload.ok) {
    await dismissNativeFileDialog(page);
    return false;
  }
  const waited = await waitPhotoPreviewIncrease(page, upload.frame, beforeCount, 1, 25_000);
  await dismissNativeFileDialog(page);
  return waited.ok;
}

/** Upload nhiều ảnh — KHÔNG bấm «Thêm ảnh» trước (mở dialog OS → vỡ FileChooser). */
async function addImages(
  frame: Frame,
  page: Page,
  filePaths: string[],
  human?: HumanCursor,
) {
  const missing = filePaths.filter((p) => p && !existsSync(p));
  const existing = filePaths.filter((p) => p && existsSync(p));
  if (missing.length) {
    console.warn(`[maps-review] thiếu file ảnh trên disk: ${missing.join(", ")}`);
  }
  if (!existing.length) return 0;

  await sweepStaleMapsPhotoTemps().catch(() => undefined);

  const prepared: string[] = [];
  const temps: string[] = [];
  try {
    for (const p of existing) {
      const out = await prepareMapsPhotoForUpload(p);
      prepared.push(out.path);
      temps.push(...out.tempPaths);
    }

    const beforeCount = await countReviewPhotos(frame);
    console.log(
      `[maps-review] upload ${prepared.length} ảnh (preview trước=${beforeCount})`,
    );

    const found = await findImageFileInput(frame, page);
    const uploadFrame = found?.frame ?? frame;

    if (found?.input && found.multiple && prepared.length > 1) {
      await found.input.uploadFile(...prepared);
      await found.input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const waited = await waitPhotoPreviewIncrease(
        page,
        uploadFrame,
        beforeCount,
        prepared.length,
        35_000,
      );
      if (waited.ok) return prepared.length;
      const added = Math.max(0, waited.count - beforeCount);
      if (added > 0) return added;
    }

    // 1 file hoặc không multiple: uploadFile trực tiếp / FileChooser đúng cách
    if (found?.input && prepared.length === 1) {
      await found.input.uploadFile(prepared[0]!);
      await found.input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const waited = await waitPhotoPreviewIncrease(
        page,
        uploadFrame,
        beforeCount,
        1,
        30_000,
      );
      if (waited.ok) return 1;
      console.warn(
        `[maps-review] uploadFile xong nhưng chưa thấy preview (count=${waited.count}) — thử FileChooser`,
      );
    }

    // Batch qua FileChooser nếu nhiều ảnh
    if (prepared.length > 1) {
      const batch = await uploadViaInputOrChooser(frame, page, prepared, human);
      if (batch.ok) {
        const waited = await waitPhotoPreviewIncrease(
          page,
          batch.frame,
          beforeCount,
          prepared.length,
          35_000,
        );
        if (waited.ok) return prepared.length;
        const added = Math.max(0, waited.count - beforeCount);
        if (added > 0) return added;
      }
    }

    let uploaded = 0;
    for (let i = 0; i < prepared.length; i++) {
      const ok = await addImage(
        frame,
        page,
        prepared[i],
        i > 0 || uploaded > 0,
        human,
      );
      if (ok) uploaded += 1;
      else {
        console.warn(
          `[maps-review] ảnh ${i + 1}/${prepared.length} thất bại: ${prepared[i]}`,
        );
      }
      await sleep(rand(900, 1400));
    }
    await dismissNativeFileDialog(page);
    return uploaded;
  } finally {
    await cleanupMapsPhotoTemps(temps);
  }
}

async function finishThankYou(page: Page, timeoutMs = 40_000) {
  const start = Date.now();
  let bestLink: string | null = null;
  let bestPoints: string | null = null;

  while (Date.now() - start < timeoutMs) {
    // Widget đóng / không còn iframe viết review → thường là đã submit
    const stillWriting = page.frames().some((f) =>
      /ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(f.url()),
    );

    for (const ctx of [page.mainFrame(), ...page.frames()]) {
      try {
        const info = await ctx.evaluate(() => {
          const abs = (href: string | null | undefined) => {
            if (!href) return null;
            const h = href.trim();
            if (!h || h === "#" || h.startsWith("javascript:")) return null;
            if (/^https?:\/\//i.test(h)) return h;
            if (h.startsWith("//")) return `https:${h}`;
            if (h.startsWith("/")) return `https://www.google.com${h}`;
            return h;
          };

          const candidates: string[] = [];
          const push = (h: string | null | undefined) => {
            const a = abs(h);
            if (a) candidates.push(a);
          };

          const root = document.querySelector("[data-view-profile-post-link]");
          push(root?.getAttribute("data-view-profile-post-link"));

          for (const el of Array.from(
            document.querySelectorAll(
              "[data-view-profile-post-link], [data-href], [data-url], [data-review-url]",
            ),
          )) {
            push(el.getAttribute("data-view-profile-post-link"));
            push(el.getAttribute("data-href"));
            push(el.getAttribute("data-url"));
            push(el.getAttribute("data-review-url"));
          }

          for (const a of Array.from(document.querySelectorAll("a[href]"))) {
            const href = a.getAttribute("href") || "";
            if (
              /maps\/reviews|contrib|\/maps\/contrib|local\/reviews|review\/data/i.test(
                href,
              )
            ) {
              push(href);
            }
          }

          // Nút/link "Xem bài đánh giá" / "View on Google"
          for (const el of Array.from(
            document.querySelectorAll("a, button, div[role='button'], span"),
          )) {
            const label =
              (el.getAttribute("aria-label") || "") +
              " " +
              (el.textContent || "");
            if (
              /xem bài|view (your )?review|view on google|xem trên google|see (your )?review/i.test(
                label,
              )
            ) {
              push(el.getAttribute("href"));
              push(el.getAttribute("data-href"));
              const nested = el.querySelector?.("a[href]");
              push(nested?.getAttribute("href"));
            }
          }

          const doneBtn = document.querySelector('button[jsname="done-button"]');
          const body = (document.body?.innerText || "").slice(0, 4000);
          const thank =
            !!doneBtn ||
            !!document.querySelector("#thank-you-title") ||
            !!root ||
            candidates.length > 0 ||
            /\+\d+\s*điểm/i.test(body) ||
            /cảm ơn|thank you|đã đăng|review (has been )?posted|your review/i.test(
              body,
            );

          const prefer = candidates.find(
            (u) => /maps\/reviews|review\/data|contrib/i.test(u),
          );

          return {
            has: thank,
            link: prefer || candidates[0] || null,
            points:
              document.querySelector(".xy1tk")?.textContent?.trim() || null,
          };
        });

        if (info.link) bestLink = info.link;
        if (info.points) bestPoints = info.points;

        if (!info.has) continue;

        // Có thank-you nhưng chưa có link → đợi thêm một nhịp (link hay render chậm)
        if (!info.link && Date.now() - start < 8_000) {
          await sleep(400);
          continue;
        }

        await ctx.evaluate(() => {
          (
            document.querySelector('button[jsname="done-button"]') ||
            [...document.querySelectorAll("button")].find((b) =>
              /Xong|Done|Đóng|Close/i.test(b.textContent || ""),
            )
          )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await sleep(800);
        console.log(
          `[maps-review] bắt được màn cảm ơn link=${bestLink || info.link || "n/a"}`,
        );
        return {
          ok: true as const,
          reviewLink: bestLink || info.link,
          pointsText: bestPoints || info.points,
        };
      } catch {
        /* ignore */
      }
    }

    // Form viết đã biến mất sau khi bấm Đăng → coi như thành công (UI đổi)
    // Nhưng ưu tiên đợi thank-you/link thêm ~12s trước khi bỏ qua
    if (!stillWriting && Date.now() - start > 12_000) {
      console.log(
        `[maps-review] form đánh giá đã đóng — coi như đã đăng (link=${bestLink || "n/a"})`,
      );
      return {
        ok: true as const,
        reviewLink: bestLink,
        pointsText: bestPoints,
      };
    }
    await sleep(500);
  }
  return {
    ok: bestLink ? (true as const) : (false as const),
    reviewLink: bestLink,
    pointsText: bestPoints,
  };
}

/**
 * Sau khi đăng: mở lại place → tìm link review của account
 * (khi màn cảm ơn không trả data-view-profile-post-link).
 */
async function resolveReviewLinkFromPlace(
  page: Page,
  placeUrl: string,
  reviewText: string,
): Promise<string | null> {
  const snippet = reviewText.trim().slice(0, 40);
  try {
    await page.goto(placeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(rand(1500, 2500));
    await openReviewsTab(page).catch(() => undefined);
    await sleep(800);

    // Cuộn panel reviews để lộ "Đánh giá của bạn"
    for (let i = 0; i < 4; i++) {
      await scrollPlacePanel(page, 220);
    }

    const link = await page.evaluate((snip) => {
      const abs = (href: string | null | undefined) => {
        if (!href) return null;
        const h = href.trim();
        if (!h || h === "#" || h.startsWith("javascript:")) return null;
        if (/^https?:\/\//i.test(h)) return h;
        if (h.startsWith("//")) return `https:${h}`;
        if (h.startsWith("/")) return `https://www.google.com${h}`;
        return h;
      };

      const isReviewUrl = (h: string) =>
        /maps\/reviews|contrib|local\/reviews|review\/data/i.test(h);

      // 1) Nút chỉnh sửa / đánh giá của bạn gần link
      const edit = Array.from(
        document.querySelectorAll("button, a, [role='button']"),
      ).find((n) =>
        /Chỉnh sửa bài đánh giá|Edit your review|Đánh giá của bạn|Your review/i.test(
          (n.getAttribute("aria-label") || "") + " " + (n.textContent || ""),
        ),
      ) as HTMLElement | undefined;

      if (edit) {
        const near = edit.closest("div, article, section, li") || edit.parentElement;
        const a =
          (near?.querySelector(
            'a[href*="maps/reviews"], a[href*="contrib"], a[href*="review"]',
          ) as HTMLAnchorElement | null) ||
          (edit.closest("a") as HTMLAnchorElement | null);
        const u = abs(a?.href || a?.getAttribute("href"));
        if (u && isReviewUrl(u)) return u;
      }

      // 2) Card chứa đoạn nội dung vừa đăng
      if (snip.length >= 8) {
        const nodes = Array.from(document.querySelectorAll("div, span, p"));
        const hit = nodes.find((n) => (n.textContent || "").includes(snip));
        if (hit) {
          const card =
            hit.closest("[data-review-id], article, li, .jftiEf, .fontBodyMedium") ||
            hit.parentElement;
          const a = card?.querySelector(
            'a[href*="maps/reviews"], a[href*="contrib"], a[href*="review"]',
          ) as HTMLAnchorElement | null;
          const u = abs(a?.href || a?.getAttribute("href"));
          if (u && isReviewUrl(u)) return u;
        }
      }

      // 3) Mọi link review trên panel
      for (const a of Array.from(
        document.querySelectorAll(
          'a[href*="maps/reviews"], a[href*="contrib"], a[href*="local/reviews"]',
        ),
      )) {
        const u = abs((a as HTMLAnchorElement).href || a.getAttribute("href"));
        if (u && isReviewUrl(u)) return u;
      }

      return null;
    }, snippet);

    if (link) {
      console.log(`[maps-review] lấy được reviewLink từ place: ${link}`);
    } else {
      console.warn("[maps-review] không tìm thấy reviewLink trên place sau khi đăng");
    }
    return link;
  } catch (e) {
    console.warn(
      "[maps-review] resolveReviewLinkFromPlace failed:",
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
  console.log(`[maps-review] chưa thấy form — bấm Viết bài đánh giá`);
  const chijBefore = await extractChijPlaceId(page);
  if (chijBefore) {
    console.log(`[maps-review] place_id ChIJ=${chijBefore}`);
  }
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
  await clickReviewButton(page, human).catch(() => undefined);
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

  const chij =
    (await extractChijPlaceId(page)) || chijBefore || null;
  if (chij) {
    const writeUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(chij)}`;
    console.log(`[maps-review] fallback goto writereview ChIJ=${chij}`);
    await page.goto(writeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(rand(1500, 2500));
    await dismissMapsOverlays(page);
    await logAfterWriteClick(page, "writereview-chij");
    await tryStarsInOpenDialog(page, rating, human);
    try {
      return await waitReviewFrame(page, 20_000);
    } catch {
      /* last resort */
    }
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
  await clickReviewButton(page, human).catch(() => undefined);
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
  alreadyReviewed?: boolean;
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

  if (
    await withStepTimeout("detectExistingReview", 15_000, () =>
      detectExistingReview(page),
    )
  ) {
    console.log("[maps-review] place đã có review của account — bỏ qua đăng trùng");
    const existingLink = await resolveReviewLinkFromPlace(
      page,
      payload.placeUrl,
      payload.reviewText,
    );
    return {
      ok: true,
      reviewLink: existingLink,
      pointsText: null,
      placeUrl: payload.placeUrl,
      alreadyReviewed: true,
    };
  }

  await keepFocus({ os: "window" });
  assertNotAborted(signal);
  console.log(`[maps-review] thử rate trên place panel (${payload.rating}★)`);
  // Ưu tiên bấm sao trên panel place (thường mở form + đã chọn sao)
  const ratedOnPlace = await withStepTimeout("tryRateOnPlacePanel", 25_000, () =>
    tryRateOnPlacePanel(page, payload.rating, human),
  );
  console.log(`[maps-review] ratedOnPlace=${ratedOnPlace}`);
  await sleep(rand(600, 1100));

  // Mở form viết đánh giá (nút → dialog sao → writereview URL)
  let frame: Frame | null = null;
  try {
    frame = await waitReviewFrame(page, ratedOnPlace ? 8_000 : 2_500);
  } catch {
    frame = null;
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

  try {
    await keepFocus({ os: "tab" });
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
  const imagePaths =
    payload.imagePaths?.filter(Boolean) ??
    (payload.imagePath ? [payload.imagePath] : []);
  await keepFocus({ os: "window" });
  assertNotAborted(signal);
  // Frame có thể đổi sau enterReview — lấy lại trước khi upload ảnh
  frame = (await waitReviewFrame(page, 10_000).catch(() => frame)) ?? frame;
  const uploaded = imagePaths.length
    ? await addImages(frame, page, imagePaths, human)
    : 0;
  if (imagePaths.length && uploaded < imagePaths.length) {
    throw new Error(
      `Upload ảnh thất bại: chỉ ${uploaded}/${imagePaths.length} ảnh có preview trên form — không đăng thiếu ảnh`,
    );
  }
  if (uploaded > 0) {
    console.log(`[maps-review] uploaded ${uploaded} image(s) — preview đã xác minh`);
    await sleep(rand(2500, 4000));
  }
  await keepFocus({ os: "window" });
  assertNotAborted(signal);
  await submitReview(frame, payload.rating, human);
  await keepFocus({ os: "window" });
  const thanks = await finishThankYou(page);
  let reviewLink = thanks.reviewLink;
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
  if (ok && !reviewLink) {
    await keepFocus({ os: "window" });
    reviewLink = await resolveReviewLinkFromPlace(
      page,
      payload.placeUrl,
      payload.reviewText,
    );
  }

  return {
    ok,
    reviewLink,
    pointsText,
    placeUrl: payload.placeUrl,
  };
}
