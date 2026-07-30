"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHydrated } from "@/lib/use-hydrated";
import {
  parseMediaAssetIds,
  summarizeImageCounts,
  type MediaThumb,
} from "@/lib/review-media";
import {
  assignmentStatusLabel,
  formatScheduleDate,
  getScheduleState,
  scheduleStateLabel,
} from "@/lib/review-schedule";
import { readApiJson } from "@/lib/api-client";
import { formatReviewError } from "@/lib/review-errors";
import { formatDateTimeVi } from "@/lib/format-datetime";
import {
  normalizeStarPlan,
  type ClientAssignment,
  type ClientReviewPlan,
  type ClientStarPlan,
} from "@/lib/review-plan-client";

/** ISO → value cho input datetime-local (theo giờ máy). */
function toDatetimeLocalValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type StarPlan = ClientStarPlan;
type Assignment = ClientAssignment;
type Plan = ClientReviewPlan;

type PreviewSample = {
  sortOrder: number;
  stars: number;
  reviewText: string;
  scheduledAt: string | null;
  mediaAssets: MediaThumb[];
};

function formatStarDistribution(countsByStar: Record<string, number>) {
  return Object.entries(countsByStar)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([s, n]) => `${n}×${s}★`)
    .join(", ");
}

function formatImageSummary(tally: Record<number, number>) {
  return [1, 2, 3]
    .filter((n) => (tally[n] ?? 0) > 0)
    .map((n) => `${tally[n]} bài × ${n} ảnh`)
    .join(", ");
}

function assignmentMedia(a: Assignment): MediaThumb[] {
  if (a.mediaAssets?.length) return a.mediaAssets;
  const ids = parseMediaAssetIds(a.mediaAssetIds);
  if (ids.length && a.mediaAsset) return [a.mediaAsset];
  return a.mediaAsset ? [a.mediaAsset] : [];
}

