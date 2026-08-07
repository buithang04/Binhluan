/**
 * Cập nhật hồ sơ Google từ trang Personal info.
 * Không dùng deep link (/name, /profile-picture, /addresses) — Google thường chặn.
 * Flow: mở personal-info → bấm đúng hàng cần sửa → điền → Lưu.
 * Semi-auto — dừng NEEDS_MANUAL khi Google bắt "Verify it's you".
 */
import type { Browser, Frame, Page } from "puppeteer";
import type { AccountProfileUpdatePayload } from "@apm/shared";
import { HumanCursor } from "./humanize.js";
import { evalSafe } from "./maps-eval.js";
import { prepareMapsPhotoForUpload, cleanupMapsPhotoTemps } from "./prepare-maps-photo.js";
import {
  pageLooksLikeTotpChallenge,
  tryAutoFillGoogleTotp,
} from "./totp-login.js";

const PERSONAL_INFO_URL = "https://myaccount.google.com/personal-info";

export type ProfileUpdateResult = {
  ok: boolean;
  needsManual: boolean;
  nameUpdated: boolean;
  avatarUpdated: boolean;
  addressUpdated: boolean;
  addressSkipped: boolean;
  detail: string;
  steps: string[];
};

function splitDisplayName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

async function pageNeedsVerify(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    /accounts\.google\.com\/v3\/signin\/challenge|signin\/challenge|signin\/v2/i.test(url)
  ) {
    return true;
  }
  return Boolean(
    await evalSafe<boolean>(
      page,
      `var body = (document.body && document.body.innerText || "").toLowerCase();
       return /verify it'?s you|xác minh đó là bạn|confirm your identity|xác nhận danh tính|enter your password|nhập mật khẩu/i.test(body);`,
    ),
  );
}

/** Quay về / mở trang Personal info (không deep-link mục con). */
async function gotoPersonalInfo(page: Page, human?: HumanCursor): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (!url.includes("/personal-info") || /\/personal-info\/(name|profile-picture)/i.test(url)) {
    await page
      .goto(PERSONAL_INFO_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch(() => undefined);
  }
  await human?.pause(800, 1400);
  return !/accounts\.google\.com\/(v3\/)?signin|ServiceLogin/i.test(page.url());
}

/**
 * Bấm vào hàng mục trên personal-info theo nhãn (Name / Photo / Address…).
 * Ưu tiên link/button trong list item, không goto URL con.
 */
async function clickPersonalInfoRow(
  page: Page,
  labels: RegExp[],
): Promise<boolean> {
  return clickTrustedByLabels(page, labels, {
    selector:
      "a, button, [role='button'], [role='link'], li, [role='listitem']",
  });
}

