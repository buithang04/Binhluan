"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSpinTemplate } from "@/lib/spin";
import { formatDateTimeVi } from "@/lib/format-datetime";
import { useHydrated } from "@/lib/use-hydrated";
import { readApiJson } from "@/lib/api-client";
import type { ReviewSpinByStar } from "@/lib/review-content";
import {
  DEFAULT_STAR_SPIN_PROMPT_JSON,
  PROMPT_VARIABLE_GROUPS,
  validatePromptJsonText,
} from "@/lib/prompt-template";

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
  const [contentPromptJson, setContentPromptJson] = useState(
    initialSettings?.contentPromptJson?.trim() || DEFAULT_STAR_SPIN_PROMPT_JSON,
  );
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [promptJsonError, setPromptJsonError] = useState("");
  const [previewingPrompt, setPreviewingPrompt] = useState(false);
  const [resolvedPreview, setResolvedPreview] = useState("");

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
          if (contentData.settings.contentPromptJson?.trim()) {
            setContentPromptJson(contentData.settings.contentPromptJson);
          }
        }
      }
      if (settingsRes.ok && settingsData.settings?.contentPromptJson?.trim()) {
        setContentPromptJson(settingsData.settings.contentPromptJson);
      }
    } catch {
      /* giữ state cũ — tránh blank khi JSON lỗi / timeout */
    } finally {
      setInitialLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Luôn load prompt JSON từ API (SSR có thể chưa truyền)
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/content-settings`);
        if (!res.ok) return;
        const data = await res.json();
        const raw = data.settings?.contentPromptJson?.trim();
        if (raw) setContentPromptJson(raw);
      } catch {
        /* ignore */
      }
    })();
  }, [projectId]);

  useEffect(() => {
    // Đã có dữ liệu SSR (DB) — không fetch lại phân bổ sao / nội dung lúc mount
    if (hydratedFromServer) return;
    void loadAll();
  }, [hydratedFromServer, loadAll]);

  function insertPromptVariable(path: string) {
    const el = promptTextareaRef.current;
    const token = `{{ ${path} }}`;
    if (!el) {
      setContentPromptJson((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setContentPromptJson(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function onPromptJsonChange(value: string) {
    setContentPromptJson(value);
    setResolvedPreview("");
    if (!value.trim()) {
      setPromptJsonError("");
      return;
    }
    const check = validatePromptJsonText(value);
    setPromptJsonError(check.ok ? "" : check.error || "JSON không hợp lệ");
  }

  async function previewResolvedPrompt() {
    setError("");
    setResolvedPreview("");
    const check = validatePromptJsonText(contentPromptJson);
    if (!check.ok) {
      setPromptJsonError(check.error || "JSON không hợp lệ");
      return;
    }
    setPreviewingPrompt(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/content-settings/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptJson: contentPromptJson,
          callDeepSeek: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Resolve prompt thất bại");
        return;
      }
      setResolvedPreview(JSON.stringify(data.resolvedPayload, null, 2));
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setPreviewingPrompt(false);
    }
  }

  async function saveContentSettings(): Promise<boolean> {
    setError("");
    setMessage("");
    const check = validatePromptJsonText(contentPromptJson);
    if (!check.ok) {
      setPromptJsonError(check.error || "JSON prompt không hợp lệ");
      setError("Sửa JSON prompt trước khi lưu");
      return false;
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
          contentPromptJson: contentPromptJson.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lưu cấu hình thất bại");
        return false;
      }
      if (data.settings?.contentPromptJson) {
        setContentPromptJson(data.settings.contentPromptJson);
      }
      setMessage("Đã lưu cấu hình + prompt JSON");
      return true;
    } catch {
      setError("Không kết nối được máy chủ");
      return false;
    } finally {
      setSavingSettings(false);
    }
  }

  async function generateReviewContent() {
    if (generatedAt) {
      setError("Dự án đã sinh nội dung — mỗi dự án chỉ sinh 1 lần");
      return;
    }
    setError("");
    setMessage("");
    setLoading(true);
    const saved = await saveContentSettings();
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
        setError(data.error || "Sinh nội dung thất bại");
        return;
      }
      setSpinByStar(data.spinByStar || {});
      setGeneratedAt(data.generatedAt || new Date().toISOString());
      if (data.planned) setStarPlan(data.planned);
      setMessage(
        `Đã sinh template spin cho ${(data.starLevels || []).join("★, ")}★` +
          (data.warnings?.length ? ` (cảnh báo: ${data.warnings.join("; ")})` : ""),
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
        <p className="mt-1 text-sm text-[var(--muted)]">
          DeepSeek sinh template spin cho từng mức sao cần dùng. Khi đăng bài, hệ thống random
          trong các block {"{a|b|c}"}. Mỗi dự án chỉ sinh 1 lần — có thể chỉnh sửa template sau
          khi sinh.
        </p>
      </div>

      {starPlan ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--ink-soft)]">
          <p>
            <strong>Phân bổ sao</strong> ({starPlan.reviewsToPost} bình luận
            {packageLimit ? ` / gói ${packageLimit}` : ""}):{" "}
            {neededStars
              .map((s) => `${starPlan.countsByStar[s]}×${s}★`)
              .join(", ") || "—"}
          </p>
          <p className="mt-1">
            Rating: {starPlan.currentRating}★ → dự kiến {starPlan.projectedRating}★ (mục tiêu{" "}
            {starPlan.desiredRating}★, Δ {starPlan.delta})
          </p>
        </div>
      ) : initialLoading ? (
        <div className="animate-pulse rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">
          Đang tải phân bổ sao…
        </div>
      ) : starPlanBlockers.length > 0 ? (
        <ul className="space-y-1 text-sm text-[var(--warn)]">
          {starPlanBlockers.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
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
            disabled={!!generatedAt}
            placeholder="VD: tự nhiên, nhấn mạnh dịch vụ và không gian"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium text-[var(--ink-soft)]">Ngôn ngữ</span>
          <select
            className="input"
            value={contentLanguage}
            onChange={(e) => setContentLanguage(e.target.value as "VI" | "EN")}
            disabled={!!generatedAt}
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
            disabled={!!generatedAt}
            placeholder="VD: 60 (để trống = mặc định)"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">Tùy chọn — từ 10 đến 2000, để trống nếu không cần</p>
        </label>
        <label className="block space-y-1 text-sm sm:col-span-2">
          <span className="font-medium text-[var(--ink-soft)]">Ví dụ tham khảo</span>
          <textarea
            className="input min-h-[72px]"
            value={contentExample}
            onChange={(e) => setContentExample(e.target.value)}
            disabled={!!generatedAt}
          />
        </label>
      </div>

      <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-[var(--ink)]">
              Prompt DeepSeek (JSON)
            </p>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Sửa prompt trước khi sinh. Dùng {"{{ $json.... }}"} — khi generate,{" "}
              <code className="font-mono">$json.settings.stars</code> được gắn theo từng mức sao.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary !py-1.5 text-xs"
              disabled={!!generatedAt}
              onClick={() => {
                setContentPromptJson(DEFAULT_STAR_SPIN_PROMPT_JSON);
                setPromptJsonError("");
                setResolvedPreview("");
              }}
            >
              Reset mặc định
            </button>
            <button
              type="button"
              className="btn btn-secondary !py-1.5 text-xs"
              disabled={previewingPrompt || !!promptJsonError}
              onClick={() => void previewResolvedPrompt()}
            >
              {previewingPrompt ? "Đang resolve…" : "Xem JSON đã resolve"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PROMPT_VARIABLE_GROUPS.flatMap((g) =>
            g.items.map((item) => (
              <button
                key={item.path}
                type="button"
                disabled={!!generatedAt}
                title={item.path}
                onClick={() => insertPromptVariable(item.path)}
                className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 font-mono text-[10px] text-[var(--ink-soft)] transition hover:border-[var(--accent)] hover:text-[var(--accent-ink)] disabled:opacity-50"
              >
                {item.label}
              </button>
            )),
          )}
        </div>

        <textarea
          ref={promptTextareaRef}
          className="input min-h-[220px] font-mono text-xs leading-relaxed"
          value={contentPromptJson}
          onChange={(e) => onPromptJsonChange(e.target.value)}
          disabled={!!generatedAt}
          spellCheck={false}
          placeholder='{ "model": "deepseek-chat", "messages": [...] }'
        />
        {promptJsonError && (
          <p className="text-xs text-[var(--danger)]">{promptJsonError}</p>
        )}
        {resolvedPreview && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] p-2.5 font-mono text-[11px] text-[var(--ink-soft)]">
            {resolvedPreview}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={savingSettings || !!generatedAt}
          onClick={() => void saveContentSettings()}
        >
          Lưu cấu hình
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || !!generatedAt || !starPlan || !neededStars.length}
          onClick={() => void generateReviewContent()}
        >
          {loading
            ? "Đang sinh…"
            : generatedAt
              ? "Đã sinh nội dung"
              : `Sinh nội dung (${neededStars.length} mức sao)`}
        </button>
      </div>

      {generatedAt && hydrated && (
        <p className="text-xs text-[var(--muted)]">
          Sinh lúc {formatDateTimeVi(generatedAt)} — không thể sinh lại.
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
                      <p className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-2 text-xs text-[var(--ink-soft)]">
                        <span className="font-medium text-[var(--muted)]">Preview: </span>
                        {previewByStar[stars]}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--surface-muted)] p-2.5 font-mono text-xs text-[var(--ink-soft)]">
                      {spinByStar[stars]}
                    </pre>
                    {previewByStar[stars] && (
                      <p className="mt-2 border-t border-[var(--line)] pt-2 text-xs text-[var(--muted)]">
                        <span className="font-medium">Preview:</span> {previewByStar[stars]}
                      </p>
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
