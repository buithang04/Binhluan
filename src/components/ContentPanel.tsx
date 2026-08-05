"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSpinTemplate } from "@/lib/spin";
import { formatDateTimeVi } from "@/lib/format-datetime";
import { useHydrated } from "@/lib/use-hydrated";
import { readApiJson } from "@/lib/api-client";
import type { ReviewSpinByStar } from "@/lib/review-content";

type StarPlan = {
  projectedRating: number;
  desiredRating: number;
  currentRating: number;
  reviewsToPost: number;
  countsByStar: Record<string, number>;
  delta: number;
};

type ContentSettings = {
  contentDirection: string | null;
  contentLanguage: string;
  contentExample: string | null;
  contentWordCount: number | null;
  contentPromptJson?: string | null;
};

export function ContentPanel({
  projectId,
  initialSettings,
  initialStarPlan = null,
  initialStarPlanBlockers = [],
  initialPackageLimit = null,
  initialSpinByStar = {},
  initialGeneratedAt = null,
}: {
  projectId: string;
  initialSettings?: ContentSettings;
  /** SSR — phân bổ sao đã tính / snapshot DB, hiện ngay không chờ API */
  initialStarPlan?: StarPlan | null;
  initialStarPlanBlockers?: string[];
  initialPackageLimit?: number | null;
  initialSpinByStar?: ReviewSpinByStar;
  initialGeneratedAt?: string | null;
}) {
  const countWords = (text: string) =>
    text
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

  const [contentDirection, setContentDirection] = useState(
    initialSettings?.contentDirection || "",
  );
  const [contentLanguage, setContentLanguage] = useState<"VI" | "EN">(
    initialSettings?.contentLanguage === "EN" ? "EN" : "VI",
  );
  const [contentExample, setContentExample] = useState(
    initialSettings?.contentExample || "",
  );
  const [contentWordCount, setContentWordCount] = useState(
    initialSettings?.contentWordCount != null
      ? String(initialSettings.contentWordCount)
      : "",
  );

  const [starPlan, setStarPlan] = useState<StarPlan | null>(initialStarPlan);
  const [starPlanBlockers, setStarPlanBlockers] = useState<string[]>(
    initialStarPlanBlockers,
  );
  const [packageLimit, setPackageLimit] = useState<number | null>(
    initialPackageLimit,
  );
  const [spinByStar, setSpinByStar] = useState<ReviewSpinByStar>(initialSpinByStar);
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt);
  const [previewByStar, setPreviewByStar] = useState<Record<string, string>>({});
  const [editingStar, setEditingStar] = useState<string | null>(null);
  const [draftTemplate, setDraftTemplate] = useState("");
  const [savingStar, setSavingStar] = useState<string | null>(null);
  const [starEditError, setStarEditError] = useState("");

  const [loading, setLoading] = useState(false);
  const hydratedFromServer =
    initialStarPlan != null ||
    initialStarPlanBlockers.length > 0 ||
    initialGeneratedAt != null ||
    Object.keys(initialSpinByStar).length > 0;
  const [initialLoading, setInitialLoading] = useState(!hydratedFromServer);
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const hydrated = useHydrated();
  const skipAutosaveRef = useRef(true);

  const loadAll = useCallback(async () => {
    try {
      const [planRes, contentRes, settingsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/star-plan`),
        fetch(`/api/projects/${projectId}/review-content`),
        fetch(`/api/projects/${projectId}/content-settings`),
      ]);
      const planData = await readApiJson<{
        planned?: StarPlan | null;
        blockers?: string[];
        packageLimit?: number | null;
        error?: string;
      }>(planRes);
      const contentData = await readApiJson<{
        spinByStar?: ReviewSpinByStar;
        generatedAt?: string | null;
        settings?: ContentSettings;
      }>(contentRes);
      const settingsData = await readApiJson<{
        settings?: ContentSettings;
      }>(settingsRes);

      // Chỉ cập nhật khi OK — giữ dữ liệu cũ khi lỗi tạm (tránh nhảy mất UI)
      if (planRes.ok) {
        setStarPlan(planData.planned ?? null);
        setStarPlanBlockers(planData.blockers ?? []);
        setPackageLimit(planData.packageLimit ?? null);
      }
      if (contentRes.ok) {
        setSpinByStar(contentData.spinByStar || {});
        setGeneratedAt(contentData.generatedAt || null);
        if (contentData.settings) {
          setContentDirection(contentData.settings.contentDirection || "");
          setContentLanguage(
            contentData.settings.contentLanguage === "EN" ? "EN" : "VI",
          );
          setContentExample(contentData.settings.contentExample || "");
          setContentWordCount(
            contentData.settings.contentWordCount != null
              ? String(contentData.settings.contentWordCount)
              : "",
          );
        }
      }
    } catch {
      /* giữ state cũ — tránh blank khi JSON lỗi / timeout */
    } finally {
      setInitialLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Đã có dữ liệu SSR (DB) — không fetch lại phân bổ sao / nội dung lúc mount
    if (hydratedFromServer) return;
    void loadAll();
  }, [hydratedFromServer, loadAll]);

  const saveContentSettings = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!opts?.silent) {
        setError("");
        setMessage("");
      }
      setSavingSettings(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/content-settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contentDirection: contentDirection || null,
            contentLanguage,
            contentExample: contentExample || null,
            contentWordCount:
              contentWordCount.trim() === "" ? null : Number(contentWordCount),
            contentPromptJson: null,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Lưu thất bại");
          return false;
        }
        return true;
      } catch {
        setError("Không kết nối được máy chủ");
        return false;
      } finally {
        setSavingSettings(false);
      }
    },
    [
      projectId,
      contentDirection,
      contentLanguage,
      contentExample,
      contentWordCount,
    ],
  );

  // Tự lưu form khi sửa (không cần nút) — trước khi sinh nội dung
  useEffect(() => {
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void saveContentSettings({ silent: true });
    }, 700);
    return () => window.clearTimeout(t);
  }, [
    contentDirection,
    contentLanguage,
    contentExample,
    contentWordCount,
    saveContentSettings,
  ]);

  async function generateReviewContent() {
    setError("");
    setMessage("");
    setLoading(true);
    const saved = await saveContentSettings({ silent: true });
    if (!saved) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/review-content/generate`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setGeneratedAt(null);
        setError(data.error || "Sinh thất bại — bấm lại để thử");
        return;
      }
      setSpinByStar(data.spinByStar || {});
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      if (data.planned) setStarPlan(data.planned);
      setMessage(
        `Đã sinh xong cho ${(data.starLevels || []).join("★, ")}★`,
      );
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }

  function previewStar(stars: string) {
    const template =
      editingStar === stars ? draftTemplate : spinByStar[stars];
    if (!template) return;
    const text = resolveSpinTemplate(template, {
      brand_name: "…",
      content_direction: contentDirection,
      content_language: contentLanguage === "EN" ? "English" : "Vietnamese",
    });
    setPreviewByStar((p) => ({ ...p, [stars]: text }));
  }

  function startEditStar(stars: string) {
    setEditingStar(stars);
    setDraftTemplate(spinByStar[stars] || "");
    setStarEditError("");
    setPreviewByStar((p) => {
      const next = { ...p };
      delete next[stars];
      return next;
    });
  }

  function cancelEditStar() {
    setEditingStar(null);
    setDraftTemplate("");
    setStarEditError("");
  }

  async function saveStarTemplate(stars: string) {
    setSavingStar(stars);
    setStarEditError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/review-content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, template: draftTemplate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStarEditError(data.error || "Lưu template thất bại");
        return;
      }
      setSpinByStar(data.spinByStar || {});
      setEditingStar(null);
      setDraftTemplate("");
      setMessage(`Đã lưu template ${stars}★`);
    } catch {
      setStarEditError("Không kết nối được máy chủ");
    } finally {
      setSavingStar(null);
    }
  }

  const neededStars = starPlan
    ? Object.entries(starPlan.countsByStar)
        .filter(([, n]) => n > 0)
        .map(([s]) => s)
        .sort((a, b) => Number(a) - Number(b))
    : [];

  return (
    <section className="panel space-y-5 p-5 sm:p-6">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight text-[var(--ink)]">
          Nội dung bình luận theo sao
        </h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Sinh template spin theo sao (DeepSeek). Có thể bấm sinh lại khi cần.
        </p>
      </div>

      {starPlan ? (
        <p className="text-xs text-[var(--ink-soft)]">
          {neededStars.map((s) => `${starPlan.countsByStar[s]}×${s}★`).join(", ") || "—"} →{" "}
          {starPlan.currentRating}★ dự kiến {starPlan.projectedRating}★ (mục tiêu {starPlan.desiredRating}★)
        </p>
      ) : initialLoading ? (
        <div className="animate-pulse rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">
          Đang tải phân bổ sao…
        </div>
      ) : starPlanBlockers.length > 0 ? (
        <p className="text-xs text-[var(--warn)]">{starPlanBlockers.join(" · ")}</p>
      ) : (
        <p className="text-sm text-[var(--warn)]">
          Chưa tính được phân bổ sao — cần số sao hiện tại, mục tiêu và số bình luận trên dự án.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium text-[var(--ink-soft)]">Định hướng nội dung</span>
          <textarea
            className="input min-h-[72px]"
            value={contentDirection}
            onChange={(e) => setContentDirection(e.target.value)}
            placeholder="VD: tự nhiên, nhấn mạnh dịch vụ và không gian"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-[var(--ink-soft)]">Ngôn ngữ</span>
          <select
            className="input"
            value={contentLanguage}
            onChange={(e) => setContentLanguage(e.target.value as "VI" | "EN")}
          >
            <option value="VI">Tiếng Việt</option>
            <option value="EN">English</option>
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-[var(--ink-soft)]">Số từ mục tiêu</span>
          <input
            className="input"
            type="number"
            min={10}
            max={2000}
            value={contentWordCount}
            onChange={(e) => setContentWordCount(e.target.value)}
            placeholder="VD: 60 (để trống = mặc định)"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">Tùy chọn — từ 10 đến 2000, để trống nếu không cần</p>
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium text-[var(--ink-soft)]">Các bình luận thật (mẫu)</span>
          <textarea
            className="input min-h-[72px]"
            value={contentExample}
            onChange={(e) => setContentExample(e.target.value)}
          />
        </label>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--ink-soft)]">
        <p className="font-medium text-[var(--ink)]">Prompt DeepSeek</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Model + Prompt JSON + schema đầu ra cấu hình tại{" "}
          <a href="/admin/deepseek" className="text-[var(--accent-ink)] underline">
            Admin → DeepSeek
          </a>
          . Mỗi lần sinh sẽ ghi đè bộ template cũ theo các mức sao hiện tại; schema ép{" "}
          <code className="font-mono">{"{ templates: [{ stars, template }] }"}</code>.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || !starPlan || !neededStars.length}
          onClick={() => void generateReviewContent()}
        >
          {loading ? "Đang sinh…" : `Sinh lại nội dung (${neededStars.length} mức · 1 call)`}
        </button>
        {savingSettings && (
          <span className="text-xs text-[var(--muted)]">Đang lưu…</span>
        )}
      </div>

      {generatedAt && hydrated && (
        <p className="text-xs text-[var(--muted)]">
          Lần sinh gần nhất: {formatDateTimeVi(generatedAt)}.
        </p>
      )}

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {message && <p className="text-sm text-[var(--accent-ink)]">{message}</p>}

      {neededStars.length > 0 && (
        <div className="space-y-3">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-[var(--muted)]">
            Template spin theo sao
          </p>
          {neededStars.map((stars) => (
            <div
              key={stars}
              className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] p-3"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-[var(--ink)]">
                  {stars}★ — {starPlan?.countsByStar[stars]} bình luận
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {spinByStar[stars] && (
                    <button
                      type="button"
                      className="link-accent text-xs"
                      onClick={() => previewStar(stars)}
                    >
                      Random thử
                    </button>
                  )}
                  {spinByStar[stars] && editingStar !== stars && (
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent-ink)]"
                      onClick={() => startEditStar(stars)}
                    >
                      Chỉnh sửa
                    </button>
                  )}
                </div>
              </div>
              {spinByStar[stars] ? (
                editingStar === stars ? (
                  <div className="space-y-2">
                    <textarea
                      className="input min-h-[120px] font-mono text-xs leading-relaxed"
                      value={draftTemplate}
                      onChange={(e) => setDraftTemplate(e.target.value)}
                      spellCheck={false}
                      placeholder="{Mở đầu A|Mở đầu B} nội dung {kết A|kết B}"
                    />
                    <p className="text-xs text-[var(--muted)]">
                      Dùng cú pháp {"{a|b|c}"} cho các cụm có thể thay đổi khi đăng bài.
                    </p>
                    {starEditError && editingStar === stars && (
                      <p className="text-xs text-[var(--danger)]">{starEditError}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-primary !py-1.5 text-xs"
                        disabled={savingStar === stars}
                        onClick={() => void saveStarTemplate(stars)}
                      >
                        {savingStar === stars ? "Đang lưu…" : "Lưu template"}
                      </button>
                      <button
                        type="button"
                        className="btn !py-1.5 text-xs"
                        disabled={savingStar === stars}
                        onClick={cancelEditStar}
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        className="link-accent text-xs"
                        onClick={() => previewStar(stars)}
                      >
                        Xem thử
                      </button>
                    </div>
                    {previewByStar[stars] && (
                      <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-2">
                        <p className="text-xs text-[var(--ink-soft)]">
                          <span className="font-medium text-[var(--muted)]">Preview: </span>
                          {previewByStar[stars]}
                        </p>
                        <p className="mt-1 text-right text-[10px] text-[var(--muted)]">
                          {countWords(previewByStar[stars])} từ
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--surface-muted)] p-2.5 font-mono text-xs text-[var(--ink-soft)]">
                      {spinByStar[stars]}
                    </pre>
                    {previewByStar[stars] && (
                      <div className="mt-2 border-t border-[var(--line)] pt-2">
                        <p className="text-xs text-[var(--muted)]">
                          <span className="font-medium">Preview:</span> {previewByStar[stars]}
                        </p>
                        <p className="mt-1 text-right text-[10px] text-[var(--muted)]">
                          {countWords(previewByStar[stars])} từ
                        </p>
                      </div>
                    )}
                  </>
                )
              ) : (
                <p className="text-xs text-[var(--muted)]">Chưa sinh — bấm &quot;Sinh nội dung&quot;</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
