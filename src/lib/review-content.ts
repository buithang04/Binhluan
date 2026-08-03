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
/** true chỉ khi đã sinh thành công (bỏ qua sentinel epoch). */
export function isReviewContentGenerated(
  value: Date | string | null | undefined,
): boolean {
  if (!value) return false;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) && t > 0;
}

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

/** Profile có thể gán cho kế hoạch review — READY, không lock, không cần verify lại. */
export function availableReviewProfileWhere(now = new Date()) {
  return {
    status: "READY" as const,
    account: {
      status: "READY" as const,
      loginIssue: null,
    },
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

/** Gán profile duy nhất — thiếu mail thì null (không xoay vòng). 1 mail / 1 địa điểm. */
export function pickUniqueProfilesForPlan<
  T extends { id: string; account: { email: string } },
>(
  pool: T[],
  count: number,
  excludeProfileIds: ReadonlySet<string> = new Set(),
): (T | null)[] {
  return assignUniqueProfilesToSlots({
    pool,
    slotCount: count,
    excludeIds: excludeProfileIds,
  });
}

/**
 * Gán mail cho từng slot — ưu tiên preserve theo index, không trùng trong plan.
 * `excludeIds`: mail đã review / bị dự án khác giữ (cùng placeKey).
 */
export function assignUniqueProfilesToSlots<
  T extends { id: string; account: { email: string } },
>(input: {
  pool: T[];
  slotCount: number;
  excludeIds?: ReadonlySet<string>;
  preserveProfileIds?: ReadonlyArray<string | null | undefined>;
}): (T | null)[] {
  const { pool, slotCount } = input;
  if (slotCount <= 0) return [];

  const used = new Set(input.excludeIds ?? []);
  const result: (T | null)[] = [];

  for (let i = 0; i < slotCount; i++) {
    const preservedId = input.preserveProfileIds?.[i];
    if (preservedId && !used.has(preservedId)) {
      const kept = pool.find((p) => p.id === preservedId);
      if (kept) {
        result.push(kept);
        used.add(kept.id);
        continue;
      }
    }

    const pick = pool.find((p) => !used.has(p.id));
    if (pick) {
      result.push(pick);
      used.add(pick.id);
    } else {
      result.push(null);
    }
  }

  return result;
}

/** @deprecated Chỉ dùng cho lịch gap khi cần — không gán mail. */
export function pickProfilesForReviewPlan<
  T extends { id: string; account: { email: string } },
>(pool: T[], count: number, startIndex = 0): T[] {
  if (count <= 0 || pool.length === 0) return [];
  return Array.from(
    { length: count },
    (_, i) => pool[(startIndex + i) % pool.length]!,
  );
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

/** Sinh spin template cho 1 mức sao qua DeepSeek (legacy — ưu tiên generateAllStarSpins). */
export async function generateStarSpinTemplate(
  project: ProjectForReviewContent & {
    googleMapsUrl?: string;
    contentPromptJson?: string | null;
  },
  stars: number,
): Promise<{ template: string | null; error?: string }> {
  const { spinByStar, errors } = await generateAllStarSpins(project, [stars]);
  const key = String(Math.min(5, Math.max(1, Math.round(stars))));
  const template = spinByStar[key] || null;
  if (!template) {
    return { template: null, error: errors[0] || "DeepSeek không trả về template" };
  }
  return { template };
}

/** Parse JSON batch từ DeepSeek → map sao → template. */
export function parseBatchStarSpinResponse(
  rawText: string,
  starLevels: number[],
): { spinByStar: ReviewSpinByStar; errors: string[] } {
  const spinByStar: ReviewSpinByStar = {};
  const errors: string[] = [];
  const want = new Set(
    starLevels.map((s) => String(Math.min(5, Math.max(1, Math.round(s))))),
  );

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      spinByStar: {},
      errors: ["DeepSeek không trả JSON hợp lệ — kiểm tra response_format trong Prompt JSON"],
    };
  }

  const entries: { stars: string; template: string }[] = [];

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;

    if (Array.isArray(obj.templates)) {
      for (const item of obj.templates) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const s = normalizeStarKey(row.stars as string | number);
        const t = typeof row.template === "string" ? row.template.trim() : "";
        if (s && t) entries.push({ stars: s, template: t });
      }
    } else if (obj.templates && typeof obj.templates === "object") {
      for (const [k, v] of Object.entries(obj.templates as Record<string, unknown>)) {
        const s = normalizeStarKey(k);
        if (s && typeof v === "string" && v.trim()) {
          entries.push({ stars: s, template: v.trim() });
        }
      }
    } else {
      // { "3": "...", "4": "..." }
      for (const [k, v] of Object.entries(obj)) {
        const s = normalizeStarKey(k);
        if (s && typeof v === "string" && v.trim()) {
          entries.push({ stars: s, template: v.trim() });
        }
      }
    }
  }

  for (const { stars, template } of entries) {
    if (want.size && !want.has(stars)) continue;
    const check = validateSpinTemplate(template);
    if (!check.ok) {
      errors.push(`${stars}★: ${check.error}`);
      continue;
    }
    spinByStar[stars] = template;
  }

  for (const s of want) {
    if (!spinByStar[s]) {
      errors.push(`${s}★: thiếu template trong JSON trả về`);
    }
  }

  return { spinByStar, errors };
}

/**
 * Sinh spin cho tất cả mức sao cần dùng — **đúng 1 lần call DeepSeek**.
 * Fail → không lưu; client bấm lại. Không retry / không gọi từng sao.
 */
export async function generateAllStarSpins(
  project: ProjectForReviewContent & {
    googleMapsUrl?: string;
    contentPromptJson?: string | null;
  },
  starLevels: number[],
): Promise<{ spinByStar: ReviewSpinByStar; errors: string[]; apiCalls: number }> {
  const levels = [...new Set(
    starLevels
      .map((s) => Math.min(5, Math.max(1, Math.round(s))))
      .filter((s) => s >= 1 && s <= 5),
  )].sort((a, b) => a - b);

  if (!levels.length) {
    return {
      spinByStar: {},
      errors: ["Không có mức sao nào để sinh"],
      apiCalls: 0,
    };
  }

  const { generateWithPromptJson } = await import("@/lib/deepseek");
  const { resolveEffectivePromptJson } = await import("@/lib/deepseek-settings");

  const effective = await resolveEffectivePromptJson(project.contentPromptJson);

  console.log(
    `[review-content] DeepSeek 1 call — levels=[${levels.join(",")}] model batch`,
  );

  const result = await generateWithPromptJson(
    effective.promptJson,
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
    { starLevels: levels },
  );

  if (!result.text) {
    return {
      spinByStar: {},
      errors: [
        result.error || "DeepSeek không trả về nội dung",
      ],
      apiCalls: 1,
    };
  }

  const parsed = parseBatchStarSpinResponse(result.text, levels);
  // Thiếu bất kỳ mức sao nào → coi fail cả lô (không lưu nửa vời)
  const missing = levels.filter((s) => !parsed.spinByStar[String(s)]);
  if (missing.length) {
    return {
      spinByStar: {},
      errors: [
        ...parsed.errors,
        `Thiếu mức sao: ${missing.join(", ")}★`,
      ],
      apiCalls: 1,
    };
  }

  return { spinByStar: parsed.spinByStar, errors: [], apiCalls: 1 };
}
