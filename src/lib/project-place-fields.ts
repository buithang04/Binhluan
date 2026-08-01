import { extractPlaceKeyFromUrl, resolveProjectPlaceKey } from "@/lib/place-key";

export type ProjectPlaceInput = {
  googleMapsUrl: string;
  placeKey?: string | null;
  resolvedUrl?: string | null;
};

export type ExistingProjectPlace = {
  googleMapsUrl: string;
  placeKey?: string | null;
  resolvedUrl?: string | null;
};

/** Chuẩn hóa placeKey / resolvedUrl khi tạo hoặc sửa dự án. */
export function buildProjectPlaceFields(
  input: ProjectPlaceInput,
  existing?: ExistingProjectPlace | null,
) {
  const urlChanged =
    existing != null && existing.googleMapsUrl.trim() !== input.googleMapsUrl.trim();
  const storedKey = urlChanged ? null : existing?.placeKey;
  const placeKey = resolveProjectPlaceKey(
    input.googleMapsUrl,
    input.placeKey?.trim() || storedKey,
  );
  const resolvedUrl =
    input.resolvedUrl?.trim() ||
    (urlChanged ? input.googleMapsUrl.trim() : existing?.resolvedUrl) ||
    input.googleMapsUrl.trim();

  const hadRealKey =
    existing?.placeKey?.trim() && !existing.placeKey.startsWith("url:");
  const hasRealKey = !placeKey.startsWith("url:");
  const placeResolvedAt =
    urlChanged || (!hadRealKey && hasRealKey) ? new Date() : undefined;

  return {
    placeKey,
    resolvedUrl,
    ...(placeResolvedAt ? { placeResolvedAt } : {}),
  };
}

export function placeKeyFromClientOrUrl(
  googleMapsUrl: string,
  clientKey?: string | null,
): string | null {
  return clientKey?.trim() || extractPlaceKeyFromUrl(googleMapsUrl);
}
