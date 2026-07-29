/**
 * Google Maps review automation — form trong iframe ReviewsService.LoadWriteWidget
 */
import type { ElementHandle, Frame, Page } from "puppeteer";
import { existsSync } from "fs";
import type { MapsReviewPayload } from "@apm/shared";
import { attachProxyAuthToPage } from "./proxy-auth.js";
import { HumanCursor } from "./humanize.js";

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

async function clickReviewButton(page: Page, human: HumanCursor) {
  const selectors = [
    'button.S9kvJb[aria-label="Viết bài đánh giá"]',
    'button[aria-label="Viết bài đánh giá"]',
    'button[aria-label*="Viết bài đánh giá" i]',
    'button[aria-label*="Write a review" i]',
    'button[aria-label*="Chỉnh sửa bài đánh giá" i]',
    'button[aria-label*="Edit your review" i]',
    'button[jsaction*="review"][aria-label*="đánh giá" i]',
  ];

  const tryClick = async (): Promise<boolean> => {
    for (const sel of selectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 2500, visible: true });
        if (!el) continue;
        await page.evaluate((node) => {
          (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" });
        }, el);
        await sleep(rand(200, 400));
        await human.clickElement(el);
        console.log(`[maps-review] đã bấm viết đánh giá (${sel})`);
        return true;
      } catch {
        /* next */
      }
    }
    // Text trong panel
    const hit = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, div[role='button'], span"),
      ) as HTMLElement[];
      const btn = nodes.find((n) =>
        /Viết bài đánh giá|Write a review|Chỉnh sửa bài đánh giá|Edit your review/i.test(
          (n.getAttribute("aria-label") || "") + " " + (n.textContent || ""),
        ),
      );
      if (!btn) return false;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return true;
    });
    if (hit) {
      console.log("[maps-review] đã bấm viết đánh giá (text fallback)");
      return true;
    }
    return false;
  };

  // 1) Thử ngay trên Tổng quan (đôi khi nút đã hiện)
  if (await tryClick()) return true;

  // 2) Vào tab Bài đánh giá rồi thử lại
  await openReviewsTab(page);
  if (await tryClick()) return true;

  // 3) Cuộn panel trái vài lần
  for (let i = 0; i < 6; i++) {
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

/** Điểm số form review trong 1 frame — ưu tiên có cả sao + textarea. */
async function scoreReviewFrame(frame: Frame): Promise<number> {
  try {
    return await frame.evaluate(() => {
      let score = 0;
      const url = location.href || "";
      if (/ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(url)) {
        score += 50;
      }
      if (document.querySelector('div[role="radiogroup"], [data-rating], [role="radio"]')) {
        score += 30;
      }
      if (document.querySelector("textarea")) score += 20;
      if (document.querySelector('button[jsname="IJM3w"]')) score += 10;
      // Sao theo aria-label (UI Maps mới đôi khi không có data-rating)
      const labeled = Array.from(
        document.querySelectorAll("[aria-label], button, div, span"),
      ).some((el) =>
        /\b([1-5])\s*(sao|stars?)\b/i.test(el.getAttribute("aria-label") || ""),
      );
      if (labeled) score += 25;
      return score;
    });
  } catch {
    return 0;
  }
}

async function waitReviewFrame(page: Page, timeoutMs = 35_000): Promise<Frame> {
  const start = Date.now();
  let bestFrame: Frame | null = null;
  let bestScore = 0;

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      const score = await scoreReviewFrame(frame);
      if (score < 20) continue;
      if (score > bestScore) {
        bestScore = score;
        bestFrame = frame;
      }
      // Đủ mạnh (widget + sao hoặc textarea) → lấy luôn
      if (score >= 70) {
        console.log(`[maps-review] form frame score=${score}`);
        return frame;
      }
    }
    if (bestFrame && bestScore >= 40 && Date.now() - start > 8_000) {
      console.log(`[maps-review] form frame score=${bestScore} (partial)`);
      return bestFrame;
    }
    await sleep(400);
  }

  if (bestFrame && bestScore >= 20) {
    console.log(`[maps-review] form frame score=${bestScore} (timeout best)`);
    return bestFrame;
  }
  throw new Error("Không tìm thấy iframe form đánh giá");
}

