export type MapsPlaceInfo = {
  placeName: string | null;
  currentRating: number | null;
  reviewCount: number | null;
  source: "dom_scrape" | "manual" | "url";
};

export type MapsResolveResult = {
  valid: boolean;
  validMessage: string;
  resolvedUrl: string;
  info: MapsPlaceInfo | null;
};

const MAPS_URL_RE =
  /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

export function isValidMapsUrlFormat(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.length >= 10 && MAPS_URL_RE.test(trimmed);
}

function isResolvedMapsPlaceUrl(url: string): boolean {
  return /google\.[a-z.]+\/maps\/place\//i.test(url) || /!1s0x/i.test(url);
}

function extractPlaceNameFromUrl(url: string): string | null {
  const match = url.match(/\/maps\/place\/([^/@?]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1].replace(/\+/g, " ")).trim() || null;
    } catch {
      return match[1].replace(/\+/g, " ").trim() || null;
    }
  }
  return null;
}

async function resolveFinalUrl(url: string): Promise<string> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
  };

  for (const method of ["GET", "HEAD"] as const) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers,
      });
      if (res.url) return res.url;
    } catch {
      /* thử method / lần khác */
    }
  }
  return url;
}

/** Validate + follow redirect only — typically &lt;1s, no Puppeteer. */
export async function resolveGoogleMapsUrlFast(inputUrl: string): Promise<MapsResolveResult> {
  const trimmed = inputUrl.trim();

  if (!isValidMapsUrlFormat(trimmed)) {
    return {
      valid: false,
      validMessage: "Link không đúng định dạng Google Maps",
      resolvedUrl: trimmed,
      info: null,
    };
  }

  const resolvedUrl = await resolveFinalUrl(trimmed);
  // Redirect đôi khi ra consent/login — giữ URL gốc nếu vẫn là Maps
  const resolvedIsMaps =
    isResolvedMapsPlaceUrl(resolvedUrl) || MAPS_URL_RE.test(resolvedUrl);
  const finalUrl = resolvedIsMaps ? resolvedUrl : trimmed;

  if (!isResolvedMapsPlaceUrl(finalUrl) && !MAPS_URL_RE.test(finalUrl)) {
    return {
      valid: false,
      validMessage: "Không mở được địa điểm từ link này",
      resolvedUrl: finalUrl,
      info: null,
    };
  }

  const placeName = extractPlaceNameFromUrl(finalUrl);
  return {
    valid: true,
    validMessage: resolvedIsMaps
      ? "Link hợp lệ"
      : "Link hợp lệ (redirect Google lệch — dùng link gốc)",
    resolvedUrl: finalUrl,
    info: placeName
      ? { placeName, currentRating: null, reviewCount: null, source: "url" }
      : null,
  };
}

export async function resolveGoogleMapsUrl(
  inputUrl: string,
  opts?: { scrape?: boolean },
): Promise<MapsResolveResult> {
  const scrape = opts?.scrape !== false;
  const fast = await resolveGoogleMapsUrlFast(inputUrl);
  if (!fast.valid || !scrape) return fast;

  const { scrapeGoogleMapsDom } = await import("./google-maps-scraper");
  const info = await scrapeGoogleMapsDom(fast.resolvedUrl);

  if (info?.reviewCount === 0) {
    return {
      valid: true,
      validMessage: "Link hợp lệ — place chưa có đánh giá (0 lượt)",
      resolvedUrl: fast.resolvedUrl,
      info: {
        placeName: info.placeName ?? fast.info?.placeName ?? null,
        currentRating: info.currentRating,
        reviewCount: 0,
        source: "dom_scrape",
      },
    };
  }

  if (info?.currentRating != null || info?.reviewCount != null) {
    return {
      valid: true,
      validMessage: "Link hợp lệ",
      resolvedUrl: fast.resolvedUrl,
      info,
    };
  }

  return {
    valid: true,
    validMessage: "Link hợp lệ — chưa quét được sao/lượt đánh giá từ trang Maps",
    resolvedUrl: fast.resolvedUrl,
    info: info ?? fast.info,
  };
}