/** Click thật qua CDP; Google thường bỏ qua MouseEvent giả (isTrusted=false). */
async function clickTrustedByLabels(
  context: Page | Frame,
  labels: RegExp[],
  opts?: { selector?: string },
): Promise<boolean> {
  const handles = await context.$$(
    opts?.selector ?? "button, a, [role='button'], [role='link']",
  );
  const ranked: Array<{ handle: (typeof handles)[number]; score: number }> = [];

  for (const handle of handles) {
    const info = await handle
      .evaluate((el) => {
        const text = (
          (el as HTMLElement).innerText ||
          el.textContent ||
          el.getAttribute("aria-label") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const rect = (el as HTMLElement).getBoundingClientRect();
        return {
          text,
          aria: el.getAttribute("aria-label") || "",
          tag: el.tagName,
          href: el.getAttribute("href") || "",
          visible: rect.width > 1 && rect.height > 1,
        };
      })
      .catch(() => null);
    if (!info?.visible || !info.text || info.text.length > 250) continue;
    const haystack = `${info.text} ${info.aria}`;
    const matchIndex = labels.findIndex((pattern) => pattern.test(haystack));
    if (matchIndex < 0) continue;

    let score = 100 - matchIndex;
    if (info.tag === "A" || info.tag === "BUTTON") score += 20;
    if (info.href.includes("/edit")) score += 15;
    if (info.text.length <= 60) score += 5;
    ranked.push({ handle, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  for (const candidate of ranked) {
    try {
      await candidate.handle.evaluate((el) =>
        (el as HTMLElement).scrollIntoView({
          block: "center",
          inline: "nearest",
        }),
      );
      await candidate.handle.click({ delay: 80 });
      return true;
    } catch {
      // DOM vừa rerender: thử candidate kế tiếp.
    }
  }
  return false;
}

async function typeInputByHint(
  page: Page,
  hint: RegExp,
  value: string,
): Promise<boolean> {
  const handles = await page.$$(
    "input[type='text'], input:not([type]), textarea",
  );
  for (const handle of handles) {
    const info = await handle
      .evaluate((el) => {
        const input = el as HTMLInputElement;
        const rect = input.getBoundingClientRect();
        return {
          hint: `${input.getAttribute("aria-label") || ""} ${
            input.name || ""
          } ${input.id || ""} ${input.placeholder || ""}`,
          visible: rect.width > 1 && rect.height > 1,
        };
      })
      .catch(() => null);
    if (!info?.visible || !hint.test(info.hint)) continue;
    await handle.click({ clickCount: 3 });
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.type(value, { delay: 45 });
    return true;
  }
  return false;
}

async function waitForPhotoFrame(
  page: Page,
  timeoutMs = 10_000,
): Promise<Frame | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const frame = page
      .frames()
      .find((candidate) =>
        /myaccount\.google\.com\/profile-picture(?:\/|\?)/i.test(
          candidate.url(),
        ),
      );
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function clickByLabels(
  page: Page,
  labels: RegExp[],
  _opts?: { scope?: string },
): Promise<boolean> {
  return clickTrustedByLabels(page, labels);
}

/** Đợi panel/dialog chỉnh sửa mở (có input hoặc nút Save). */
async function waitEditSurface(page: Page, ms = 8_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const ready = await evalSafe<boolean>(
      page,
      `var inputs = document.querySelectorAll("input[type='text'], input:not([type]), input[type='file'], textarea");
       var visible = 0;
       for (var i = 0; i < inputs.length; i++) {
         if (inputs[i].offsetParent !== null || inputs[i].getClientRects().length) visible++;
       }
       var body = (document.body && document.body.innerText || "");
       var hasSave = /\\b(Save|Lưu|Done|Xong)\\b/i.test(body);
       return visible > 0 || hasSave;`,
    );
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

async function updateGoogleName(
  page: Page,
  desiredName: string,
  human?: HumanCursor,
  totpSecret?: string | null,
): Promise<{ ok: boolean; needsManual: boolean; detail: string }> {
  const { first, last } = splitDisplayName(desiredName);
  if (!first) return { ok: false, needsManual: false, detail: "Tên trống" };

  if (!(await gotoPersonalInfo(page, human))) {
    return { ok: false, needsManual: true, detail: "Chưa đăng nhập / không vào được Personal info" };
  }
  if (await pageNeedsVerify(page)) {
    return { ok: false, needsManual: true, detail: "Google yêu cầu xác minh khi đổi tên" };
  }

  const opened = await clickPersonalInfoRow(page, [
    /^name(?:\s|$)/i,
    /^tên(?:\s|$)/i,
    /^họ và tên(?:\s|$)/i,
    /your name/i,
    /tên của bạn/i,
  ]);
  if (!opened) {
    return { ok: false, needsManual: false, detail: "Không bấm được mục Tên trên Personal info" };
  }
    {
      const started = Date.now();
      while (
        Date.now() - started < 8_000 &&
        !/\/profile\/name(?:\?|$)/i.test(page.url())
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

  // Google hiện mở trang tổng quan Name trước; phải bấm hàng Name lần hai.
  let hasEditor = /\/profile\/name\/edit(?:\?|$)/i.test(page.url());
  if (!hasEditor) {
    const openedEditor = await clickTrustedByLabels(
      page,
      [
        /^name(?:\s|$)/i,
        /^tên(?:\s|$)/i,
        /^họ và tên(?:\s|$)/i,
        /^edit(?:\s|$)/i,
        /^chỉnh sửa(?:\s|$)/i,
      ],
      { selector: "a[href*='profile/name/edit'], a, button, [role='button']" },
    );
    if (!openedEditor) {
      return {
        ok: false,
        needsManual: false,
        detail: "Đã mở mục Tên nhưng không bấm được hàng Tên lần hai",
      };
    }
    {
      const started = Date.now();
      while (
        Date.now() - started < 8_000 &&
        !/\/profile\/name\/edit(?:\?|$)|signin\/challenge/i.test(page.url())
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    console.log(
      `[profile-update] name editor target url=${page.url()} totp=${Boolean(totpSecret)}`,
    );

    // Đổi tên là thao tác nhạy cảm: Google thường yêu cầu TOTP lần nữa.
    if (
      totpSecret &&
      (await pageLooksLikeTotpChallenge(page).catch(() => false))
    ) {
      const totpResult = await tryAutoFillGoogleTotp(
        page,
        totpSecret,
        human,
      ).catch(() => "failed" as const);
      console.log(
        `[profile-update] name TOTP result=${totpResult} url=${page.url()}`,
      );
      if (totpResult === "filled") {
        const started = Date.now();
        while (Date.now() - started < 12_000) {
          if (/\/profile\/name\/edit(?:\?|$)/i.test(page.url())) break;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        console.log(
          `[profile-update] name after TOTP wait url=${page.url()}`,
        );
      }
    }

    if (await pageNeedsVerify(page)) {
      return {
        ok: false,
        needsManual: true,
        detail: "Google yêu cầu xác minh TOTP trước khi sửa tên",
      };
    }

    hasEditor =
      /\/profile\/name\/edit(?:\?|$)/i.test(page.url()) &&
      (await waitEditSurface(page, 8_000));
  }
  if (!hasEditor) {
    return {
      ok: false,
      needsManual: false,
      detail: "Đã mở mục Tên nhưng không thấy form chỉnh sửa",
    };
  }

  if (await pageNeedsVerify(page)) {
    return { ok: false, needsManual: true, detail: "Google yêu cầu xác minh khi mở sửa tên" };
  }

  let filled =
    (await typeInputByHint(page, /first|given|tên(?! họ)/i, first)) ||
    (await typeInputByHint(page, /first name|tên/i, first));
  if (last) {
    filled =
      (await typeInputByHint(page, /last|family|họ/i, last)) || filled;
  }

  if (!filled) {
    return {
      ok: false,
      needsManual: false,
      detail: "Không tìm thấy ô First name / Last name",
    };
  }

  await human?.pause(400, 800);
  const saved = await clickByLabels(page, [/^save$/i, /^lưu$/i, /save changes/i, /lưu thay đổi/i]);
  if (!saved) {
    return { ok: false, needsManual: false, detail: "Không tìm thấy nút Lưu tên" };
  }
  await human?.pause(1200, 2000);
  if (await pageNeedsVerify(page)) {
    return { ok: false, needsManual: true, detail: "Xác minh tay sau khi Lưu tên" };
  }

  // Về lại personal-info cho bước sau
  await gotoPersonalInfo(page, human);

  const bodyHasName = await evalSafe<boolean>(
    page,
    `var body = (document.body && document.body.innerText || "").toLowerCase();
     return body.indexOf(${JSON.stringify(first.toLowerCase())}) >= 0;`,
  );
  return {
    ok: Boolean(bodyHasName),
    needsManual: false,
    detail: bodyHasName ? "Đã đổi tên" : "Đã lưu tên (chưa thấy trên Personal info)",
  };
}

async function uploadProfilePhoto(
  page: Page,
  filePath: string,
  human?: HumanCursor,
): Promise<{ ok: boolean; needsManual: boolean; detail: string }> {
  const prepared = await prepareMapsPhotoForUpload(filePath);
  const tempPaths = prepared.tempPaths;

  try {
    if (!(await gotoPersonalInfo(page, human))) {
      return { ok: false, needsManual: true, detail: "Không vào được Personal info để đổi ảnh" };
    }
    if (await pageNeedsVerify(page)) {
      return { ok: false, needsManual: true, detail: "Google yêu cầu xác minh khi đổi ảnh" };
    }

    const opened = await clickPersonalInfoRow(page, [
      /profile picture/i,
      /ảnh hồ sơ/i,
      /ảnh đại diện/i,
      /^photo$/i,
      /^ảnh$/i,
      /change photo/i,
      /đổi ảnh/i,
    ]);
    if (!opened) {
      return { ok: false, needsManual: false, detail: "Không bấm được mục Ảnh hồ sơ trên Personal info" };
    }
    await human?.pause(700, 1200);
    const photoFrame = await waitForPhotoFrame(page);
    if (!photoFrame) {
      return {
        ok: false,
        needsManual: false,
        detail: "Đã bấm Ảnh hồ sơ nhưng không thấy cửa sổ chọn ảnh",
      };
    }

    if (await pageNeedsVerify(page)) {
      return { ok: false, needsManual: true, detail: "Xác minh tay khi mở đổi ảnh" };
    }

    const input = await photoFrame.$('input[type="file"]');
    if (input) {
      await input.uploadFile(prepared.path);
      await input.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } else {
      const chooserPromise = page.waitForFileChooser({ timeout: 12_000 }).catch(() => null);
      const uploadClicked = await clickTrustedByLabels(photoFrame, [
        /upload from device/i,
        /\bupload\b/i,
        /tải lên từ thiết bị/i,
        /tải lên/i,
        /from computer/i,
        /từ máy tính/i,
      ]);
      if (!uploadClicked) {
        return {
          ok: false,
          needsManual: false,
          detail: "Không bấm được nút Upload from device trong cửa sổ ảnh",
        };
      }
      const chooser = await chooserPromise;
      if (!chooser) {
        return { ok: false, needsManual: false, detail: "Không mở được upload ảnh đại diện" };
      }
      await chooser.accept([prepared.path]);
    }

    await human?.pause(1500, 2500);
    // Picker có thể có 2 bước: Next → Save as profile picture.
    let confirmed = false;
    const confirmStarted = Date.now();
    while (Date.now() - confirmStarted < 18_000) {
      const currentFrame = await waitForPhotoFrame(page, 2_000);
      if (!currentFrame) {
        if (confirmed) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      const clicked = await clickTrustedByLabels(currentFrame, [
        /^save as profile picture(?:\s|$)/i,
        /^set as profile picture(?:\s|$)/i,
        /^save(?:\s|$)/i,
        /^lưu(?:\s|$)/i,
        /^đặt làm ảnh(?:\s|$)/i,
        /^next(?:\s|$)/i,
        /^tiếp theo(?:\s|$)/i,
        /^done(?:\s|$)/i,
        /^xong(?:\s|$)/i,
      ]);
      if (clicked) {
        confirmed = true;
        await human?.pause(900, 1500);
      } else {
        // Sau khi chọn file, iframe chuyển từ picker → crop; chờ nút Save xuất hiện.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!confirmed) {
      return {
        ok: false,
        needsManual: false,
        detail: "Đã chọn file nhưng không tìm thấy nút Lưu ảnh",
      };
    }

    if (await pageNeedsVerify(page)) {
      return { ok: false, needsManual: true, detail: "Xác minh tay sau upload avatar" };
    }

    await gotoPersonalInfo(page, human);
    return { ok: true, needsManual: false, detail: "Đã upload avatar" };
  } finally {
    await cleanupMapsPhotoTemps(tempPaths);
  }
}

async function tryUpdateAddress(
  page: Page,
  address: string,
  human?: HumanCursor,
): Promise<{ ok: boolean; needsManual: boolean; skipped: boolean; detail: string }> {
  if (!(await gotoPersonalInfo(page, human))) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Không vào được Personal info để sửa địa chỉ",
    };
  }
  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Google yêu cầu xác minh khi sửa địa chỉ",
    };
  }

  // Địa chỉ thường nằm ở Contact info / Addresses — bấm từ personal-info hoặc mục liên quan.
  let opened = await clickPersonalInfoRow(page, [
    /^address$/i,
    /^địa chỉ$/i,
    /home address/i,
    /địa chỉ nhà/i,
    /contact info/i,
    /thông tin liên hệ/i,
    /addresses/i,
  ]);

  // Nếu vào Contact info trước, bấm tiếp Address bên trong (vẫn không deep-link).
  if (opened) {
    await human?.pause(700, 1200);
    await waitEditSurface(page);
    const deeper = await clickPersonalInfoRow(page, [
      /home address/i,
      /địa chỉ nhà/i,
      /^address$/i,
      /^địa chỉ$/i,
      /add address/i,
      /thêm địa chỉ/i,
    ]);
    if (deeper) {
      await human?.pause(600, 1000);
      await waitEditSurface(page);
    }
  }

  if (!opened) {
    // Fallback: mục Edit trong khu vực địa chỉ nếu text có trên trang
    opened = await clickByLabels(page, [
      /home address/i,
      /địa chỉ nhà/i,
      /add address/i,
      /thêm địa chỉ/i,
    ]);
  }

  if (!opened) {
    return {
      ok: false,
      needsManual: false,
      skipped: true,
      detail: "Không thấy mục Địa chỉ trên Personal info (bỏ qua)",
    };
  }

  await human?.pause(600, 1000);
  await clickByLabels(page, [/^edit$/i, /^chỉnh sửa$/i, /add address/i, /thêm địa chỉ/i]);
  await human?.pause(500, 900);

  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Xác minh tay khi mở form địa chỉ",
    };
  }

  const filled = await evalSafe<boolean>(
    page,
    `var inputs = Array.prototype.slice.call(document.querySelectorAll("input[type='text'], textarea"));
     for (var i = 0; i < inputs.length; i++) {
       var el = inputs[i];
       if (el.offsetParent === null && el.getClientRects().length === 0) continue;
       var ctx = ((el.getAttribute("aria-label") || "") + " " + (el.placeholder || "")).toLowerCase();
       if (/street|address|địa chỉ|search|tìm/i.test(ctx) || inputs.length <= 3) {
         el.focus();
         el.value = ${JSON.stringify(address)};
         el.dispatchEvent(new Event("input", { bubbles: true }));
         el.dispatchEvent(new Event("change", { bubbles: true }));
         return true;
       }
     }
     return false;`,
  );
  if (!filled) {
    return {
      ok: false,
      needsManual: false,
      skipped: true,
      detail: "Không điền được ô địa chỉ",
    };
  }

  await human?.pause(800, 1200);
  // Chọn gợi ý đầu nếu có (autocomplete)
  await evalSafe(
    page,
    `var opts = document.querySelectorAll("[role='option'], li[data-value], .pac-item");
     if (opts[0]) { opts[0].dispatchEvent(new MouseEvent("click", { bubbles: true })); if (opts[0].click) opts[0].click(); }`,
  );
  await human?.pause(500, 900);

  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Xác minh tay khi lưu địa chỉ",
    };
  }

  const saved = await clickByLabels(page, [/^save$/i, /^lưu$/i]);
  if (!saved) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Đã điền địa chỉ — cần chọn gợi ý / Lưu tay",
    };
  }
  await human?.pause(1200, 2000);
  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      needsManual: true,
      skipped: false,
      detail: "Xác minh tay sau Lưu địa chỉ",
    };
  }

  await gotoPersonalInfo(page, human);
  return { ok: true, needsManual: false, skipped: false, detail: "Đã thử lưu địa chỉ" };
}