/** Đọc số sao đang chọn trong form (nếu có) — gồm suy luận SVG tô màu. */
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
        const m = labelOf(el).match(/\b([1-5])\s*(sao|stars?)\b/i);
        return m ? Number(m[1]) : null;
      };
      const isFilledLook = (el: Element): boolean => {
        if (el.getAttribute("aria-checked") === "true") return true;
        if (el.getAttribute("aria-pressed") === "true") return true;
        if (/\b(selected|checked|active|filled)\b/i.test(el.className || "")) {
          return true;
        }
        const shapes = el.querySelectorAll("path, polygon, circle");
        for (const s of Array.from(shapes)) {
          const fill =
            (getComputedStyle(s as Element).fill ||
              s.getAttribute("fill") ||
              "") +
            " " +
            (getComputedStyle(s as Element).color || "");
          // Vàng / cam Google Maps = đã tô
          if (
            /rgb\(\s*(25[0-5]|2[4-5]\d)\s*,\s*(1[89]\d|2[0-1]\d)\s*,|#[fF][fFeEBbAa89]|#fbbc|#fea|#ffc|#f4b|gold|orange|yellow/i.test(
              fill,
            )
          ) {
            return true;
          }
        }
        return false;
      };

      const checked =
        (document.querySelector(
          '[role="radio"][aria-checked="true"], [data-rating][aria-checked="true"], [aria-checked="true"][data-rating], [aria-pressed="true"][data-rating]',
        ) as HTMLElement | null) || null;
      if (checked) {
        const fromData = Number(checked.getAttribute("data-rating"));
        if (fromData >= 1 && fromData <= 5) return fromData;
        const fromPos = Number(checked.getAttribute("aria-posinset"));
        if (fromPos >= 1 && fromPos <= 5) return fromPos;
        const fromLb = fromLabel(checked);
        if (fromLb) return fromLb;
      }

      const pressed = Array.from(
        document.querySelectorAll(
          '[aria-pressed="true"], [data-rating].selected, .s2xyy[aria-checked="true"], [role="radio"][aria-checked="true"]',
        ),
      ) as HTMLElement[];
      let maxPressed = 0;
      for (const el of pressed) {
        const r =
          Number(el.getAttribute("data-rating")) ||
          Number(el.getAttribute("aria-posinset")) ||
          fromLabel(el) ||
          0;
        if (r > maxPressed) maxPressed = r;
      }
      if (maxPressed >= 1) return maxPressed;

      // Suy luận hàng sao: lấy max index đã tô màu
      const groups = [
        ...Array.from(document.querySelectorAll('[role="radiogroup"]')),
        document.body,
      ];
      for (const root of groups) {
        const items = Array.from(
          root.querySelectorAll(
            '[role="radio"], [data-rating], div.s2xyy, [jsaction*="rate"]',
          ),
        ) as HTMLElement[];
        if (items.length < 3) continue;
        let max = 0;
        items.forEach((el, i) => {
          if (!isFilledLook(el)) return;
          const r =
            Number(el.getAttribute("data-rating")) ||
            Number(el.getAttribute("aria-posinset")) ||
            fromLabel(el) ||
            i + 1;
          if (r >= 1 && r <= 5 && r > max) max = r;
        });
        if (max >= 1) return max;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Click sao trong DOM (ưu tiên JS click — ổn định hơn mouse qua iframe).
 * Trả về via + selected rating sau click.
 */
async function clickStarInDom(
  frame: Frame,
  value: number,
): Promise<{ ok: boolean; via: string; selected: number | null; detail?: string }> {
  const rating = Math.min(5, Math.max(1, Math.round(value)));
  return frame.evaluate((want) => {
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
        (el.getAttribute("title") || "") +
        " " +
        (el.getAttribute("data-tooltip") || "")
      ).trim();

    const matchRatingLabel = (label: string, n: number) => {
      const t = label.toLowerCase();
      return (
        new RegExp(`\\b${n}\\s*(sao|stars?)\\b`, "i").test(t) ||
        new RegExp(`\\b${n}\\s*trên\\s*5\\b`, "i").test(t) ||
        new RegExp(`\\b${n}\\s*out\\s*of\\s*5\\b`, "i").test(t) ||
        new RegExp(`(rate|rating|đánh giá)\\s*${n}\\b`, "i").test(t) ||
        new RegExp(`^${n}$`).test(t.trim())
      );
    };

    const readSelected = (): number | null => {
      const checked = document.querySelector(
        '[role="radio"][aria-checked="true"], [data-rating][aria-checked="true"], [aria-pressed="true"][data-rating]',
      ) as HTMLElement | null;
      if (checked) {
        const d = Number(checked.getAttribute("data-rating"));
        if (d >= 1 && d <= 5) return d;
        const p = Number(checked.getAttribute("aria-posinset"));
        if (p >= 1 && p <= 5) return p;
        for (let n = 5; n >= 1; n--) {
          if (matchRatingLabel(labelOf(checked), n)) return n;
        }
      }
      // Sao tô màu / class selected
      const filled = Array.from(
        document.querySelectorAll(
          '[data-rating].selected, [data-rating][aria-checked="true"], .s2xyy[aria-checked="true"]',
        ),
      ) as HTMLElement[];
      let max = 0;
      for (const el of filled) {
        const r = Number(el.getAttribute("data-rating"));
        if (r > max) max = r;
      }
      return max > 0 ? max : null;
    };

    const roots: ParentNode[] = [
      ...Array.from(document.querySelectorAll('div[role="radiogroup"]')),
      ...Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')),
      document.body,
    ].filter(Boolean) as ParentNode[];

    for (const root of roots) {
      // 1) data-rating / data-value
      const byData = root.querySelector(
        `[data-rating="${want}"], [data-value="${want}"], div.s2xyy[data-rating="${want}"]`,
      ) as HTMLElement | null;
      if (byData) {
        fire(byData);
        return { ok: true, via: "data-rating", selected: readSelected() };
      }

      // 2) aria-label / title
      const labeled = Array.from(
        root.querySelectorAll(
          "[aria-label], [title], button, [role='radio'], [role='button'], div, span, g, svg",
        ),
      ).find((el) => matchRatingLabel(labelOf(el), want)) as HTMLElement | undefined;
      if (labeled) {
        fire(labeled);
        return { ok: true, via: "aria-label", selected: readSelected() };
      }

      // 3) aria-posinset
      const byPos = root.querySelector(
        `[role="radio"][aria-posinset="${want}"], [aria-posinset="${want}"]`,
      ) as HTMLElement | null;
      if (byPos) {
        fire(byPos);
        return { ok: true, via: "aria-posinset", selected: readSelected() };
      }

      // 4) Nhóm radio / .s2xyy / [data-rating] theo index
      const clickables = Array.from(
        root.querySelectorAll(
          '[role="radio"], div.s2xyy, [data-rating], button[data-rating], [jsaction*="rate"], [jsaction*="star"]',
        ),
      ).filter((el) => {
        const b = (el as HTMLElement).getBoundingClientRect();
        return b.width >= 8 && b.height >= 8 && b.bottom > 0 && b.right > 0;
      }) as HTMLElement[];
      const stars = clickables.length >= 5 ? clickables.slice(0, 5) : clickables;
      if (stars.length >= 3) {
        const target = stars[want - 1] || stars[stars.length - 1];
        if (target) {
          fire(target);
          return {
            ok: true,
            via: `index:${stars.length}`,
            selected: readSelected(),
          };
        }
      }

      // 5) Hàng 5 nút/sao cùng kích thước (UI Maps mới — SVG / google-symbols)
      const all = Array.from(
        root.querySelectorAll("button, div, span, [role='button']"),
      ) as HTMLElement[];
      const sized = all
        .map((el) => {
          const b = el.getBoundingClientRect();
          return { el, b };
        })
        .filter(
          ({ b }) =>
            b.width >= 16 &&
            b.width <= 72 &&
            b.height >= 16 &&
            b.height <= 72 &&
            b.top > 0,
        );
      // Cluster theo cùng hàng (y gần nhau)
      for (const seed of sized) {
        const row = sized
          .filter((o) => Math.abs(o.b.top - seed.b.top) < 12)
          .sort((a, b) => a.b.left - b.b.left);
        // Unique by left
        const uniq: typeof row = [];
        for (const o of row) {
          if (!uniq.some((u) => Math.abs(u.b.left - o.b.left) < 8)) uniq.push(o);
        }
        if (uniq.length === 5) {
          const target = uniq[want - 1];
          if (target) {
            fire(target.el);
            return {
              ok: true,
              via: "row5",
              selected: readSelected(),
              detail: `y=${Math.round(seed.b.top)}`,
            };
          }
        }
      }
    }

    return {
      ok: false,
      via: "none",
      selected: null,
      detail: `bodyLen=${(document.body?.innerText || "").length}`,
    };
  }, rating);
}

