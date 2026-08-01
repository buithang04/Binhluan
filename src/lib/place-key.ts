/** Chuẩn hóa khóa địa điểm Maps — không dùng URL thô làm identity. */

export function extractPlaceKeyFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const hex = trimmed.match(/1s(0x[a-f0-9]+:0x[a-f0-9]+)/i)?.[1];
  if (hex) return hex.toLowerCase();
  const chij = trimmed.match(/19s(ChIJ[^!?&]+)/i)?.[1];
  if (chij) return chij;
  const chijBare = trimmed.match(/(ChIJ[\w-]{20,})/i)?.[1];
  if (chijBare) return chijBare;
  return null;
}

/** Fallback khi URL không chứa ChIJ/ftid — hash URL đã chuẩn hóa. */
export function fallbackPlaceKeyFromUrl(url: string): string {
  const normalized = url.trim().toLowerCase().replace(/#.*$/, "");
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = (Math.imul(31, h) + normalized.charCodeAt(i)) | 0;
  }
  return `url:${Math.abs(h).toString(36)}`;
}

export function resolveProjectPlaceKey(
  googleMapsUrl: string,
  storedPlaceKey?: string | null,
): string {
  if (storedPlaceKey?.trim()) return storedPlaceKey.trim();
  return (
    extractPlaceKeyFromUrl(googleMapsUrl) ??
    fallbackPlaceKeyFromUrl(googleMapsUrl)
  );
}