function MediaThumbs({
  assets,
  onPreview,
}: {
  assets: MediaThumb[];
  onPreview: (src: string) => void;
}) {
  if (!assets.length) {
    return <span className="text-xs text-[var(--muted)]">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {assets.map((m) => (
        <button
          key={m.id}
          type="button"
          className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-[6px] border border-[var(--line)] bg-[var(--surface-muted)]"
          title={m.fileName}
          onClick={() => onPreview(m.filePath)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={m.filePath}
            alt=""
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        </button>
      ))}
    </div>
  );
}

type InfraWarning = { id: string; message: string; severity: "warn" | "error" };

export function ReviewPlanPanel({
  projectId,
  packageTargetContents,
  initialMediaCount = 0,
  initialContentGenerated = false,
  initialPlan = null,
  initialStarPreview = null,
  initialBlockers = [],
  initialReadyProfileCount = null,
  initialInfraWarnings = [],
  initialAvailableProxyCount = null,
  initialRatingScannedAt = null,
}: {
  projectId: string;
  packageTargetContents: number;
  /** SSR — tránh blocker giả “chưa có ảnh” khi reload */
  initialMediaCount?: number;
  initialContentGenerated?: boolean;
  /** SSR từ ReviewPlan đã lưu DB — bảng hiện ngay, không chờ API */
  initialPlan?: Plan | null;
  initialStarPreview?: StarPlan | null;
  initialBlockers?: string[];
  initialReadyProfileCount?: number | null;
  initialInfraWarnings?: InfraWarning[];
  initialAvailableProxyCount?: number | null;
  initialRatingScannedAt?: string | null;
}) {
  const [plan, setPlan] = useState<Plan | null>(initialPlan);
  const [starPreview, setStarPreview] = useState<StarPlan | null>(initialStarPreview);
  const [blockers, setBlockers] = useState<string[]>(initialBlockers);
  const [contentGenerated, setContentGenerated] = useState(initialContentGenerated);
  const [ratingScannedAt, setRatingScannedAt] = useState<string | null>(
    initialRatingScannedAt,
  );
  const [readyProfileCount, setReadyProfileCount] = useState<number | null>(
    initialReadyProfileCount,
  );
  const [infraWarnings, setInfraWarnings] = useState<InfraWarning[]>(initialInfraWarnings);
  const [availableProxyCount, setAvailableProxyCount] = useState<number | null>(
    initialAvailableProxyCount,
  );
  const [mediaCount, setMediaCount] = useState(initialMediaCount);
  const [previewSamples, setPreviewSamples] = useState<PreviewSample[] | null>(null);
  const [previewNote, setPreviewNote] = useState("");
  const [previewSummary, setPreviewSummary] = useState<Record<number, number> | null>(
    null,
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [savingScheduleId, setSavingScheduleId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const hydratedFromServer =
    initialPlan != null ||
    initialStarPreview != null ||
    initialBlockers.length > 0 ||
    initialReadyProfileCount != null;
  const [initialLoading, setInitialLoading] = useState(!hydratedFromServer);
  /** Bump mỗi lần poll để cập nhật nhãn Chờ lịch / Đến lịch đăng. */
  const [, setScheduleTick] = useState(0);
  const loadGen = useRef(0);
  const hydrated = useHydrated();
  const clientNow = hydrated ? new Date() : null;

  const load = useCallback(async (opts?: { light?: boolean }) => {
    const light = opts?.light === true;
    const gen = ++loadGen.current;
    try {
      if (light) {
        const planRes = await fetch(`/api/projects/${projectId}/review-plan?light=1`);
        if (gen !== loadGen.current) return;
        const planData = await readApiJson<{
          plan?: {
            id: string;
            status: string;
            assignments: Array<{
              id: string;
              status: string;
              reviewLink: string | null;
              error: string | null;
              scheduledAt?: string | null;
            }>;
          } | null;
          mediaCount?: number;
        }>(planRes);
        if (gen !== loadGen.current) return;
        if (planRes.ok) {
          if (typeof planData.mediaCount === "number") {
            setMediaCount(planData.mediaCount);
          }
          const next = planData.plan;
          if (!next) {
            setPlan(null);
            return;
          }
          // Merge status vào plan SSR — giữ ảnh/text đã có, tránh re-fetch nặng
          setPlan((prev) => {
            if (!prev || prev.id !== next.id) {
              return prev;
            }
            const byId = new Map(next.assignments.map((a) => [a.id, a]));
            return {
              ...prev,
              status: next.status,
              assignments: prev.assignments.map((a) => {
                const u = byId.get(a.id);
                if (!u) return a;
                return {
                  ...a,
                  status: u.status,
                  reviewLink: u.reviewLink,
                  error: u.error,
                  scheduledAt: u.scheduledAt ?? a.scheduledAt,
                };
              }),
            };
          });
        }
        return;
      }

      const [planRes, starRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/review-plan`),
        fetch(`/api/projects/${projectId}/star-plan`),
      ]);
      if (gen !== loadGen.current) return;

      const planData = await readApiJson<{
        plan?: Plan | null;
        mediaCount?: number;
      }>(planRes);
      const starData = await readApiJson<{
        planned?: StarPlan | null;
        blockers?: string[];
        contentGenerated?: boolean;
        ratingScannedAt?: string | null;
        readyProfileCount?: number;
        infraWarnings?: InfraWarning[];
        availableProxyCount?: number;
      }>(starRes);
      if (gen !== loadGen.current) return;

      if (planRes.ok) {
        setPlan(planData.plan ?? null);
        if (typeof planData.mediaCount === "number") {
          setMediaCount(planData.mediaCount);
        }
      }
      if (starRes.ok) {
        setStarPreview(starData.planned ?? null);
        setBlockers(starData.blockers ?? []);
        setContentGenerated(!!starData.contentGenerated);
        setRatingScannedAt(starData.ratingScannedAt ?? null);
        setReadyProfileCount(
          typeof starData.readyProfileCount === "number"
            ? starData.readyProfileCount
            : null,
        );
        setInfraWarnings(starData.infraWarnings ?? []);
        setAvailableProxyCount(
          typeof starData.availableProxyCount === "number"
            ? starData.availableProxyCount
            : null,
        );
      }
    } catch {
      /* giữ state cũ */
    } finally {
      if (gen === loadGen.current) setInitialLoading(false);
    }
  }, [projectId]);

  /** Chỉ refresh infra/star-plan (nhẹ hơn full load — không re-fetch toàn bộ plan + media). */
  const loadInfra = useCallback(async () => {
    const gen = ++loadGen.current;
    try {
      const starRes = await fetch(`/api/projects/${projectId}/star-plan`);
      if (gen !== loadGen.current) return;
      const starData = await readApiJson<{
        planned?: StarPlan | null;
        blockers?: string[];
        contentGenerated?: boolean;
        ratingScannedAt?: string | null;
        readyProfileCount?: number;
        infraWarnings?: InfraWarning[];
        availableProxyCount?: number;
      }>(starRes);
      if (gen !== loadGen.current) return;
      if (!starRes.ok) return;
      setStarPreview(starData.planned ?? null);
      setBlockers(starData.blockers ?? []);
      setContentGenerated(!!starData.contentGenerated);
      setRatingScannedAt(starData.ratingScannedAt ?? null);
      setReadyProfileCount(
        typeof starData.readyProfileCount === "number"
          ? starData.readyProfileCount
          : null,
      );
      setInfraWarnings(starData.infraWarnings ?? []);
      setAvailableProxyCount(
        typeof starData.availableProxyCount === "number"
          ? starData.availableProxyCount
          : null,
      );
    } catch {
      /* giữ state cũ */
    } finally {
      if (gen === loadGen.current) setInitialLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (hydratedFromServer) {
      // SSR đã có plan/blockers — không gọi full load ngay (dev compile API có thể 10–20s).
      // Chỉ refresh infra sau khi UI paint xong.
      const run = () => void loadInfra();
      if (typeof requestIdleCallback !== "undefined") {
        const id = requestIdleCallback(run, { timeout: 8000 });
        return () => cancelIdleCallback(id);
      }
      const t = window.setTimeout(run, 2500);
      return () => clearTimeout(t);
    }
    void load();
  }, [load, loadInfra, hydratedFromServer]);

  useEffect(() => {
    if (!plan || (plan.status !== "RUNNING" && plan.status !== "READY")) return;
    const hasActive = plan.assignments.some((a) =>
      ["QUEUED", "RUNNING", "PENDING"].includes(a.status),
    );
    if (!hasActive && plan.status !== "RUNNING") return;

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setScheduleTick((n) => n + 1);
      void load({ light: true });
    };
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [plan?.id, plan?.status, load]);

  const snapshotPlan = normalizeStarPlan(plan?.snapshot);
  const displayPlan = snapshotPlan ?? starPreview;

  const planBlockers: string[] = initialLoading ? [] : [...blockers];
  if (!initialLoading) {
    for (const w of infraWarnings) {
      if (w.severity === "error") planBlockers.push(w.message);
    }
    if (!contentGenerated) {
      planBlockers.push(
        "Chưa sinh nội dung bình luận theo sao — làm ở phần Nội dung bình luận phía trên",
      );
    }
    if (readyProfileCount != null && readyProfileCount === 0) {
      planBlockers.push(
        "Cần ít nhất 1 mail READY (không đang lock) để lập kế hoạch",
      );
    }
    if (mediaCount === 0) {
      planBlockers.push("Chưa có ảnh trong thư viện dự án");
    }
  }

  const canCreatePlan =
    !initialLoading && planBlockers.length === 0 && !!displayPlan;

  const planUsesLegacyImages =
    !!plan &&
    plan.assignments.length > 0 &&
    plan.assignments.every((a) => parseMediaAssetIds(a.mediaAssetIds).length === 0);

  const planMissingSchedule =
    !!plan &&
    plan.assignments.length > 0 &&
    plan.assignments.every((a) => !a.scheduledAt);

  const planImageSummary = plan
    ? summarizeImageCounts(plan.assignments.map((a) => assignmentMedia(a).length))
    : null;

  async function loadPreview() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/review-plan/preview?limit=8`);
      const data = await readApiJson<{ error?: string; samples?: PreviewSample[]; note?: string; imageSummary?: Record<number, number> }>(res);
      if (!res.ok) {
        setError(data.error || "Không xem trước được");
        return;
      }
      setPreviewSamples(data.samples ?? []);
      setPreviewNote(data.note ?? "");
      setPreviewSummary(data.imageSummary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  }

  async function createPlan() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/review-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await readApiJson<{
        error?: string;
        plan?: Plan;
        planned?: StarPlan;
        message?: string;
      }>(res);
      if (!res.ok) {
        setError(data.error || "Lập kế hoạch thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      if (data.planned) setStarPreview(data.planned);
      const summary = summarizeImageCounts(
        (data.plan?.assignments ?? []).map(
          (a: Assignment) => assignmentMedia(a).length,
        ),
      );
      setMsg(
        data.message ||
          `Kế hoạch: → ${data.planned?.projectedRating}★ (mục tiêu ${data.planned?.desiredRating}). Ảnh: ${formatImageSummary(summary) || "—"}`,
      );
      setPreviewSamples(null);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  }

  async function runPlan() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/review-plan/run`, {
        method: "POST",
      });
      const data = await readApiJson<{ error?: string; plan?: Plan; message?: string }>(res);
      if (!res.ok) {
        setError(data.error || "Kích hoạt kế hoạch thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      setMsg(data.message || "Kế hoạch đã kích hoạt");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  }

  async function runOneAssignment(assignmentId: string) {
    setError("");
    setMsg("");
    setPostingId(assignmentId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/review-plan/assignments/${assignmentId}/run`,
        { method: "POST" },
      );
      const data = await readApiJson<{
        error?: string;
        plan?: Plan;
        message?: string;
        openedLogin?: boolean;
      }>(res);
      if (!res.ok) {
        setError(data.error || "Đăng bài thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      if (data.openedLogin) {
        setMsg(
          data.message ||
            "Account chưa READY — đang đăng nhập. Hệ thống sẽ TỰ đăng khi sẵn sàng.",
        );
      } else {
        setMsg(data.message || "Đã enqueue bài");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setPostingId(null);
    }
  }

  async function saveAssignmentSchedule(assignmentId: string, localValue: string) {
    if (!localValue) return;
    setError("");
    setMsg("");
    setSavingScheduleId(assignmentId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/review-plan/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledAt: new Date(localValue).toISOString() }),
        },
      );
      const data = await readApiJson<{ error?: string; plan?: Plan; message?: string }>(res);
      if (!res.ok) {
        setError(data.error || "Cập nhật lịch thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      setMsg(data.message || "Đã lưu lịch đăng");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setSavingScheduleId(null);
    }
  }

  const nextPending = [...(plan?.assignments ?? [])]
    .filter((a) => a.status === "PENDING" && a.scheduledAt)
    .sort(
      (a, b) =>
        new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime(),
    )[0];

  const readyByScheduleCount = clientNow
    ? (plan?.assignments.filter(
        (a) =>
          a.status === "PENDING" &&
          getScheduleState(a.scheduledAt, clientNow) === "ready",
      ).length ?? 0)
    : 0;

  const waitingByScheduleCount = clientNow
    ? (plan?.assignments.filter(
        (a) =>
          a.status === "PENDING" &&
          getScheduleState(a.scheduledAt, clientNow) === "waiting",
      ).length ?? 0)
    : 0;

  const overdueByScheduleCount = clientNow
    ? (plan?.assignments.filter(
        (a) =>
          a.status === "PENDING" &&
          getScheduleState(a.scheduledAt, clientNow) === "overdue",
      ).length ?? 0)
    : 0;

  const failedAssignments =
    plan?.assignments.filter((a) => a.status === "FAILED" || a.status === "SKIPPED") ?? [];

  return (
    <section className="panel space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-[var(--ink)]">
            Kế hoạch đánh giá Maps
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Phân bổ sao + gán account READY. Mỗi bài có ngày giờ đăng (chỉnh được trong bảng).
            Sao/lượt đánh giá lấy lúc tạo dự án
            {ratingScannedAt
              ? ` (chốt ${formatDateTimeVi(ratingScannedAt)})`
              : ""}
            — không quét lại realtime. Hệ thống đăng đúng lịch từng bài khi kế hoạch{" "}
            <strong>RUNNING</strong> ({mediaCount} ảnh). Phân bổ sao và bảng kế hoạch lấy từ DB
            (đã lưu khi lập), reload hiện ngay.
          </p>
        </div>
        {plan && <span className="badge badge-neutral">{plan.status}</span>}
      </div>

      {initialLoading && !displayPlan && (
        <div className="animate-pulse rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">
          Đang tải phân bổ sao…
        </div>
      )}

      {displayPlan && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 text-sm text-[var(--ink-soft)]">
          <p>
            <strong>Phân bổ sao</strong> ({displayPlan.reviewsToPost} bình luận / gói{" "}
            {packageTargetContents}):{" "}
            {formatStarDistribution(displayPlan.countsByStar) || "—"}
          </p>
          <p className="mt-1">
            Rating: {displayPlan.currentRating}★ → dự kiến {displayPlan.projectedRating}★ (mục
            tiêu {displayPlan.desiredRating}★, Δ {displayPlan.delta})
          </p>
          {readyProfileCount != null && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Account sẵn sàng: {readyProfileCount}
              {readyProfileCount < packageTargetContents
                ? ` (thiếu ${packageTargetContents} — sẽ tái sử dụng mail, lịch cách nhau ≥6h)`
                : ` / ${packageTargetContents}`}
              {contentGenerated ? " · Nội dung đã sinh" : " · Chưa sinh nội dung"}
              {mediaCount > 0 ? ` · Thư viện: ${mediaCount} ảnh` : ""}
              {availableProxyCount != null
                ? ` · Proxy khả dụng: ${availableProxyCount}`
                : ""}
            </p>
          )}
        </div>
      )}

      {infraWarnings.filter((w) => w.severity === "warn").length > 0 && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn-soft)] bg-[var(--warn-soft)]/30 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--warn-ink)]">
            Lưu ý trước khi đăng
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[var(--warn-ink)]">
            {infraWarnings
              .filter((w) => w.severity === "warn")
              .map((w) => (
                <li key={w.id}>• {w.message}</li>
              ))}
          </ul>
        </div>
      )}

      {planMissingSchedule && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn-soft)] bg-[var(--warn-soft)]/40 p-3 text-sm text-[var(--warn-ink)]">
          Kế hoạch chưa có lịch đăng — bấm <strong>Lập kế hoạch</strong> lại để gán ngày giờ từng
          bài.
        </div>
      )}

      {planUsesLegacyImages && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn-soft)] bg-[var(--warn-soft)]/40 p-3 text-sm text-[var(--warn-ink)]">
          Kế hoạch hiện tại được tạo trước khi hỗ trợ nhiều ảnh — mỗi bài chỉ có 1 ảnh. Bấm{" "}
          <strong>Lập kế hoạch</strong> lại để random 1–3 ảnh/bài.
        </div>
      )}

      {!initialLoading && !displayPlan && planBlockers.length === 0 && (
        <p className="text-sm text-[var(--warn)]">
          Chưa tính được phân bổ sao — cần số sao hiện tại, mục tiêu và số bình luận trên dự án.
        </p>
      )}

      {!initialLoading && !canCreatePlan && planBlockers.length > 0 && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn-soft)] bg-[var(--warn-soft)]/40 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--warn-ink)]">
            Chưa thể lập kế hoạch
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[var(--warn-ink)]">
            {planBlockers.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--ink-soft)]">
          Số bài đăng: <strong>{packageTargetContents}</strong> (theo gói)
        </p>
        <div className="btn-group">
          {!plan && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !displayPlan || mediaCount === 0}
              onClick={() => void loadPreview()}
            >
              Xem trước ảnh
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !canCreatePlan}
            title={!canCreatePlan ? planBlockers.join(" · ") : undefined}
            onClick={() => void createPlan()}
          >
            Lập kế hoạch
          </button>
          <button
            type="button"
            className="btn btn-soft"
            disabled={busy || !plan || plan.status === "DONE" || plan.status === "FAILED"}
            onClick={() => void runPlan()}
          >
          {plan?.status === "RUNNING" ? "Đăng 1 bài theo lịch" : "Kích hoạt lịch đăng"}
        </button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">
        «Kích hoạt lịch đăng» chỉ bật lịch (RUNNING) — hệ thống đăng đúng giờ từng bài trong cửa sổ
        lịch (mặc định 2 giờ sau mốc). Bài quá hạn hoặc lỗi không auto — hãy sửa ngày đăng / Lập kế
        hoạch lại, hoặc bấm «Đăng» từng dòng.
      </p>

      {plan?.status === "RUNNING" &&
        clientNow &&
        (readyByScheduleCount > 0 ||
          waitingByScheduleCount > 0 ||
          overdueByScheduleCount > 0 ||
          nextPending) && (
        <p className="text-xs text-[var(--muted)]">
          {readyByScheduleCount > 0 && (
            <span className="text-[var(--accent-ink)]">
              {readyByScheduleCount} bài trong cửa sổ lịch (auto)
            </span>
          )}
          {readyByScheduleCount > 0 && waitingByScheduleCount > 0 && " · "}
          {waitingByScheduleCount > 0 && (
            <span>{waitingByScheduleCount} bài chờ lịch</span>
          )}
          {(readyByScheduleCount > 0 || waitingByScheduleCount > 0) &&
            overdueByScheduleCount > 0 &&
            " · "}
          {overdueByScheduleCount > 0 && (
            <span className="text-[var(--warn-ink)]">
              {overdueByScheduleCount} quá hạn (lập lại / Đăng tay)
            </span>
          )}
          {nextPending && getScheduleState(nextPending.scheduledAt, clientNow) === "waiting" && (
            <>
              {(readyByScheduleCount > 0 ||
                waitingByScheduleCount > 0 ||
                overdueByScheduleCount > 0) &&
                " · "}
              Bài tiếp theo: {formatScheduleDate(nextPending.scheduledAt)}
            </>
          )}
        </p>
      )}

      {(overdueByScheduleCount > 0 || failedAssignments.length > 0) && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn-soft)] bg-[var(--warn-soft)]/30 p-3 text-sm text-[var(--warn-ink)]">
          {overdueByScheduleCount > 0 && (
            <p>
              <strong>{overdueByScheduleCount} bài quá hạn lịch</strong> — không tự đăng. Đổi «Ngày
              đăng» sang mốc mới, hoặc bấm cột «Đăng» từng bài.
            </p>
          )}
          {failedAssignments.length > 0 && (
            <p className={overdueByScheduleCount > 0 ? "mt-1" : undefined}>
              <strong>{failedAssignments.length} bài lỗi</strong> — sửa rồi Đăng tay, hoặc Lập kế
              hoạch lại.
            </p>
          )}
        </div>
      )}

      {!plan && previewSamples && previewSamples.length > 0 && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-[var(--ink)]">Xem trước (mẫu ngẫu nhiên)</p>
            {previewSummary && (
              <p className="text-xs text-[var(--muted)]">
                {formatImageSummary(previewSummary)}
              </p>
            )}
          </div>
          {previewNote && (
            <p className="mb-3 text-xs text-[var(--muted)]">{previewNote}</p>
          )}
          <div className="space-y-2">
            {previewSamples.map((s) => (
              <div
                key={s.sortOrder}
                className="flex flex-wrap items-start gap-3 rounded-[6px] border border-[var(--line)] p-2"
              >
                <span className="w-8 shrink-0 font-mono text-xs text-[var(--muted)]">
                  #{s.sortOrder + 1}
                </span>
                <span className="w-8 shrink-0 text-xs">{s.stars}★</span>
                <span className="w-36 shrink-0 text-xs text-[var(--muted)]">
                  {formatScheduleDate(s.scheduledAt)}
                </span>
                <div className="min-w-0 flex-1 text-xs text-[var(--ink-soft)]">
                  {s.reviewText.slice(0, 100)}
                  {s.reviewText.length > 100 ? "…" : ""}
                </div>
                <MediaThumbs assets={s.mediaAssets} onPreview={setLightboxSrc} />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-secondary mt-3"
            disabled={busy}
            onClick={() => void loadPreview()}
          >
            Random lại
          </button>
        </div>
      )}

      {failedAssignments.length > 0 && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--danger)]">
            Bài lỗi ({failedAssignments.length})
          </p>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm text-[var(--ink-soft)]">
            {failedAssignments.slice(0, 12).map((a) => (
              <li key={a.id} className="break-all">
                <strong>#{a.sortOrder + 1}</strong> {a.profileEmail || "—"}:{" "}
                {formatReviewError(a.error) || assignmentStatusLabel(a.status)}
              </li>
            ))}
            {failedAssignments.length > 12 && (
              <li className="text-[var(--muted)]">
                … và {failedAssignments.length - 12} bài lỗi khác (xem bảng bên dưới)
              </li>
            )}
          </ul>
        </div>
      )}

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {msg && <p className="text-sm text-[var(--accent-ink)]">{msg}</p>}

      {plan && plan.assignments.length > 0 && (
        <div className="space-y-2">
          {planImageSummary && !planUsesLegacyImages && (
            <p className="text-xs text-[var(--muted)]">
              Phân bổ ảnh trong kế hoạch: {formatImageSummary(planImageSummary)}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] font-mono text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Ngày đăng</th>
                  <th className="py-2 pr-2">Sao</th>
                  <th className="py-2 pr-2">Account</th>
                  <th className="py-2 pr-2">Ảnh</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2">Nội dung</th>
                  <th className="py-2 pr-2">Link</th>
                  <th className="py-2">Đăng</th>
                </tr>
              </thead>
              <tbody>
                {plan.assignments.map((a) => {
                  const sched =
                    clientNow && a.status === "PENDING"
                      ? getScheduleState(a.scheduledAt, clientNow)
                      : null;
                  const schedLabel = sched ? scheduleStateLabel(sched) : "";
                  const showSchedBadge = !!schedLabel;
                  const canPostOne =
                    (a.status === "PENDING" || a.status === "FAILED") &&
                    (plan.status === "READY" || plan.status === "RUNNING");
                  const isPosting = postingId === a.id;
                  return (
                  <tr key={a.id} className="border-b border-[var(--line)] align-top">
                    <td className="py-2 pr-2">{a.sortOrder + 1}</td>
                    <td className="py-2 pr-2 text-xs whitespace-nowrap">
                      {a.status === "PENDING" || a.status === "FAILED" ? (
                        <div className="space-y-1">
                          <input
                            type="datetime-local"
                            className="input !px-2 !py-1 text-xs"
                            defaultValue={toDatetimeLocalValue(a.scheduledAt)}
                            key={`${a.id}-${a.scheduledAt ?? ""}`}
                            disabled={busy || savingScheduleId === a.id || postingId !== null}
                            onBlur={(e) => {
                              const next = e.target.value;
                              const prev = toDatetimeLocalValue(a.scheduledAt);
                              if (next && next !== prev) {
                                void saveAssignmentSchedule(a.id, next);
                              }
                            }}
                          />
                          {savingScheduleId === a.id && (
                            <span className="text-xs text-[var(--muted)]">Đang lưu…</span>
                          )}
                          {showSchedBadge && (
                            <span
                              className={`block font-medium ${
                                sched === "ready"
                                  ? "text-[var(--accent-ink)]"
                                  : sched === "overdue"
                                    ? "text-[var(--warn-ink)]"
                                    : "text-[var(--muted)]"
                              }`}
                            >
                              {schedLabel}
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          {formatScheduleDate(a.scheduledAt)}
                          {showSchedBadge && (
                            <span
                              className={`mt-0.5 block font-medium ${
                                sched === "ready"
                                  ? "text-[var(--accent-ink)]"
                                  : sched === "overdue"
                                    ? "text-[var(--warn-ink)]"
                                    : "text-[var(--muted)]"
                              }`}
                            >
                              {schedLabel}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-2">{a.stars}★</td>
                    <td className="py-2 pr-2 text-xs">{a.profileEmail || "—"}</td>
                    <td className="py-2 pr-2">
                      <MediaThumbs
                        assets={assignmentMedia(a)}
                        onPreview={setLightboxSrc}
                      />
                    </td>
                    <td className="max-w-[220px] py-2 pr-2 align-top">
                      <span className="badge badge-neutral" title={a.status}>
                        {assignmentStatusLabel(a.status)}
                      </span>
                      {a.error && (
                        <p
                          className="mt-1 max-h-24 overflow-y-auto break-all text-xs leading-snug text-[var(--danger)]"
                          title={formatReviewError(a.error) || undefined}
                        >
                          {formatReviewError(a.error)}
                        </p>
                      )}
                    </td>
                    <td className="max-w-[220px] overflow-hidden py-2 pr-2 text-xs text-[var(--ink-soft)]">
                      <span className="line-clamp-4 break-words">
                        {a.reviewText.slice(0, 120)}
                        {a.reviewText.length > 120 ? "…" : ""}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      {a.reviewLink ? (
                        <a
                          href={a.reviewLink}
                          target="_blank"
                          rel="noreferrer"
                          className="link-accent break-all text-xs"
                        >
                          Xem
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">
                      {canPostOne ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-soft"
                          disabled={busy || postingId !== null}
                          title="Đăng bài này ngay (không chờ lịch)"
                          onClick={() => void runOneAssignment(a.id)}
                        >
                          {isPosting ? "Đang…" : "Đăng"}
                        </button>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1 text-sm text-white"
            onClick={() => setLightboxSrc(null)}
          >
            Đóng
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-[90vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </section>
  );
}