const CONFIDENT_STAR_VIA =
  /^(data-rating|aria-label|aria-posinset|row5|index)/i;

/** Quét mọi frame (kể cả main) để chọn sao. */
async function selectStar(page: Page, value: number, _human: HumanCursor) {
  const rating = Math.min(5, Math.max(1, Math.round(value)));
  console.log(`[maps-review] selectStar-v5 quét mọi frame (${rating}★)`);
  const waitStart = Date.now();

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

  // Chờ UI sao xuất hiện ở bất kỳ frame nào
  while (Date.now() - waitStart < 18_000) {
    let found = false;
    for (const frame of page.frames()) {
      const ok = await frame
        .evaluate(
          () =>
            !!document.querySelector(
              'div[role="radiogroup"], [data-rating], [role="radio"], [aria-label*="sao" i], [aria-label*="star" i], [jsaction*="rate"], [jsaction*="star"], div.s2xyy',
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

  for (let attempt = 0; attempt < 12; attempt++) {
    // Chỉ click trong frame được nhận diện là form review. Quét mọi frame Maps
    // dễ nhầm các hàng icon khác thành 5 sao.
    const scoredFrames = await Promise.all(
      page.frames().map(async (frame) => ({
        frame,
        score: await scoreReviewFrame(frame),
      })),
    );
    const frames = scoredFrames
      .filter(({ score }) => score >= 20)
      .sort((a, b) => b.score - a.score)
      .map(({ frame }) => frame);

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

      selected = (await readSelectedRating(frame)) ?? dom.selected;
      if (selected === rating) {
        console.log(
          `[maps-review] chọn ${rating}★ OK (via=${dom.via}, frame=${frame.url().slice(0, 60)}, attempt=${attempt + 1})`,
        );
        return;
      }

      if (dom.ok && CONFIDENT_STAR_VIA.test(dom.via)) {
        confidentHits += 1;
        // Maps: nút Đăng thường vẫn disabled đến khi có chữ → không dùng postEnabled
        // làm điều kiện duy nhất. Click chắc (data-rating/aria/…) 2 lần → chấp nhận.
        if (confidentHits >= 2) {
          console.log(
            `[maps-review] chọn ${rating}★ OK trust-via=${dom.via} (hits=${confidentHits}, selected=${selected})`,
          );
          return;
        }
      }

      // Mouse click thật theo bounding box (iframe-aware)
      try {
        const handle =
          (await frame.$(
            `[data-rating="${rating}"], [data-value="${rating}"], [role="radio"][aria-posinset="${rating}"], div.s2xyy[data-rating="${rating}"], [aria-label="${rating} sao"], [aria-label="${rating} stars"], [aria-label="${rating} star"]`,
          )) ||
          (
            await frame.$$(
              '[role="radio"], div.s2xyy, [data-rating], [jsaction*="rate"]',
            )
          )[rating - 1] ||
          null;
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
            confidentHits += 1;
            if (confidentHits >= 2) {
              console.log(
                `[maps-review] chọn ${rating}★ OK trust-mouse (hits=${confidentHits})`,
              );
              return;
            }
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
      if (postEnabled && (dom.ok || confidentHits >= 1)) {
        console.log(
          `[maps-review] chọn ${rating}★ — Đăng đã enable (via=${dom.via})`,
        );
        return;
      }
    }

    // Bàn phím trên main page
    if (attempt >= 4) {
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.keyboard.type(String(rating), { delay: 50 }).catch(() => undefined);
      await sleep(300);
    }

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

async function enterReview(frame: Frame, text: string, human: HumanCursor) {
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
  const body = text.trim();
  if (!body) throw new Error("Nội dung đánh giá trống");
  const minFilled = Math.min(8, body.length);

  // Chờ ô nhập xuất hiện
  const waitStart = Date.now();
  while (Date.now() - waitStart < 10_000) {
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

    // 3) Xóa nội dung cũ + gõ từng ký tự (nhịp người)
    const page = frame.page();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await sleep(rand(120, 260));
    await page.keyboard.press("Backspace");
    await sleep(rand(150, 320));
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      await page.keyboard.type(ch, { delay: 0 });
      let delay = rand(90, 220);
      if (" .,!?;:\n".includes(ch)) delay += rand(60, 180);
      if (i > 0 && i % randInt(6, 12) === 0) delay += rand(150, 420);
      await sleep(delay);
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

    if ((await filledLen(sel)) >= minFilled) {
      console.log(`[maps-review] đã nhập bình luận (gõ tay, focus JS)`);
      return;
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
      return;
    }
  }
  throw new Error("Không nhập được bình luận");
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

async function submitReview(frame: Frame, rating: number, human: HumanCursor) {
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

      const imgs = Array.from(
        root.querySelectorAll(
          'img[src*="googleusercontent"], img[src*="blob:"], img[src^="data:"]',
        ),
      ) as HTMLImageElement[];
      const previews = imgs.filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width >= 44 && r.height >= 44 && r.bottom > 0 && r.right > 0;
      });
      const nearAdd = root.querySelector(
        'div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i], button[aria-label*="Add photo" i]',
      );
      if (nearAdd) {
        const box = (nearAdd as HTMLElement).closest("div, section, form") || root;
        const local = Array.from(
          box.querySelectorAll('img[src*="googleusercontent"], img[src*="blob:"]'),
        ).filter((img) => {
          const r = (img as HTMLElement).getBoundingClientRect();
          return r.width >= 44 && r.height >= 44;
        }).length;
        if (local > 0) return local;
      }
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
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            ok:
              (!accept ||
                accept.includes("image") ||
                accept.includes("*") ||
                accept.includes("jfif")) &&
              (r.width > 0 || r.height > 0 || (el as HTMLInputElement).hidden),
            multiple: el.hasAttribute("multiple"),
          };
        }, input);
        if (meta.ok) return { input, multiple: meta.multiple, frame: ctx };
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
  const chooserPromise = page.waitForFileChooser({ timeout: 10_000 }).catch(() => null);
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
    await chooser.accept(filePaths);
    return { ok: true as const, frame: uploadFrame };
  }

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

/** Upload nhiều ảnh cùng lúc nếu input hỗ trợ multiple; fallback từng ảnh. */
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

  if (human) {
    await clickAddPhotoButton(frame, page, human);
  }
  await sleep(rand(300, 600));

  const beforeCount = await countReviewPhotos(frame);
  const found = await findImageFileInput(frame, page);
  const uploadFrame = found?.frame ?? frame;

  if (found?.input && found.multiple && existing.length > 1) {
    await found.input.uploadFile(...existing);
    await found.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const waited = await waitPhotoPreviewIncrease(
      page,
      uploadFrame,
      beforeCount,
      existing.length,
      35_000,
    );
    if (waited.ok) return existing.length;
    const added = Math.max(0, waited.count - beforeCount);
    if (added > 0) return added;
  }

  // Batch qua FileChooser (1 lần accept nhiều file) nếu chưa có multiple input
  if (existing.length > 1 && !found?.multiple) {
    const batch = await uploadViaInputOrChooser(frame, page, existing, human);
    if (batch.ok) {
      const waited = await waitPhotoPreviewIncrease(
        page,
        batch.frame,
        beforeCount,
        existing.length,
        35_000,
      );
      if (waited.ok) return existing.length;
      const added = Math.max(0, waited.count - beforeCount);
      if (added > 0) return added;
    }
  }

  let uploaded = 0;
  for (let i = 0; i < existing.length; i++) {
    const ok = await addImage(frame, page, existing[i], i > 0 || uploaded > 0, human);
    if (ok) uploaded += 1;
    await sleep(rand(900, 1400));
  }
  await dismissNativeFileDialog(page);
  return uploaded;
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

export async function postMapsReview(
  page: Page,
  payload: MapsReviewPayload,
  opts?: {
    proxy?: ProxyAuth | null;
    /** Đưa Chrome lên foreground — launch (1 lần), window (OS), tab (chỉ tab). */
    keepFocus?: (opts?: { os?: "launch" | "window" | "tab" }) => Promise<void>;
  },
): Promise<{
  ok: boolean;
  reviewLink: string | null;
  pointsText: string | null;
  placeUrl: string;
  alreadyReviewed?: boolean;
}> {
  await attachProxyAuthToPage(page, opts?.proxy);
  const keepFocus = async (focusOpts?: { os?: "launch" | "window" | "tab" }) => {
    if (!opts?.keepFocus) return;
    await opts.keepFocus(focusOpts).catch(() => undefined);
  };

  const human = new HumanCursor(page);
  await human.init();

  await keepFocus({ os: "launch" });
  await page.goto(payload.placeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(rand(2200, 3800));
  await keepFocus({ os: "window" });
  await human.warmUp();

  if (await detectExistingReview(page)) {
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
  // Ưu tiên bấm sao trên panel place (thường mở form + đã chọn sao)
  const ratedOnPlace = await tryRateOnPlacePanel(page, payload.rating, human);
  await sleep(rand(600, 1100));

  // Nếu chưa thấy form → bấm "Viết bài đánh giá"
  let frame: Frame | null = null;
  try {
    frame = await waitReviewFrame(page, ratedOnPlace ? 12_000 : 4_000);
  } catch {
    frame = null;
  }
  if (!frame) {
    await clickReviewButton(page, human);
    await sleep(rand(1200, 2000));
    frame = await waitReviewFrame(page);
  }
  await keepFocus({ os: "window" });

  // Chọn / xác nhận sao trên mọi frame (iframe widget + dialog)
  try {
    await selectStar(page, payload.rating, human);
  } catch (e) {
    if (ratedOnPlace) {
      console.warn(
        `[maps-review] selectStar lỗi nhưng đã bấm sao trên place panel — tiếp tục: ${e instanceof Error ? e.message : e}`,
      );
    } else {
      console.warn(
        `[maps-review] selectStar lần 1 lỗi: ${e instanceof Error ? e.message : e} — mở lại form`,
      );
      await clickReviewButton(page, human).catch(() => undefined);
      await sleep(1500);
      frame = await waitReviewFrame(page, 20_000);
      await keepFocus({ os: "window" });
      await selectStar(page, payload.rating, human);
    }
  }
  // Form có thể đổi frame sau khi chọn sao
  frame = await waitReviewFrame(page, 12_000).catch(() => frame);
  await sleep(rand(400, 900));
  await keepFocus({ os: "window" });

  if (!frame) {
    throw new Error("Không tìm thấy form viết đánh giá sau khi chọn sao");
  }

  try {
    await keepFocus({ os: "tab" });
    await enterReview(frame, payload.reviewText, human);
  } catch (e) {
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
