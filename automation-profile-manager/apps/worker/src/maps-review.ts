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

async function waitReviewFrame(page: Page, timeoutMs = 25000): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (!/ReviewsService\.LoadWriteWidget|writereview|WriteWidget/i.test(url)) {
        continue;
      }
      try {
        const has = await frame.evaluate(
          () =>
            !!document.querySelector(
              'textarea, div[role="radiogroup"], [data-rating], button[jsname="IJM3w"]',
            ),
        );
        if (has) return frame;
      } catch {
        /* ignore */
      }
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if (await frame.$("textarea")) return frame;
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
  }
  throw new Error("Không tìm thấy iframe form đánh giá");
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

async function selectStar(frame: Frame, value: number, human: HumanCursor) {
  await prepareReviewForm(frame);

  let starEl: ElementHandle<Element> | null =
    (await frame.$(`div[role="radiogroup"] [data-rating="${value}"]`)) ||
    (await frame.$(`div[role="radiogroup"] div.s2xyy[data-rating="${value}"]`));

  if (!starEl) {
    const clickables = await frame.$$(
      'div[role="radiogroup"] [role="radio"], div[role="radiogroup"] .s2xyy',
    );
    starEl = clickables[value - 1] ?? clickables[clickables.length - 1] ?? null;
  }

  if (!starEl) throw new Error(`Không chọn được ${value} sao`);

  await human.clickElement(starEl);
  await sleep(rand(180, 420));

  for (let i = 0; i < 15; i++) {
    await dismissCancelReviewPrompt(frame);
    const enabled = await frame.evaluate(() => {
      const b = document.querySelector('button[jsname="IJM3w"]') as HTMLButtonElement | null;
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    });
    if (enabled) return;
    if (i === 5 || i === 10) {
      await human.clickElement(starEl).catch(() => undefined);
    }
    await sleep(400);
  }
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
    "textarea",
  ];
  const body = text.trim();
  if (!body) throw new Error("Nội dung đánh giá trống");
  const minFilled = Math.min(8, body.length);

  // Đóng popover ⓘ che form trước khi thao tác
  await closeInfoPopover(frame);

  const filledLen = async (sel: string) =>
    frame.evaluate((s) => {
      const ta = document.querySelector(s) as HTMLTextAreaElement | null;
      return (ta?.value || "").trim().length;
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

    // 4) Fallback cuối: set value trực tiếp qua native setter (React nhận input)
    await frame
      .evaluate(
        (s, val) => {
          const ta = document.querySelector(s) as HTMLTextAreaElement | null;
          if (!ta) return;
          const proto = window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(ta, val);
          else ta.value = val;
          ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
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
      await frame.evaluate((r) => {
        const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
        if (ta) {
          ta.focus();
          ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: ta.value }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
        document
          .querySelectorAll('div[role="radiogroup"]')[0]
          ?.querySelector(`[data-rating="${r}"]`)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }, rating);
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
  return frame.evaluate(
    () =>
      document.querySelectorAll(
        'img[src*="googleusercontent"], img[src*="lh3."], [data-photo-id]',
      ).length,
  );
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

async function findImageFileInput(frame: Frame, page: Page) {
  for (const ctx of [frame, page.mainFrame(), ...page.frames()]) {
    try {
      const inputs = await ctx.$$('input[type="file"]');
      for (const input of inputs) {
        const meta = await ctx.evaluate((el) => {
          const accept = (el.getAttribute("accept") || "").toLowerCase();
          return {
            ok: !accept || accept.includes("image") || accept.includes("*") || accept.includes("jfif"),
            multiple: el.hasAttribute("multiple"),
          };
        }, input);
        if (meta.ok) return { input, multiple: meta.multiple };
      }
      if (inputs[0]) return { input: inputs[0], multiple: false };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Upload ảnh không để lại hộp thoại Windows Open.
 * Ưu tiên input.uploadFile; chỉ click "Thêm ảnh" kèm waitForFileChooser + accept ngay.
 */
async function uploadViaInputOrChooser(
  frame: Frame,
  page: Page,
  filePaths: string[],
) {
  const found = await findImageFileInput(frame, page);
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
    return true;
  }

  // Chưa có input — bấm Thêm ảnh nhưng phải bắt FileChooser ngay, không để dialog treo
  const chooserPromise = page.waitForFileChooser({ timeout: 10_000 }).catch(() => null);
  await frame.evaluate(() => {
    const el =
      document.querySelector(
        'div.nNzjpf-cS4Vcb-PvZLI-Ueh9jd-haAclf, button[aria-label*="Thêm ảnh" i], button[aria-label*="Add photo" i]',
      ) ||
      [...document.querySelectorAll("button, div[role='button']")].find((b) =>
        /Thêm ảnh|Add photo|Thêm hình/i.test(b.textContent || ""),
      );
    (el as HTMLElement | undefined)?.click();
  });
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.accept(filePaths);
    return true;
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
    return true;
  }

  await dismissNativeFileDialog(page);
  return false;
}

async function addImage(
  frame: Frame,
  page: Page,
  filePath?: string | null,
  _isAdditional = false,
) {
  if (!filePath || !existsSync(filePath)) return false;
  const beforeCount = await countReviewPhotos(frame);
  const ok = await uploadViaInputOrChooser(frame, page, [filePath]);
  if (!ok) {
    await dismissNativeFileDialog(page);
    return false;
  }
  for (let i = 0; i < 25; i++) {
    const count = await countReviewPhotos(frame);
    if (count > beforeCount) return true;
    await sleep(400);
  }
  await dismissNativeFileDialog(page);
  return true;
}

/** Upload nhiều ảnh cùng lúc nếu input hỗ trợ multiple; fallback từng ảnh. */
async function addImages(frame: Frame, page: Page, filePaths: string[]) {
  const existing = filePaths.filter((p) => existsSync(p));
  if (!existing.length) return 0;

  const beforeCount = await countReviewPhotos(frame);
  const found = await findImageFileInput(frame, page);

  if (found?.input && found.multiple && existing.length > 1) {
    await found.input.uploadFile(...existing);
    await found.input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (let i = 0; i < 40; i++) {
      const count = await countReviewPhotos(frame);
      if (count >= beforeCount + existing.length) return existing.length;
      if (count > beforeCount && i > 15) return count - beforeCount;
      await sleep(400);
    }
    const after = await countReviewPhotos(frame);
    if (after > beforeCount) return after - beforeCount;
  }

  // Batch qua FileChooser (1 lần accept nhiều file) nếu chưa có multiple input
  if (existing.length > 1 && !found?.multiple) {
    const batchOk = await uploadViaInputOrChooser(frame, page, existing);
    if (batchOk) {
      for (let i = 0; i < 40; i++) {
        const count = await countReviewPhotos(frame);
        if (count >= beforeCount + existing.length) return existing.length;
        if (count > beforeCount && i > 15) return count - beforeCount;
        await sleep(400);
      }
      const after = await countReviewPhotos(frame);
      if (after > beforeCount) return after - beforeCount;
    }
  }

  let uploaded = 0;
  for (let i = 0; i < existing.length; i++) {
    const ok = await addImage(frame, page, existing[i], i > 0 || uploaded > 0);
    if (ok) uploaded += 1;
    await sleep(800);
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
    /** Đưa Chrome lên foreground trước mỗi bước quan trọng (tránh treo khi mất focus). */
    keepFocus?: () => Promise<void>;
  },
): Promise<{
  ok: boolean;
  reviewLink: string | null;
  pointsText: string | null;
  placeUrl: string;
  alreadyReviewed?: boolean;
}> {
  await attachProxyAuthToPage(page, opts?.proxy);
  const keepFocus = async () => {
    if (!opts?.keepFocus) return;
    await opts.keepFocus().catch(() => undefined);
  };

  const human = new HumanCursor(page);
  await human.init();

  await keepFocus();
  await page.goto(payload.placeUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(rand(2200, 3800));
  await keepFocus();
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

  await keepFocus();
  await clickReviewButton(page, human);
  await sleep(rand(900, 1400));
  const frame = await waitReviewFrame(page);
  await keepFocus();
  await selectStar(frame, payload.rating, human);
  await sleep(rand(400, 900));
  await keepFocus();
  await enterReview(frame, payload.reviewText, human);
  const imagePaths =
    payload.imagePaths?.filter(Boolean) ??
    (payload.imagePath ? [payload.imagePath] : []);
  await keepFocus();
  const uploaded = imagePaths.length
    ? await addImages(frame, page, imagePaths)
    : 0;
  if (imagePaths.length && uploaded < imagePaths.length) {
    console.warn(
      `[maps-review] uploaded ${uploaded}/${imagePaths.length} image(s)`,
    );
  } else if (uploaded > 0) {
    console.log(`[maps-review] uploaded ${uploaded} image(s)`);
  }
  await sleep(rand(800, 1500));
  await keepFocus();
  await submitReview(frame, payload.rating, human);
  await keepFocus();
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
    await keepFocus();
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
