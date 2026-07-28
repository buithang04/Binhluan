/**
 * Google LOGIN — lấy mã TOTP từ 2fa.live và điền khi Google hỏi 2FA.
 * API: GET https://2fa.live/tok/{secret} → { "token": "123456" }
 */
import type { Page } from "puppeteer";
import { request as httpsRequest } from "https";

export function normalizeTotpSecret(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  const fromUri = s.match(/[?&]secret=([A-Za-z2-7]+)/i);
  if (fromUri?.[1]) s = fromUri[1];
  return s
    .replace(/[\s\-]+/g, "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

function fetchJson(url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 120)}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/** Gọi 2fa.live lấy mã 6 số hiện tại. */
export async function fetchTotpToken(secretRaw: string): Promise<string> {
  const secret = normalizeTotpSecret(secretRaw);
  if (secret.length < 16) {
    throw new Error("TOTP secret quá ngắn");
  }
  const url = `https://2fa.live/tok/${encodeURIComponent(secret.toLowerCase())}`;
  const body = await fetchJson(url);
  let token = "";
  try {
    const parsed = JSON.parse(body) as { token?: string; code?: string; otp?: string };
    token = String(parsed.token || parsed.code || parsed.otp || "").trim();
  } catch {
    token = body.replace(/\D/g, "").slice(0, 8);
  }
  const digits = token.replace(/\D/g, "");
  if (digits.length < 6) {
    throw new Error(`2fa.live không trả mã hợp lệ (body=${body.slice(0, 80)})`);
  }
  return digits.slice(0, 6);
}

const TOTP_INPUT_SELS = [
  'input[name="totpPin"]',
  "input#totpPin",
  'input[id="totpPin"]',
  'input[name="Pin"]',
  'input[autocomplete="one-time-code"]',
  'input[aria-label*="code" i]',
  'input[aria-label*="mã" i]',
  'input[type="tel"][maxlength="6"]',
  'input[type="tel"][maxlength="8"]',
  'input[type="text"][maxlength="6"]',
];

type HumanLike = {
  typeText: (sel: string, text: string) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clickElement: (el: any, clicks?: number) => Promise<unknown>;
  pause: (a: number, b: number) => Promise<unknown>;
};

async function findVisibleTotpInput(page: Page): Promise<string | null> {
  for (const sel of TOTP_INPUT_SELS) {
    const ok = await page
      .evaluate((s) => {
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }, sel)
      .catch(() => false);
    if (ok) return sel;
  }
  return null;
}

/** Trang “Try another way” → chọn Authenticator app. */
async function pickAuthenticatorMethod(page: Page, human?: HumanLike): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const texts = [
      "google authenticator",
      "authenticator app",
      "authentication app",
      "get a verification code from the google authenticator app",
      "ứng dụng xác thực",
      "ứng dụng google authenticator",
      "nhận mã từ ứng dụng",
      "dùng ứng dụng",
    ];
    const nodes = Array.from(
      document.querySelectorAll('div[role="link"], li, button, a, div[data-challengeid], div[jsname]'),
    );
    for (const el of nodes) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (!t || t.length > 200) continue;
      if (texts.some((x) => t.includes(x))) {
        (el as HTMLElement).click();
        return t.slice(0, 80);
      }
    }
    // Fallback: nút có data-challengetype totp / idvTotpPin
    const byAttr =
      document.querySelector('[data-challengetype="6"]') ||
      document.querySelector('[data-challengeid="6"]') ||
      document.querySelector('div[data-action="selectchallenge"]');
    if (byAttr) {
      (byAttr as HTMLElement).click();
      return "attr-totp";
    }
    return null;
  });
  if (clicked) {
    console.log(`[totp] chọn phương thức 2FA: ${clicked}`);
    if (human) await human.pause(800, 1500);
    else await new Promise((r) => setTimeout(r, 1000));
    return true;
  }
  return false;
}