export async function updateGoogleProfile(
  page: Page,
  payload: AccountProfileUpdatePayload,
  opts?: {
    human?: HumanCursor;
    signal?: AbortSignal;
    totpSecret?: string | null;
  },
): Promise<ProfileUpdateResult> {
  const human = opts?.human ?? new HumanCursor(page);
  const steps: string[] = [];
  let nameUpdated = false;
  let avatarUpdated = false;
  let addressUpdated = false;
  let addressSkipped = false;
  let needsManual = false;

  const doName = payload.updateName !== false && Boolean(payload.desiredName?.trim());
  const doAvatar =
    payload.updateAvatar !== false && Boolean(payload.avatarLocalPath?.trim());
  const doAddress =
    payload.updateAddress !== false && Boolean(payload.desiredAddress?.trim());

  if (!doName && !doAvatar && !doAddress) {
    return {
      ok: false,
      needsManual: false,
      nameUpdated: false,
      avatarUpdated: false,
      addressUpdated: false,
      addressSkipped: false,
      detail: "Không có dữ liệu hồ sơ cần cập nhật",
      steps,
    };
  }

  if (!(await gotoPersonalInfo(page, human))) {
    return {
      ok: false,
      needsManual: true,
      nameUpdated: false,
      avatarUpdated: false,
      addressUpdated: false,
      addressSkipped: false,
      detail: "Không vào được Personal info",
      steps,
    };
  }
  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      needsManual: true,
      nameUpdated: false,
      avatarUpdated: false,
      addressUpdated: false,
      addressSkipped: false,
      detail: "Verify it's you trước Personal info",
      steps,
    };
  }

  // Ảnh trước: đổi tên thường kích hoạt TOTP và có thể phải dừng chờ xác minh.
  if (doAvatar) {
    opts?.signal?.throwIfAborted?.();
    const avatarOut = await uploadProfilePhoto(page, payload.avatarLocalPath!.trim(), human);
    steps.push(`avatar: ${avatarOut.detail}`);
    avatarUpdated = avatarOut.ok;
    if (avatarOut.needsManual) needsManual = true;
  }

  if (doName && !needsManual) {
    opts?.signal?.throwIfAborted?.();
    const nameOut = await updateGoogleName(
      page,
      payload.desiredName!.trim(),
      human,
      opts?.totpSecret,
    );
    steps.push(`name: ${nameOut.detail}`);
    nameUpdated = nameOut.ok;
    if (nameOut.needsManual) needsManual = true;
  }

  if (doAddress && !needsManual) {
    opts?.signal?.throwIfAborted?.();
    const addrOut = await tryUpdateAddress(page, payload.desiredAddress!.trim(), human);
    steps.push(`address: ${addrOut.detail}`);
    addressUpdated = addrOut.ok;
    addressSkipped = addrOut.skipped;
    if (addrOut.needsManual) needsManual = true;
  }

  const allRequestedOk =
    (!doName || nameUpdated) &&
    (!doAvatar || avatarUpdated) &&
    (!doAddress || addressUpdated);
  const detail = steps.join(" · ") || "Không có bước nào chạy";

  return {
    // Không báo SYNCED khi chỉ địa chỉ thành công nhưng tên/ảnh thất bại.
    ok: allRequestedOk && !needsManual,
    needsManual,
    nameUpdated,
    avatarUpdated,
    addressUpdated,
    addressSkipped,
    detail,
    steps,
  };
}

