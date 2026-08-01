import "server-only";
import type { ReviewVisibility } from "@prisma/client";
import { withMapsPage } from "@/lib/google-maps-scraper";

export type VerifyReviewInput = {
  reviewLink?: string | null;
  googleMapsUrl: string;
  resolvedUrl?: string | null;
  reviewText: string;
  stars?: number | null;
};

export type VerifyReviewResult = {
  visibility: ReviewVisibility;
  detail: string;
};

function normalizeSnippet(text: string, maxLen = 48): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .toLowerCase();
}

const DETECT_VISIBILITY = `((snippet, stars) => {
  const body = (document.body?.innerText || "").toLowerCase();
  const deleted =
    /bài đánh giá này không còn|this review is no longer available|review has been removed|đã bị xóa|no longer available/i.test(
      body,
    );
  if (deleted) return { kind: "deleted" };

  const snip = String(snippet || "").trim().toLowerCase();
  if (snip.length >= 8 && body.includes(snip.slice(0, Math.min(snip.length, 48)))) {
    return { kind: "visible" };
  }

  const reviewBlocks = Array.from(
    document.querySelectorAll(
      "div.jftiEf, div.MyEned, span.wiI7pd, div[data-review-id], div[jslog*='review']",
    ),
  );
  for (const el of reviewBlocks) {
    const t = (el.textContent || "").toLowerCase();
    if (snip.length >= 8 && t.includes(snip.slice(0, Math.min(snip.length, 48)))) {
      return { kind: "visible" };
    }
    if (stars && t.includes(String(stars) + " sao")) {
      if (snip.length >= 8 && t.includes(snip.slice(0, 24))) return { kind: "visible" };
    }
  }

  if (/sign in|đăng nhập|consent\.google/i.test(body) && body.length < 4000) {
    return { kind: "unknown", reason: "login" };
  }

  return { kind: "missing" };
})`;

async function openReviewsFeed(page: import("puppeteer").Page) {
  await page
    .evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button[role='tab'], button")) as HTMLButtonElement[];
      const hit = tabs.find((b) =>
        /bài đánh giá|reviews?/i.test((b.textContent || b.getAttribute("aria-label") || "").trim()),
      );
      if (hit) hit.click();
    })
    .catch(() => undefined);
  await page
    .waitForSelector("div.jftiEf, span.wiI7pd, .jANrlb", { timeout: 5000 })
    .catch(() => null);
  await new Promise((r) => setTimeout(r, 400));
}

/** Quét Maps (headless) — review còn hiển thị hay đã mất. */
export async function verifyReviewOnMaps(
  input: VerifyReviewInput,
): Promise<VerifyReviewResult> {
  const snippet = normalizeSnippet(input.reviewText);
  if (snippet.length < 8 && !input.reviewLink?.trim()) {
    return {
      visibility: "UNKNOWN",
      detail: "Thiếu nội dung để đối chiếu",
    };
  }

  return withMapsPage(async (page) => {
    const stars = input.stars ?? null;

    if (input.reviewLink?.trim()) {
      const link = input.reviewLink.trim();
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 25000 });
        await new Promise((r) => setTimeout(r, 800));
        const hit = (await page.evaluate(DETECT_VISIBILITY, snippet, stars)) as {
          kind: string;
          reason?: string;
        };

        if (hit.kind === "deleted") {
          return { visibility: "DELETED", detail: "Link review báo đã xóa / không còn" };
        }
        if (hit.kind === "visible") {
          return { visibility: "VISIBLE", detail: "Tìm thấy nội dung review trên trang link" };
        }
        if (hit.kind === "unknown") {
          return { visibility: "UNKNOWN", detail: "Không quét được (cần đăng nhập?)" };
        }
      } catch {
        /* fallback place page */
      }
    }

    const placeUrl = (input.resolvedUrl || input.googleMapsUrl).trim();
    const withHl = placeUrl.includes("hl=") ? placeUrl : `${placeUrl}${placeUrl.includes("?") ? "&" : "?"}hl=vi`;

    try {
      await page.goto(withHl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForSelector("h1, div.F7nice", { timeout: 8000 }).catch(() => null);
      await openReviewsFeed(page);

      for (let i = 0; i < 3; i++) {
        const hit = (await page.evaluate(DETECT_VISIBILITY, snippet, stars)) as {
          kind: string;
        };
        if (hit.kind === "visible") {
          return { visibility: "VISIBLE", detail: "Review còn trên trang địa điểm" };
        }
        if (hit.kind === "deleted") {
          return { visibility: "DELETED", detail: "Trang báo review không còn" };
        }
        await page.evaluate(() => {
          const scroller =
            document.querySelector("div[role='main'] div.m6QErb") ||
            document.querySelector("div.section-scrollbox");
          if (scroller) scroller.scrollTop += 900;
          else window.scrollBy(0, 900);
        });
        await new Promise((r) => setTimeout(r, 500));
      }

      return {
        visibility: "DELETED",
        detail: "Không thấy nội dung review trên trang địa điểm",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        visibility: "UNKNOWN",
        detail: `Lỗi quét: ${msg.slice(0, 120)}`,
      };
    }
  });
}