async function clickTryAnotherWay(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const needles = ["try another way", "thử cách khác", "try another", "cách khác"];
    const els = Array.from(document.querySelectorAll("button, a, span, div[role='link']"));
    for (const el of els) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (needles.some((n) => t.includes(n)) && t.length < 80) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
}

export async function pageLooksLikeTotpChallenge(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (
    url.includes("challenge/totp") ||
    url.includes("challenge/ipp") ||
    url.includes("challenge/sk") ||
    url.includes("/challenge/")
  ) {
    if (await findVisibleTotpInput(page)) return true;
  }
  const text = (
    await page.evaluate(() => document.body?.innerText?.slice(0, 2500) || "").catch(() => "")
  ).toLowerCase();
  if (
    text.includes("2-step") ||
    text.includes("2 bước") ||
    text.includes("authenticator") ||
    text.includes("verification code") ||
    text.includes("mã xác minh") ||
    text.includes("enter the code") ||
    text.includes("nhập mã")
  ) {
    return true;
  }
  return Boolean(await findVisibleTotpInput(page));
}

/**
 * Tự lấy mã từ 2fa.live và điền form Google TOTP.
 * Trả về: filled | no_input | no_secret | failed
 */
export async function tryAutoFillGoogleTotp(
  page: Page,
  totpSecret: string | null | undefined,
  human?: HumanLike,
): Promise<"filled" | "no_input" | "no_secret" | "already" | "failed"> {
  const secret = totpSecret ? normalizeTotpSecret(totpSecret) : "";
  if (!secret) return "no_secret";

  // Có thể đang ở “Try another way” — chọn Authenticator
  let inputSel = await findVisibleTotpInput(page);
  if (!inputSel) {
    const challengeish = await pageLooksLikeTotpChallenge(page);
    if (challengeish) {
      await clickTryAnotherWay(page).catch(() => false);
      await new Promise((r) => setTimeout(r, 900));
      await pickAuthenticatorMethod(page, human).catch(() => false);
      await new Promise((r) => setTimeout(r, 1200));
      inputSel = await findVisibleTotpInput(page);
    }
  }
  if (!inputSel) return "no_input";

  const already = await page
    .evaluate((s) => {
      const el = document.querySelector(s) as HTMLInputElement | null;
      return !!el && (el.value || "").replace(/\D/g, "").length >= 6;
    }, inputSel)
    .catch(() => false);
  if (already) return "already";

  try {
    const token = await fetchTotpToken(secret);
    console.log(`[totp] 2fa.live OK — điền mã (${token.length} số)`);

    // Clear + type
    await page.click(inputSel, { clickCount: 3 }).catch(() => undefined);
    await page.evaluate((s) => {
      const el = document.querySelector(s) as HTMLInputElement | null;
      if (el) el.value = "";
    }, inputSel);

    if (human) {
      await human.typeText(inputSel, token);
      await human.pause(400, 800);
    } else {
      await page.type(inputSel, token, { delay: 50 });
      await new Promise((r) => setTimeout(r, 500));
    }

    const next =
      (await page.$("#totpNext")) ||
      (await page.$("#idvPreregisteredEmailNext")) ||
      (await page.$('button[jsname="LgbsSe"]'));

    let clicked = false;
    if (next) {
      if (human) await human.clickElement(next);
      else await next.click();
      clicked = true;
    } else {
      clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const label = (t: string) =>
          /^(next|tiếp theo|verify|xác minh|done|xong)$/i.test(t.trim()) ||
          t.trim().toLowerCase() === "next";
        for (const b of buttons) {
          const t = (b.textContent || "").trim();
          if (label(t) && !(b as HTMLButtonElement).disabled) {
            (b as HTMLButtonElement).click();
            return true;
          }
        }
        return false;
      });
    }
    if (!clicked) await page.keyboard.press("Enter");

    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 25_000 })
      .catch(() => undefined);
    return "filled";
  } catch (e) {
    console.warn("[totp] auto-fill failed:", e instanceof Error ? e.message : e);
    return "failed";
  }
}