export type ScanGoogleProfileResult = {
  ok: boolean;
  name: string | null;
  avatarUrl: string | null;
  detail: string;
  needsManual: boolean;
};

const PROFILE_PICTURE_URL = "https://myaccount.google.com/profile-picture";

async function extractDisplayedName(page: Page): Promise<string | null> {
  try {
    const name = await evalSafe<string>(page, `
      (function() {
        var el = document.querySelector('[data-profile-name], [data-name], [href*="/name"]');
        if (!el) {
          var headings = document.querySelectorAll('h1, h2, [role="heading"]');
          for (var i = 0; i < headings.length; i++) {
            var t = headings[i].innerText.trim();
            if (t && t.length > 1 && t.length < 100 && !/^\\d+$/.test(t)) return t;
          }
          return null;
        }
        return (el.getAttribute('data-profile-name') || el.getAttribute('data-name') || el.innerText || '').trim() || null;
      })();
    `);
    return name || null;
  } catch {
    return null;
  }
}

async function extractAvatarUrl(page: Page): Promise<string | null> {
  try {
    const src = await evalSafe<string | null>(page, `
      (function() {
        var el = document.querySelector('img[src*="googleusercontent.com"], img[src*="google.com/vp"], img[alt*="profile" i], img[alt*="avatar" i], img.Bu');
        if (!el) return null;
        var src = el.src || '';
        if (!src || src.length < 10) return null;
        // Lấy URL đầy đủ không crop
        src = src.replace(/=s\\d+(?:-c|$)/, '=s2048');
        src = src.replace(/=w\\d+(?:-c|$)/, '=s2048');
        src = src.replace(/\\?sz=\\d+/, '?sz=2048');
        return src;
      })();
    `);
    return src || null;
  } catch {
    return null;
  }
}

