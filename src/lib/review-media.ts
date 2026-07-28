/** Chọn ngẫu nhiên 1–3 ảnh khác nhau từ thư viện dự án. */
export function pickRandomMediaAssets<T extends { id: string }>(
  media: T[],
): T[] {
  if (!media.length) return [];
  const maxCount = Math.min(3, media.length);
  const count = 1 + Math.floor(Math.random() * maxCount);
  const shuffled = [...media];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, count);
}

export function parseMediaAssetIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export type MediaThumb = { id: string; filePath: string; fileName: string };

/** Gắn danh sách ảnh đầy đủ cho assignment (ưu tiên mediaAssetIds). */
export function resolveAssignmentMedia(
  assignment: {
    mediaAssetIds?: unknown;
    mediaAssetId?: string | null;
    mediaAsset?: MediaThumb | null;
  },
  mediaById: Map<string, MediaThumb>,
): MediaThumb[] {
  const ids = parseMediaAssetIds(assignment.mediaAssetIds);
  const fromIds = ids
    .map((id) => mediaById.get(id))
    .filter((m): m is MediaThumb => !!m);
  if (fromIds.length) return fromIds;
  if (assignment.mediaAsset) return [assignment.mediaAsset];
  if (assignment.mediaAssetId) {
    const one = mediaById.get(assignment.mediaAssetId);
    if (one) return [one];
  }
  return [];
}

export function mediaMapFromList(media: MediaThumb[]) {
  return new Map(media.map((m) => [m.id, m]));
}

/** Gắn mediaAssets cho từng assignment từ thư viện dự án. */
export function enrichPlanAssignments<
  T extends {
    mediaAssetIds?: unknown;
    mediaAssetId?: string | null;
    mediaAsset?: MediaThumb | null;
  },
>(assignments: T[], media: MediaThumb[]) {
  const mediaById = mediaMapFromList(media);
  return assignments.map((a) => ({
    ...a,
    mediaAssets: resolveAssignmentMedia(a, mediaById),
  }));
}

export function summarizeImageCounts(counts: number[]) {
  const tally = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const n of counts) {
    if (n >= 1 && n <= 3) tally[n] = (tally[n] ?? 0) + 1;
  }
  return tally;
}
