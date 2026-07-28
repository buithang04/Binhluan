/** Phân bổ số sao cho K bài mới để kéo trung bình về desiredRating. */

export type StarPlanSlot = { stars: number };

export type ReviewPlanResult = {
  slots: StarPlanSlot[];
  countsByStar: Record<1 | 2 | 3 | 4 | 5, number>;
  projectedRating: number;
  currentRating: number;
  reviewCount: number;
  reviewsToPost: number;
  desiredRating: number;
  delta: number;
};

function clampStar(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}

function projected(
  currentRating: number,
  reviewCount: number,
  stars: number[],
): number {
  const n = reviewCount;
  const k = stars.length;
  if (n + k <= 0) return currentRating;
  const sum = currentRating * n + stars.reduce((a, b) => a + b, 0);
  return sum / (n + k);
}

function countStars(stars: number[]): Record<1 | 2 | 3 | 4 | 5, number> {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<
    1 | 2 | 3 | 4 | 5,
    number
  >;
  for (const s of stars) {
    const c = clampStar(s) as 1 | 2 | 3 | 4 | 5;
    counts[c] += 1;
  }
  return counts;
}

/**
 * Greedy: với mỗi slot, chọn sao 1–5 làm projected gần desired nhất.
 * Nếu hòa, ưu tiên sao cao hơn khi cần kéo lên, thấp hơn khi cần kéo xuống.
 */
export function planReviewStars(input: {
  currentRating: number;
  reviewCount: number;
  desiredRating: number;
  reviewsToPost: number;
}): ReviewPlanResult {
  const currentRating = Number(input.currentRating);
  const reviewCount = Math.max(0, Math.floor(Number(input.reviewCount) || 0));
  const desiredRating = Math.min(5, Math.max(1, Number(input.desiredRating)));
  const reviewsToPost = Math.max(
    0,
    Math.min(500, Math.floor(Number(input.reviewsToPost) || 0)),
  );

  const stars: number[] = [];
  for (let i = 0; i < reviewsToPost; i++) {
    const needUp = desiredRating >= projected(currentRating, reviewCount, stars);
    let best = needUp ? 5 : 1;
    let bestErr = Infinity;
    for (let s = 1; s <= 5; s++) {
      const p = projected(currentRating, reviewCount, [...stars, s]);
      const err = Math.abs(p - desiredRating);
      if (
        err < bestErr - 1e-9 ||
        (Math.abs(err - bestErr) < 1e-9 && (needUp ? s > best : s < best))
      ) {
        bestErr = err;
        best = s;
      }
    }
    stars.push(best);
  }

  const projectedRating = Number(
    projected(currentRating, reviewCount, stars).toFixed(3),
  );

  return {
    slots: stars.map((s) => ({ stars: s })),
    countsByStar: countStars(stars),
    projectedRating,
    currentRating,
    reviewCount,
    reviewsToPost,
    desiredRating,
    delta: Number((projectedRating - desiredRating).toFixed(3)),
  };
}

/** Template bình luận ngắn theo mức sao khi thiếu GeneratedContent. */
export function fallbackReviewText(stars: number, brandHint?: string): string {
  const place = brandHint?.trim() || "địa điểm";
  switch (clampStar(stars)) {
    case 5:
      return `Trải nghiệm rất tốt tại ${place}. Không gian đẹp, dịch vụ tận tình, sẽ quay lại và giới thiệu bạn bè.`;
    case 4:
      return `Ổn và đáng thử. ${place} có nhiều điểm cộng, chỉ cần cải thiện thêm một chút là hoàn hảo.`;
    case 3:
      return `Mức trung bình. ${place} ổn cho nhu cầu cơ bản, vẫn còn vài điểm cần cải thiện.`;
    case 2:
      return `Chưa như kỳ vọng. Một số hạng mục tại ${place} cần được cải thiện rõ hơn.`;
    default:
      return `Trải nghiệm chưa tốt. Mong ${place} sớm khắc phục các vấn đề còn tồn tại.`;
  }
}