export async function scanGoogleProfile(
  page: Page,
  _payload: { accountId: string },
  opts?: { human?: HumanCursor; signal?: AbortSignal },
): Promise<ScanGoogleProfileResult> {
  const human = opts?.human ?? new HumanCursor(page);
  let name: string | null = null;
  let avatarUrl: string | null = null;

  // 1. Điều hướng đến trang Personal Info
  try {
    await page.goto("https://myaccount.google.com/personal-info", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await human.pause(1200, 2200);
  } catch {
    return {
      ok: false,
      name: null,
      avatarUrl: null,
      detail: "Không mở được Personal info",
      needsManual: false,
    };
  }

  if (await pageNeedsVerify(page)) {
    return {
      ok: false,
      name: null,
      avatarUrl: null,
      detail: "Verify it's you — cần xác minh trước",
      needsManual: true,
    };
  }

  name = await extractDisplayedName(page);

  // 2. Điều hướng đến trang Profile Picture
  try {
    await page.goto(PROFILE_PICTURE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await human.pause(800, 1600);
  } catch {
    // Vẫn trả về name nếu có
  }

  avatarUrl = await extractAvatarUrl(page);

  if (!name && !avatarUrl) {
    return {
      ok: false,
      name: null,
      avatarUrl: null,
      detail: "Không đọc được tên hay avatar",
      needsManual: false,
    };
  }

  return {
    ok: true,
    name,
    avatarUrl,
    detail: [name ? `Tên: ${name}` : null, avatarUrl ? "Avatar: có" : null]
      .filter(Boolean)
      .join(" · ") || "Không có dữ liệu",
    needsManual: false,
  };
}

export type { Browser, Page };
