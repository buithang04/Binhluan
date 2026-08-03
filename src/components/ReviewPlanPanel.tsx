"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useHydrated } from "@/lib/use-hydrated";
import {
  parseMediaAssetIds,
  summarizeImageCounts,
  type MediaThumb,
} from "@/lib/review-media";
import {
  assignmentStatusLabel,
  campaignEndDatePassedMessage,
  formatScheduleDate,
  getScheduleState,
  isCampaignEndDatePassed,
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

function reviewVisibilityLabel(v: string | null | undefined): string {
  switch (v) {
    case "VISIBLE":
      return "Còn hiển thị";
    case "DELETED":
      return "Đã mất";
    case "HIDDEN":
      return "Ẩn";
    case "UNKNOWN":
      return "Chưa rõ";
    default:
      return "";
  }
}

function reviewVisibilityBadgeClass(v: string | null | undefined): string {
  switch (v) {
    case "VISIBLE":
      return "badge badge-accent";
    case "DELETED":
      return "badge badge-neutral text-[var(--danger)]";
    case "HIDDEN":
      return "badge badge-neutral text-[var(--warn-ink)]";
    case "UNKNOWN":
      return "badge badge-neutral";
    default:
      return "badge badge-neutral";
  }
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

type EligibleSnap = {
  unassignedSlots: number;
  eligibleCount: number;
  blockedAtPlaceCount: number;
  readyTotalCount: number;
  profiles: Array<{
    id: string;
    email: string;
    disabled?: boolean;
    disabledReason?: string;
  }>;
  updatedAt: string;
};

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
  campaignEndAt = null,
}: {
  projectId: string;
  packageTargetContents: number;
  /** SSR — tránh blocker giả “chưa có ảnh” khi reload */
  initialMediaCount?: number;
  initialContentGenerated?: boolean;
  /** ISO hoặc YYYY-MM-DD — chặn lập kế hoạch khi quá ngày kết thúc gói */
  campaignEndAt?: string | null;
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
  const [savingProfileId, setSavingProfileId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyAllBusy, setVerifyAllBusy] = useState(false);
  const [autoDispatchPaused, setAutoDispatchPaused] = useState<boolean | null>(null);
  const [autoDispatchBusy, setAutoDispatchBusy] = useState(false);
  const [eligibleSnap, setEligibleSnap] = useState<EligibleSnap | null>(null);
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
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const loadAutoDispatchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/review-dispatch/control");
      if (!res.ok) return;
      const data = (await res.json()) as { paused?: boolean };
      setAutoDispatchPaused(Boolean(data.paused));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadAutoDispatchStatus();
  }, [loadAutoDispatchStatus]);

  async function setAutoDispatchPausedState(paused: boolean) {
    if (!isAdmin) return;
    setAutoDispatchBusy(true);
    setError("");
    try {
      const res = await fetch("/api/review-dispatch/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      const data = (await res.json()) as { error?: string; message?: string; paused?: boolean };
      if (!res.ok) {
        setError(data.error || "Không đổi được trạng thái đăng tự động");
        return;
      }
      setAutoDispatchPaused(Boolean(data.paused));
      setMsg(data.message || (paused ? "Đã dừng đăng tự động" : "Đã bật đăng tự động"));
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setAutoDispatchBusy(false);
    }
  }

  useEffect(() => {
    setMediaCount(initialMediaCount);
  }, [initialMediaCount]);

  /** Đổi dự án — reset state, tránh lẫn kế hoạch dự án khác. */
  useEffect(() => {
    loadGen.current += 1;
    setPlan(initialPlan);
    setStarPreview(initialStarPreview);
    setBlockers(initialBlockers);
    setContentGenerated(initialContentGenerated);
    setRatingScannedAt(initialRatingScannedAt ?? null);
    setReadyProfileCount(initialReadyProfileCount ?? null);
    setInfraWarnings(initialInfraWarnings);
    setAvailableProxyCount(initialAvailableProxyCount ?? null);
    setEligibleSnap(null);
    setError("");
    setMsg("");
    setInitialLoading(!initialPlan && !initialStarPreview && initialBlockers.length === 0);
  }, [
    projectId,
    initialPlan,
    initialStarPreview,
    initialBlockers,
    initialContentGenerated,
    initialRatingScannedAt,
    initialReadyProfileCount,
    initialInfraWarnings,
    initialAvailableProxyCount,
  ]);

  const loadEligible = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/eligible-profiles`);
      if (!res.ok) return;
      const data = (await res.json()) as EligibleSnap;
      setEligibleSnap(data);
    } catch {
      /* ignore */
    }
  }, [projectId]);

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
              apmProfileId?: string | null;
              profileEmail?: string | null;
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
                  apmProfileId: u.apmProfileId ?? a.apmProfileId,
                  profileEmail: u.profileEmail ?? a.profileEmail,
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

  useEffect(() => {
    if (!plan) return;
    const run = () => void loadEligible();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const startPoll = () => {
      run();
      intervalId = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        run();
      }, 30_000);
    };
    if (typeof requestIdleCallback !== "undefined") {
      const idleId = requestIdleCallback(startPoll, { timeout: 4000 });
      return () => {
        cancelIdleCallback(idleId);
        if (intervalId) clearInterval(intervalId);
      };
    }
    const t = window.setTimeout(startPoll, 800);
    return () => {
      clearTimeout(t);
      if (intervalId) clearInterval(intervalId);
    };
  }, [plan?.id, loadEligible]);

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
    if (mediaCount === 0) {
      planBlockers.push("Chưa có ảnh trong thư viện dự án");
    }
    if (campaignEndAt && isCampaignEndDatePassed(campaignEndAt)) {
      planBlockers.push(campaignEndDatePassedMessage(campaignEndAt));
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
      void loadEligible();
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

  async function saveAssignmentProfile(assignmentId: string, apmProfileId: string) {
    setError("");
    setMsg("");
    setSavingProfileId(assignmentId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/review-plan/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apmProfileId: apmProfileId || null }),
        },
      );
      const data = await readApiJson<{ error?: string; plan?: Plan; message?: string }>(res);
      if (!res.ok) {
        setError(data.error || "Gán mail thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      setMsg(data.message || "Đã gán mail");
      void loadEligible();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setSavingProfileId(null);
    }
  }

  async function fillEmptyProfiles() {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/review-plan/fill-profiles`, {
        method: "POST",
      });
      const data = await readApiJson<{ error?: string; plan?: Plan; message?: string }>(res);
      if (!res.ok) {
        setError(data.error || "Tự gán mail thất bại");
        return;
      }
      setPlan(data.plan ?? null);
      setMsg(data.message || "Đã gán mail");
      void loadEligible();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  }

  async function verifyAssignment(assignmentId: string) {
    setError("");
    setMsg("");
    setVerifyingId(assignmentId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/review-plan/assignments/${assignmentId}/verify-review`,
        { method: "POST" },
      );
      const data = await readApiJson<{
        error?: string;
        visibility?: string;
        detail?: string;
        message?: string;
      }>(res);
      if (!res.ok) {
        setError(data.error || "Quét review thất bại");
        return;
      }
      setMsg(
        `Quét xong: ${reviewVisibilityLabel(data.visibility) || data.visibility}${data.detail ? ` — ${data.detail}` : ""}`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setVerifyingId(null);
    }
  }

  async function verifyAllCompleted() {
    setError("");
    setMsg("");
    setVerifyAllBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/review-plan/verify-all`, {
        method: "POST",
      });
      const data = await readApiJson<{
        error?: string;
        checked?: number;
        summary?: Record<string, number>;
        message?: string;
      }>(res);
      if (!res.ok) {
        setError(data.error || "Quét hàng loạt thất bại");
        return;
      }
      const parts = Object.entries(data.summary ?? {})
        .map(([k, n]) => `${reviewVisibilityLabel(k) || k}: ${n}`)
        .join(" · ");
      setMsg(data.message + (parts ? ` (${parts})` : ""));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không kết nối được máy chủ");
    } finally {
      setVerifyAllBusy(false);
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

  const overdueByScheduleCount = clientNow
    ? (plan?.assignments.filter(
        (a) =>
          a.status === "PENDING" &&
          getScheduleState(a.scheduledAt, clientNow) === "overdue",
      ).length ?? 0)
    : 0;

  const failedAssignments =
    plan?.assignments.filter((a) => a.status === "FAILED" || a.status === "SKIPPED") ?? [];
  const completedAssignments =
    plan?.assignments.filter((a) => a.status === "COMPLETED") ?? [];

  return (
    <section className="panel space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-[var(--ink)]">
            Kế hoạch đánh giá Maps
          </h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Lịch đăng · gán mail · auto khi RUNNING
            {ratingScannedAt ? ` · Sao chốt ${formatDateTimeVi(ratingScannedAt)}` : ""}
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
        <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--ink-soft)]">
          <span>
            {formatStarDistribution(displayPlan.countsByStar) || "—"} →{" "}
            {displayPlan.currentRating}★ dự kiến {displayPlan.projectedRating}★ (mục tiêu{" "}
            {displayPlan.desiredRating}★)
          </span>
          {readyProfileCount != null && (
            <span className="text-[var(--muted)]">
              {" "}
              · Mail READY: {readyProfileCount}
              {eligibleSnap != null ? ` · Khả dụng: ${eligibleSnap.eligibleCount}` : ""}
              {mediaCount > 0 ? ` · ${mediaCount} ảnh` : ""}
            </span>
          )}
        </div>
      )}

      {eligibleSnap && eligibleSnap.unassignedSlots > 0 && plan && (
        <p className="text-xs text-[var(--warn-ink)]">
          {eligibleSnap.unassignedSlots} bài chưa gán mail · {eligibleSnap.eligibleCount} mail khả dụng.{" "}
          <button
            type="button"
            className="link-accent"
            disabled={busy || eligibleSnap.eligibleCount === 0}
            onClick={() => void fillEmptyProfiles()}
          >
            Tự gán
          </button>
          {" · "}
          <button
            type="button"
            className="link-accent"
            disabled={busy}
            onClick={() => void loadEligible()}
          >
            Làm mới
          </button>
        </p>
      )}

      {planMissingSchedule && (
        <p className="text-xs text-[var(--warn-ink)]">
          Chưa có lịch — bấm <strong>Lập kế hoạch</strong>.
        </p>
      )}

      {planUsesLegacyImages && (
        <p className="text-xs text-[var(--warn-ink)]">
          Kế hoạch cũ (1 ảnh/bài) — <strong>Lập kế hoạch</strong> lại để random 1–3 ảnh.
        </p>
      )}

      {!initialLoading && !displayPlan && planBlockers.length === 0 && (
        <p className="text-sm text-[var(--warn)]">
          Chưa tính được phân bổ sao — cần số sao hiện tại, mục tiêu và số bình luận trên dự án.
        </p>
      )}

      {!initialLoading && !canCreatePlan && planBlockers.length > 0 && (
        <p className="text-xs text-[var(--warn-ink)]">
          Chưa lập được: {planBlockers.join(" · ")}
        </p>
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
          {plan?.status === "RUNNING" && autoDispatchPaused != null && (
            <>
              <span
                className={`badge ${autoDispatchPaused ? "badge-neutral text-[var(--warn-ink)]" : "badge-accent"}`}
                title="Trạng thái enqueue tự động (mọi dự án)"
              >
                Tự động: {autoDispatchPaused ? "đã dừng" : "đang chạy"}
              </span>
              {isAdmin &&
                (autoDispatchPaused ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || autoDispatchBusy}
                    title="Bật lại loop đăng theo lịch (30s/tick)"
                    onClick={() => void setAutoDispatchPausedState(false)}
                  >
                    {autoDispatchBusy ? "Đang…" : "Tiếp tục đăng tự động"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || autoDispatchBusy}
                    title="Dừng enqueue tự động — job đang chạy vẫn tiếp tục; vẫn đăng tay được"
                    onClick={() => void setAutoDispatchPausedState(true)}
                  >
                    {autoDispatchBusy ? "Đang…" : "Dừng đăng tự động"}
                  </button>
                ))}
            </>
          )}
          {completedAssignments.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || verifyAllBusy || verifyingId !== null}
              onClick={() => void verifyAllCompleted()}
            >
              {verifyAllBusy ? "Đang quét…" : `Quét ${completedAssignments.length} bài đã đăng`}
            </button>
          )}
        </div>
      </div>

      {(overdueByScheduleCount > 0 || failedAssignments.length > 0) && (
        <p className="text-xs text-[var(--warn-ink)]">
          {overdueByScheduleCount > 0 && (
            <span>
              {overdueByScheduleCount} quá hạn — đổi ngày hoặc Đăng tay.{" "}
            </span>
          )}
          {failedAssignments.length > 0 && (
            <span>{failedAssignments.length} lỗi — Đăng lại hoặc Lập kế hoạch.</span>
          )}
        </p>
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
            {failedAssignments.slice(0, 12).map((a) => {
              const err =
                formatReviewError(a.error, 100) ||
                assignmentStatusLabel(a.status);
              return (
                <li key={a.id} className="truncate" title={err}>
                  <strong>#{a.sortOrder + 1}</strong> {a.profileEmail || "—"}:{" "}
                  {err}
                </li>
              );
            })}
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
                  <th className="py-2 pr-2">Quét</th>
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
                    !!a.apmProfileId &&
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
                    <td className="py-2 pr-2 text-xs">
                      {a.status === "PENDING" || a.status === "FAILED" ? (
                        <select
                          className="input !px-2 !py-1 max-w-[180px] text-xs"
                          value={a.apmProfileId ?? ""}
                          disabled={busy || savingProfileId === a.id || postingId !== null}
                          onChange={(e) => {
                            void saveAssignmentProfile(a.id, e.target.value);
                          }}
                        >
                          <option value="">— Chưa gán mail —</option>
                          {(eligibleSnap?.profiles ?? []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.email}
                            </option>
                          ))}
                          {a.apmProfileId &&
                            a.profileEmail &&
                            !eligibleSnap?.profiles.some((p) => p.id === a.apmProfileId) && (
                              <option value={a.apmProfileId}>{a.profileEmail}</option>
                            )}
                        </select>
                      ) : (
                        a.profileEmail || "—"
                      )}
                      {savingProfileId === a.id && (
                        <span className="block text-[var(--muted)]">Đang lưu…</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <MediaThumbs
                        assets={assignmentMedia(a)}
                        onPreview={setLightboxSrc}
                      />
                    </td>
                    <td className="w-[160px] max-w-[160px] py-2 pr-2 align-top">
                      <span className="badge badge-neutral" title={a.status}>
                        {assignmentStatusLabel(a.status)}
                      </span>
                      {a.status === "COMPLETED" && a.reviewVisibility && (
                        <span
                          className={`mt-1 block ${reviewVisibilityBadgeClass(a.reviewVisibility)}`}
                          title={
                            a.lastVerifiedAt
                              ? `Quét lúc ${formatDateTimeVi(a.lastVerifiedAt)}`
                              : undefined
                          }
                        >
                          {reviewVisibilityLabel(a.reviewVisibility)}
                        </span>
                      )}
                      {a.error && (
                        <p
                          className="mt-1 line-clamp-2 text-xs leading-snug text-[var(--danger)]"
                          title={formatReviewError(a.error, 200)}
                        >
                          {formatReviewError(a.error, 72)}
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
                    <td className="py-2 pr-2">
                      {a.status === "COMPLETED" ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-soft"
                          disabled={busy || verifyAllBusy || verifyingId !== null}
                          onClick={() => void verifyAssignment(a.id)}
                        >
                          {verifyingId === a.id ? "Đang…" : "Quét"}
                        </button>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
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
