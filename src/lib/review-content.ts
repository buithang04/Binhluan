import { fallbackReviewText, planReviewStars } from "@/lib/review-planner";
import { buildProjectVariables, resolveSpinTemplate } from "@/lib/spin";

export type ReviewSpinByStar = Record<string, string>;

export type ProjectForStarPlan = {
  currentRating: { toString(): string } | number | null;
  desiredRating: { toString(): string } | number | null;
  reviewCount: number | null;
  package: { targetContents: number } | null;
  reviewContentGeneratedAt?: Date | string | null;
};

function toRating(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

/** Sao hiện tại — cho phép 0 khi chưa có đánh giá. */
function toCurrentRating(v: unknown, reviewCount: number): number | null {
  if (v == null || v === "") {
    // Place 0 lượt: không có điểm trung bình → dùng 0 cho công thức phân bổ
    return reviewCount <= 0 ? 0 : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === 0 && reviewCount <= 0) return 0;
  return n >= 1 && n <= 5 ? n : null;
}

/** Các điều kiện còn thiếu để tính phân bổ sao. */
export function getStarPlanBlockers(project: ProjectForStarPlan): string[] {
  const blockers: string[] = [];
  const target = project.package?.targetContents ?? 0;
  const reviewCount = project.reviewCount ?? 0;
  if (!target) {
    blockers.push("Chưa chọn gói hoặc gói không có số bình luận");
  }
  if (toCurrentRating(project.currentRating, reviewCount) == null) {
    blockers.push(
      "Thiếu số sao hiện tại — kiểm tra link Maps hoặc nhập tay (0 nếu chưa có đánh giá)",
    );
  }
  if (toRating(project.desiredRating) == null) {
    blockers.push("Thiếu số sao mục tiêu — nhập trong Chỉnh sửa dự án");
  }
  return blockers;
}

export function getStarPlanInputs(project: ProjectForStarPlan) {
  const reviewsToPost = project.package?.targetContents ?? 0;
  const reviewCount = project.reviewCount ?? 0;
  const currentRating = toCurrentRating(project.currentRating, reviewCount);
  const desiredRating = toRating(project.desiredRating);
  if (!reviewsToPost || currentRating == null || desiredRating == null) {
    return null;
  }
  return { currentRating, desiredRating, reviewCount, reviewsToPost };
}

export type ProjectForReviewContent = {
  brandName: string;
  website: string | null;
  brandDescription: string;
  targetAudience: string;
  targetMarket: string;
  writingNotes: string | null;
  contentDirection?: string | null;
  contentLanguage?: string | null;
  contentExample?: string | null;
  contentWordCount?: number | null;
  products: { name: string; description: string }[];
};

/** Tính phân bổ sao — luôn dùng số bình luận của gói. */
export function computeProjectStarPlan(project: ProjectForStarPlan) {
  const inputs = getStarPlanInputs(project);
  if (!inputs) return null;
  return planReviewStars(inputs);
}

/** Các mức sao cần sinh nội dung (count > 0). */
export function neededStarLevels(
  countsByStar: Record<string | number, number>,
): number[] {
  return ([1, 2, 3, 4, 5] as const).filter((s) => (countsByStar[s] ?? 0) > 0);
}

export function parseReviewSpinByStar(raw: unknown): ReviewSpinByStar {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ReviewSpinByStar = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Kiểm tra template spin hợp lệ (có block {a|b|c}). */
export function validateSpinTemplate(template: string): { ok: true } | { ok: false; error: string } {
  const t = template.trim();
  if (!t) return { ok: false, error: "Template không được rỗng" };
  if (!t.includes("{") || !t.includes("|") || !t.includes("}")) {
    return { ok: false, error: "Template cần có block spin dạng {lựa chọn 1|lựa chọn 2}" };
  }
  return { ok: true };
}

export function normalizeStarKey(stars: string | number): string | null {
  const n = Math.min(5, Math.max(1, Math.round(Number(stars))));
  return Number.isFinite(n) ? String(n) : null;
}

/** Profile có thể gán cho kế hoạch review (browser mở khi chạy job, không cần lúc lập kế hoạch). */
export function availableReviewProfileWhere(now = new Date()) {
  return {
    status: "READY" as const,
    account: { status: "READY" as const },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
  };
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Ưu tiên mail có 2FA (TOTP) trước; random trong từng nhóm. */
export function prioritizeProfilesWith2Fa<
  T extends { account: { totpSecretEnc?: unknown | null } },
>(profiles: T[]): T[] {
  const with2fa: T[] = [];
  const without2fa: T[] = [];
  for (const p of profiles) {
    if (p.account.totpSecretEnc) with2fa.push(p);
    else without2fa.push(p);
  }
  return [...shuffleInPlace(with2fa), ...shuffleInPlace(without2fa)];
}

/** Resolve 1 bình luận hoàn chỉnh từ spin template theo sao. */
export function resolveReviewTextForStar(
  stars: number,
  spinByStar: ReviewSpinByStar,
  project: ProjectForReviewContent,
  brandHint?: string,
): string {
  const key = String(Math.min(5, Math.max(1, Math.round(stars))));
  const template = spinByStar[key];
  if (template) {
    return resolveSpinTemplate(template, buildProjectVariables(project));
  }
  return fallbackReviewText(stars, brandHint ?? project.brandName);
}

/** Sinh spin template cho 1 mức sao qua DeepSeek (dùng contentPromptJson nếu có). */
export async function generateStarSpinTemplate(
  project: ProjectForReviewContent & {
    googleMapsUrl?: string;
    contentPromptJson?: string | null;
  },
  stars: number,
): Promise<{ template: string | null; error?: string }> {
  const star = Math.min(5, Math.max(1, Math.round(stars)));
  const { generateWithPromptJson } = await import("@/lib/deepseek");
  const { DEFAULT_STAR_SPIN_PROMPT_JSON } = await import("@/lib/prompt-template");

  const promptJson =
    project.contentPromptJson?.trim() || DEFAULT_STAR_SPIN_PROMPT_JSON;

  const result = await generateWithPromptJson(
    promptJson,
    {
      brandName: project.brandName,
      website: project.website,
      brandDescription: project.brandDescription,
      targetAudience: project.targetAudience,
      targetMarket: project.targetMarket,
      writingNotes: project.writingNotes,
      googleMapsUrl: project.googleMapsUrl || "",
      contentDirection: project.contentDirection,
      contentLanguage: project.contentLanguage,
      contentExample: project.contentExample,
      contentWordCount: project.contentWordCount,
      products: project.products,
    },
    { stars: star },
  );

  if (!result.text) {
    return { template: null, error: result.error || "DeepSeek không trả về template" };
  }

  const cleaned = result.text
    .replace(/^```[\w]*\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  if (!cleaned.includes("{") || !cleaned.includes("|")) {
    return {
      template: null,
      error: `Template ${star}★ thiếu block spin {a|b|c}`,
    };
  }

  return { template: cleaned };
}

/** Sinh spin cho tất cả mức sao cần dùng (song song). */
export async function generateAllStarSpins(
  project: ProjectForReviewContent & {
    googleMapsUrl?: string;
    contentPromptJson?: string | null;
  },
  starLevels: number[],
): Promise<{ spinByStar: ReviewSpinByStar; errors: string[] }> {
  const spinByStar: ReviewSpinByStar = {};
  const errors: string[] = [];

  const results = await Promise.all(
    starLevels.map(async (stars) => {
      const { template, error } = await generateStarSpinTemplate(project, stars);
      return { stars, template, error };
    }),
  );

  for (const { stars, template, error } of results) {
    if (template) {
      spinByStar[String(stars)] = template;
    } else {
      errors.push(`${stars}★: ${error || "thất bại"}`);
    }
  }

  return { spinByStar, errors };
}
