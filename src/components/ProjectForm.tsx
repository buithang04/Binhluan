"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_PROJECT_MEDIA } from "@/lib/limits";
import { planReviewStars } from "@/lib/review-planner";
import {
  addCalendarDays,
  vnMinCampaignStartDate,
} from "@/lib/review-schedule";

type Package = {
  id: string;
  code: string;
  name: string;
  targetContents: number;
};

type ProductRow = { name: string; description: string };

type MediaItem = {
  id: string;
  filePath: string;
  caption: string | null;
};

type ProjectFormProps = {
  mode: "create" | "edit";
  projectId?: string;
  initialPackages?: Package[];
  /** Doanh nghiệp Active — tự điền bước thông tin DN khi tạo dự án. */
  activeBusiness?: {
    brandName: string;
    website: string | null;
    brandDescription: string;
    targetAudience: string;
    targetMarket: string;
    writingNotes: string | null;
    products: ProductRow[];
  } | null;
  initial?: {
    brandName: string;
    website: string | null;
    brandDescription: string;
    targetAudience: string;
    targetMarket: string;
    writingNotes: string | null;
    googleMapsUrl: string;
    packageId: string;
    desiredRating: string | number | null;
    currentRating: string | number | null;
    reviewCount: string | number | null;
    ratingScannedAt?: string | null;
    reviewsToPost?: string | number | null;
    proxyCooldownMinutes?: string | number | null;
    startAt: string;
    endAt: string;
    products: ProductRow[];
    media?: MediaItem[];
  };
};

function toDateInput(value?: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function ProjectForm({
  mode,
  projectId,
  initialPackages,
  activeBusiness,
  initial,
}: ProjectFormProps) {
  const router = useRouter();
  const [packages, setPackages] = useState<Package[]>(initialPackages || []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>(initial?.media || []);
  const [uploading, setUploading] = useState(false);
  const [filledFromBusiness, setFilledFromBusiness] = useState(false);

  const seed = mode === "create" && activeBusiness ? activeBusiness : null;

  const [brandName, setBrandName] = useState(initial?.brandName || seed?.brandName || "");
  const [website, setWebsite] = useState(initial?.website || seed?.website || "");
  const [brandDescription, setBrandDescription] = useState(
    initial?.brandDescription || seed?.brandDescription || "",
  );
  const [targetAudience, setTargetAudience] = useState(
    initial?.targetAudience || seed?.targetAudience || "",
  );
  const [targetMarket, setTargetMarket] = useState(
    initial?.targetMarket || seed?.targetMarket || "",
  );
  const [writingNotes, setWritingNotes] = useState(
    initial?.writingNotes || seed?.writingNotes || "",
  );
  const [googleMapsUrl, setGoogleMapsUrl] = useState(initial?.googleMapsUrl || "");
  const [packageId, setPackageId] = useState(
    initial?.packageId || initialPackages?.[0]?.id || "",
  );
  const [desiredRating, setDesiredRating] = useState(
    initial?.desiredRating != null ? String(initial.desiredRating) : "",
  );
  const [currentRating, setCurrentRating] = useState(
    initial?.currentRating != null ? String(initial.currentRating) : "",
  );
  const [reviewCount, setReviewCount] = useState(
    initial?.reviewCount != null ? String(initial.reviewCount) : "",
  );
  const [ratingScannedAt, setRatingScannedAt] = useState(
    initial?.ratingScannedAt ?? "",
  );
  const [proxyCooldownMinutes, setProxyCooldownMinutes] = useState(
    initial?.proxyCooldownMinutes != null ? String(initial.proxyCooldownMinutes) : "60",
  );
  const [checkingMaps, setCheckingMaps] = useState(false);
  const [mapsStatus, setMapsStatus] = useState<"idle" | "ok" | "warn" | "error">("idle");
  const [mapsHint, setMapsHint] = useState("");
  const [startAt, setStartAt] = useState(toDateInput(initial?.startAt));
  const [endAt, setEndAt] = useState(toDateInput(initial?.endAt));
  const minCampaignDate = vnMinCampaignStartDate();
  const minEndDate =
    startAt && startAt >= minCampaignDate
      ? addCalendarDays(startAt, 1)
      : addCalendarDays(minCampaignDate, 1);
  const [products, setProducts] = useState<ProductRow[]>(
    initial?.products?.length
      ? initial.products
      : seed?.products?.length
        ? seed.products
        : [{ name: "", description: "" }],
  );
  /** Chỉ dùng khi create: 1 = Gói & thời gian, 2 = Thông tin doanh nghiệp */
  const [createStep, setCreateStep] = useState<1 | 2>(1);

  useEffect(() => {
    if (mode !== "create" || !activeBusiness || filledFromBusiness) return;
    setBrandName((v) => v || activeBusiness.brandName);
    setWebsite((v) => v || activeBusiness.website || "");
    setBrandDescription((v) => v || activeBusiness.brandDescription || "");
    setTargetAudience((v) => v || activeBusiness.targetAudience || "");
    setTargetMarket((v) => v || activeBusiness.targetMarket || "");
    setWritingNotes((v) => v || activeBusiness.writingNotes || "");
    setProducts((rows) => {
      const empty = rows.length === 1 && !rows[0]?.name && !rows[0]?.description;
      if (!empty) return rows;
      return activeBusiness.products?.length
        ? activeBusiness.products
        : rows;
    });
    setFilledFromBusiness(true);
  }, [mode, activeBusiness, filledFromBusiness]);

  useEffect(() => {
    if (initialPackages?.length) return;
    fetch("/api/packages")
      .then((r) => r.json())
      .then((d) => {
        setPackages(d.packages || []);
        const first = d.packages?.[0];
        setPackageId((current) => current || first?.id || "");
      })
      .catch(() => setError("Không tải được danh sách gói"));
  }, [initialPackages]);

  function updateProduct(index: number, field: keyof ProductRow, value: string) {
    setProducts((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  async function checkGoogleMaps(): Promise<boolean> {
    const url = googleMapsUrl.trim();
    if (!url) {
      setMapsStatus("error");
      setMapsHint("Vui lòng nhập link Google Maps");
      return false;
    }

    if (checkingMaps) return false;

    setCheckingMaps(true);
    setMapsStatus("idle");
    setMapsHint("Đang kiểm tra link…");

    try {
      // Fast path: validate + follow redirect (<1s) — không chờ Puppeteer
      const res = await fetch("/api/projects/resolve-maps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, scrape: false }),
      });
      const data = await res.json();

      if (!res.ok || data.valid === false) {
        setMapsStatus("error");
        setMapsHint(data.message || data.error || "Link Google Maps không hợp lệ");
        setCheckingMaps(false);
        return false;
      }

      if (data.resolvedUrl && data.resolvedUrl !== url) {
        setGoogleMapsUrl(data.resolvedUrl);
      }
      if (data.placeName && !brandName.trim()) setBrandName(data.placeName);

      setMapsStatus("ok");
      setMapsHint("✓ Link hợp lệ — đang quét sao/lượt đánh giá ở nền…");
      setCheckingMaps(false);

      // Background scrape — không chặn bước tiếp theo / tạo dự án
      const resolved = data.resolvedUrl || url;
      void (async () => {
        try {
          const scrapeRes = await fetch("/api/projects/resolve-maps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: resolved, scrape: true }),
          });
          const scrape = await scrapeRes.json();
          if (!scrapeRes.ok || scrape.valid === false) return;

          if (scrape.placeName) {
            setBrandName((prev) => (prev.trim() ? prev : scrape.placeName));
          }

          const scanned = new Date().toISOString();
          const hasRating = scrape.currentRating != null;
          const hasCount = scrape.reviewCount != null;

          if (hasCount) {
            setReviewCount(String(scrape.reviewCount));
          }
          if (hasRating) {
            setCurrentRating(String(scrape.currentRating));
          } else if (scrape.reviewCount === 0) {
            // Place chưa có đánh giá → không có điểm TB, dùng 0 để lập kế hoạch
            setCurrentRating("0");
          }

          if (hasRating || hasCount) {
            setRatingScannedAt(scanned);
            setMapsStatus("ok");
            if (scrape.reviewCount === 0) {
              setMapsHint(
                `✓ Link hợp lệ · place chưa có đánh giá (0 lượt) · ${new Date(scanned).toLocaleString("vi-VN")}`,
              );
            } else {
              setMapsHint(
                `✓ Link hợp lệ · ${scrape.currentRating ?? "—"} sao · ${scrape.reviewCount ?? "—"} lượt · ${new Date(scanned).toLocaleString("vi-VN")}`,
              );
            }
          } else {
            setMapsStatus("warn");
            setMapsHint(
              "✓ Link hợp lệ — chưa quét được sao/lượt. Nhập tay: 0 lượt nếu place chưa có đánh giá.",
            );
          }
        } catch {
          setMapsStatus("warn");
          setMapsHint(
            "✓ Link hợp lệ — quét sao chậm/lỗi. Có thể nhập tay số sao và lượt đánh giá.",
          );
        }
      })();
      return true;
    } catch {
      setMapsStatus("error");
      setMapsHint("Không kiểm tra được link. Thử lại sau.");
      setCheckingMaps(false);
      return false;
    }
  }

  function validateStep1(): string | null {
    if (!packageId) return "Vui lòng chọn gói";
    if (!googleMapsUrl.trim()) return "Vui lòng nhập link Google Maps";
    if (mapsStatus === "error") return "Link Google Maps chưa hợp lệ — kiểm tra lại";
    const cooldown = Number(proxyCooldownMinutes);
    if (!Number.isFinite(cooldown) || cooldown < 0) {
      return "Cooldown proxy phải là số ≥ 0";
    }
    if (!startAt) return "Vui lòng chọn ngày bắt đầu";
    if (startAt < minCampaignDate) {
      return `Ngày bắt đầu phải từ ${minCampaignDate} trở đi`;
    }
    if (!endAt) return "Vui lòng chọn ngày kết thúc";
    if (endAt <= startAt) return "Ngày kết thúc phải sau ngày bắt đầu";
    return null;
  }

  function validateStep2(): string | null {
    if (!brandName.trim()) return "Vui lòng nhập Brand Name";
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!p.name.trim() || p.name.trim().length < 2) {
        return `Tên sản phẩm ${i + 1} cần ít nhất 2 ký tự`;
      }
      if (!p.description.trim() || p.description.trim().length < 10) {
        return `Mô tả sản phẩm ${i + 1} cần ít nhất 10 ký tự`;
      }
    }
    return null;
  }

  async function goNextStep() {
    setError("");
    const err = validateStep1();
    if (err) {
      setError(err);
      return;
    }
    if (mapsStatus === "idle" && googleMapsUrl.trim()) {
      const ok = await checkGoogleMaps();
      if (!ok) {
        setError("Link Google Maps chưa hợp lệ — kiểm tra lại");
        return;
      }
    }
    setCreateStep(2);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "create" && createStep !== 2) {
      await goNextStep();
      return;
    }
    setError("");

    if (mode === "create") {
      const step1Err = validateStep1();
      if (step1Err) {
        setCreateStep(1);
        setError(step1Err);
        return;
      }
      const step2Err = validateStep2();
      if (step2Err) {
        setError(step2Err);
        return;
      }
    }

    setSaving(true);

    const payload = {
      brandName,
      website,
      brandDescription,
      targetAudience,
      targetMarket,
      writingNotes,
      googleMapsUrl,
      packageId,
      desiredRating: desiredRating || null,
      currentRating: currentRating || null,
      reviewCount: reviewCount || null,
      ratingScannedAt: ratingScannedAt || null,
      proxyCooldownMinutes: proxyCooldownMinutes || 60,
      startAt,
      endAt,
      products,
    };

    const url = mode === "create" ? "/api/projects" : `/api/projects/${projectId}`;
    const method = mode === "create" ? "POST" : "PUT";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lưu thất bại");
        return;
      }
      router.replace(`/app/projects/${data.project.id}?setup=1`);
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  }

  async function onUpload(file: File, opts?: { silent?: boolean }) {
    if (!projectId) return false;
    if (!opts?.silent) {
      setUploading(true);
      setError("");
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`/api/projects/${projectId}/media`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload thất bại");
        return false;
      }
      setMedia((m) => [...m, data.media]);
      return true;
    } catch {
      setError("Upload thất bại");
      return false;
    } finally {
      if (!opts?.silent) setUploading(false);
    }
  }

  async function onUploadMany(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length || !projectId) return;
    const max = MAX_PROJECT_MEDIA;
    const room = Math.max(0, max - media.length);
    if (room <= 0) {
      setError(`Tối đa ${MAX_PROJECT_MEDIA} ảnh mỗi dự án`);
      return;
    }
    const batch = list.slice(0, room);
    setUploading(true);
    setError("");
    try {
      for (const f of batch) {
        await onUpload(f, { silent: true });
      }
      if (list.length > room) {
        setError(`Chỉ thêm được ${room} ảnh nữa (tối đa ${MAX_PROJECT_MEDIA})`);
      }
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteMedia(mediaId: string) {
    if (!projectId) return;
    const res = await fetch(`/api/projects/${projectId}/media/${mediaId}`, {
      method: "DELETE",
    });
    if (res.ok) setMedia((m) => m.filter((x) => x.id !== mediaId));
  }

  const selectedPkg = packages.find((p) => p.id === packageId);

  const starPlanPreview = useMemo(() => {
    const n = selectedPkg?.targetContents;
    const des = Number(desiredRating);
    const rc = Number(reviewCount);
    const reviewCountNum = Number.isFinite(rc) && rc >= 0 ? rc : NaN;
    let cur = Number(currentRating);
    // Place 0 lượt + để trống sao → coi như 0 để xem phân bổ
    if (
      (!Number.isFinite(cur) || currentRating.trim() === "") &&
      reviewCountNum === 0
    ) {
      cur = 0;
    }
    if (!n || !Number.isFinite(cur) || !Number.isFinite(des) || !Number.isFinite(reviewCountNum)) {
      return null;
    }
    return planReviewStars({
      currentRating: cur,
      reviewCount: reviewCountNum,
      desiredRating: des,
      reviewsToPost: n,
    });
  }, [currentRating, desiredRating, reviewCount, selectedPkg?.targetContents]);

  const showPackage = mode === "edit" || createStep === 1;
  const showBusiness = mode === "edit" || createStep === 2;

  const packageSection = (
    <section className="space-y-4">
      {mode === "edit" && (
        <h2 className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
          Gói & thời gian
        </h2>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Gói *" htmlFor="packageId">
          <select
            id="packageId"
            className="input"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            required={showPackage}
          >
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name} ({p.targetContents} bình luận)
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2 space-y-2">
          <Field label="Link Google Maps *" htmlFor="googleMapsUrl">
            <input
              id="googleMapsUrl"
              className="input"
              value={googleMapsUrl}
              onChange={(e) => {
                setGoogleMapsUrl(e.target.value);
                setMapsStatus("idle");
                setMapsHint("");
              }}
              placeholder="https://maps.google.com/... hoặc https://maps.app.goo.gl/..."
              required={showPackage}
            />
          </Field>
          <button
            type="button"
            disabled={checkingMaps || !googleMapsUrl.trim()}
            onClick={() => void checkGoogleMaps()}
            className="btn btn-secondary !bg-[var(--accent-soft)] !text-[var(--accent-ink)]"
          >
            {checkingMaps ? "Đang kiểm tra…" : "Kiểm tra link Maps"}
          </button>
          {mapsHint && (
            <p
              className={`text-xs ${
                mapsStatus === "ok"
                  ? "text-[var(--accent-ink)]"
                  : mapsStatus === "warn"
                    ? "text-[var(--warn)]"
                    : mapsStatus === "error"
                      ? "text-[var(--danger)]"
                      : "text-[var(--muted)]"
              }`}
            >
              {mapsHint}
            </p>
          )}
        </div>
        <Field label="Số sao mong muốn" htmlFor="desiredRating">
          <input
            id="desiredRating"
            type="number"
            min={1}
            max={5}
            step={0.1}
            className="input"
            value={desiredRating}
            onChange={(e) => setDesiredRating(e.target.value)}
          />
        </Field>
        <Field label="Số sao trung bình hiện tại" htmlFor="currentRating">
          <input
            id="currentRating"
            type="number"
            min={0}
            max={5}
            step={0.1}
            className="input"
            value={currentRating}
            onChange={(e) => {
              setCurrentRating(e.target.value);
              setRatingScannedAt("");
            }}
            placeholder="VD: 4.5 — hoặc 0 nếu chưa có đánh giá"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            Ưu tiên lấy từ Maps khi kiểm tra link; có thể nhập tay (0 nếu place chưa có đánh giá).
          </p>
          {ratingScannedAt && (
            <p className="mt-1 text-xs text-[var(--accent-ink)]">
              Quét/chốt lúc {new Date(ratingScannedAt).toLocaleString("vi-VN")}
            </p>
          )}
        </Field>
        <Field label="Lượt đánh giá hiện tại" htmlFor="reviewCount">
          <input
            id="reviewCount"
            type="number"
            min={0}
            step={1}
            className="input"
            value={reviewCount}
            onChange={(e) => {
              setReviewCount(e.target.value);
              setRatingScannedAt("");
            }}
            placeholder="VD: 12 — hoặc 0 nếu chưa có đánh giá"
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            Ưu tiên lấy từ Maps khi kiểm tra link; có thể nhập tay.
          </p>
        </Field>
        <Field label="Số bình luận sẽ đăng" htmlFor="reviewsToPost">
          <input
            id="reviewsToPost"
            type="text"
            className="input cursor-not-allowed bg-[var(--surface-muted)] text-[var(--ink-soft)]"
            value={selectedPkg ? String(selectedPkg.targetContents) : "—"}
            readOnly
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            Cố định theo gói đã chọn — dự án hoàn thành khi đăng đủ số bài này.
          </p>
          {starPlanPreview && (
            <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-2 text-xs text-[var(--ink-soft)]">
              Phân bổ dự kiến:{" "}
              {Object.entries(starPlanPreview.countsByStar)
                .filter(([, c]) => c > 0)
                .map(([s, c]) => `${c}×${s}★`)
                .join(", ") || "—"}{" "}
              → {starPlanPreview.projectedRating}★ (mục tiêu {starPlanPreview.desiredRating}★,
              Δ {starPlanPreview.delta})
            </p>
          )}
        </Field>
        <Field label="Cooldown proxy (phút) *" htmlFor="proxyCooldownMinutes">
          <input
            id="proxyCooldownMinutes"
            type="number"
            min={0}
            max={10080}
            className="input"
            value={proxyCooldownMinutes}
            onChange={(e) => setProxyCooldownMinutes(e.target.value)}
            placeholder="60"
            required={showPackage}
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            Sau mỗi bài, proxy bị khóa cooldown trước khi dự án khác dùng lại
          </p>
        </Field>
        <Field label="Bắt đầu *" htmlFor="startAt">
          <input
            id="startAt"
            type="date"
            className="input"
            value={startAt}
            min={minCampaignDate}
            onChange={(e) => {
              const next = e.target.value;
              setStartAt(next);
              if (next && endAt && endAt <= next) {
                setEndAt(addCalendarDays(next, 1));
              }
            }}
            required={showPackage}
          />
          <p className="mt-1 text-xs text-[var(--muted)]">
            Chỉ chọn từ ngày mai ({minCampaignDate}) — không chọn hôm nay hoặc ngày đã qua
          </p>
        </Field>
        <Field label="Kết thúc *" htmlFor="endAt">
          <input
            id="endAt"
            type="date"
            className="input"
            value={endAt}
            min={minEndDate}
            onChange={(e) => setEndAt(e.target.value)}
            required={showPackage}
          />
        </Field>
      </div>
    </section>
  );

  const businessSection = (
    <section className="space-y-4">
      {mode === "edit" && (
        <h2 className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
          Thông tin doanh nghiệp
        </h2>
      )}
      {mode === "create" && filledFromBusiness && activeBusiness && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--accent-ink)]">
          Đã điền từ doanh nghiệp Active “{activeBusiness.brandName}”. Bạn vẫn có thể chỉnh trước khi lưu.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand Name *" htmlFor="brandName">
          <input
            id="brandName"
            className="input"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            required={showBusiness}
          />
        </Field>
        <Field label="The Website" htmlFor="website">
          <input
            id="website"
            className="input"
            placeholder="https://"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Brand Description" htmlFor="brandDescription">
        <textarea
          id="brandDescription"
          className="input min-h-24"
          value={brandDescription}
          onChange={(e) => setBrandDescription(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target Audience" htmlFor="targetAudience">
          <textarea
            id="targetAudience"
            className="input min-h-20"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
          />
        </Field>
        <Field label="Target Market" htmlFor="targetMarket">
          <textarea
            id="targetMarket"
            className="input min-h-20"
            value={targetMarket}
            onChange={(e) => setTargetMarket(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Lưu ý khi viết" htmlFor="writingNotes">
        <textarea
          id="writingNotes"
          className="input min-h-20"
          value={writingNotes}
          onChange={(e) => setWritingNotes(e.target.value)}
        />
      </Field>

      <div className="space-y-4 border-t border-[var(--line)] pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Danh sách sản phẩm</h3>
          </div>
          <button
            type="button"
            className="link-accent text-sm"
            onClick={() =>
              setProducts((rows) => [...rows, { name: "", description: "" }])
            }
          >
            + Thêm sản phẩm
          </button>
        </div>
        {products.map((p, i) => (
          <div key={i} className="panel-muted grid gap-3 p-3 sm:grid-cols-2">
            <Field label={`Tên sản phẩm ${i + 1} *`} htmlFor={`pn-${i}`}>
              <input
                id={`pn-${i}`}
                className="input"
                value={p.name}
                onChange={(e) => updateProduct(i, "name", e.target.value)}
                placeholder="VD: Gói thăm viếng"
                minLength={2}
                required={showBusiness}
              />
            </Field>
            <Field label="Mô tả sản phẩm *" htmlFor={`pd-${i}`}>
              <textarea
                id={`pd-${i}`}
                className="input min-h-16"
                value={p.description}
                onChange={(e) => updateProduct(i, "description", e.target.value)}
                placeholder="Mô tả ngắn (≥10 ký tự)"
                minLength={10}
                required={showBusiness}
              />
            </Field>
            {products.length > 1 && (
              <button
                type="button"
                className="text-left text-sm text-red-600 sm:col-span-2"
                onClick={() => setProducts((rows) => rows.filter((_, idx) => idx !== i))}
              >
                Xóa dòng này
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <form
      onSubmit={onSubmit}
      className={mode === "create" ? "flex flex-col gap-0" : "space-y-8"}
    >
      {mode === "create" && (
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Bước {createStep} / 2
            </p>
            <h2 className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
              {createStep === 1 ? "Gói & thời gian" : "Thông tin doanh nghiệp"}
            </h2>
          </div>
          <div className="flex gap-1.5" aria-hidden>
            <span
              className={`h-1.5 w-8 rounded-full ${
                createStep >= 1 ? "bg-[var(--accent)]" : "bg-[var(--line)]"
              }`}
            />
            <span
              className={`h-1.5 w-8 rounded-full ${
                createStep >= 2 ? "bg-[var(--accent)]" : "bg-[var(--line)]"
              }`}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="space-y-8">
        {mode === "create" ? (
          <>
            {createStep === 1 && packageSection}
            {createStep === 2 && businessSection}
          </>
        ) : (
          <>
            {businessSection}
            {packageSection}
          </>
        )}

        {mode === "edit" && projectId && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
                  Thư viện ảnh
                </h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  JPG / PNG / WebP · tối đa 5MB/ảnh · {media.length}/{MAX_PROJECT_MEDIA}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="media-file-input"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="sr-only"
                  disabled={uploading || media.length >= MAX_PROJECT_MEDIA}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files?.length) void onUploadMany(files);
                    e.target.value = "";
                  }}
                />
                <label
                  htmlFor="media-file-input"
                  className={`btn btn-primary cursor-pointer !py-2 ${
                    uploading || media.length >= MAX_PROJECT_MEDIA
                      ? "pointer-events-none opacity-50"
                      : ""
                  }`}
                >
                  {uploading ? "Đang tải…" : "+ Thêm ảnh"}
                </label>
              </div>
            </div>

            <label
              htmlFor="media-file-input"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (uploading) return;
                if (media.length >= MAX_PROJECT_MEDIA) return;
                const files = e.dataTransfer.files;
                if (files?.length) void onUploadMany(files);
              }}
              className="flex min-h-[7rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-6 text-center transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/40"
            >
              <span className="text-sm font-medium text-[var(--ink)]">
                Kéo thả ảnh vào đây hoặc bấm “+ Thêm ảnh”
              </span>
              <span className="text-xs text-[var(--muted)]">
                Có thể chọn nhiều file cùng lúc
              </span>
            </label>

            {media.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {media.map((m) => (
                  <div
                    key={m.id}
                    className="group relative overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={m.filePath}
                      alt={m.caption || ""}
                      className="aspect-square h-auto w-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-8">
                      <span className="truncate text-xs text-white/90">
                        {m.caption || "Ảnh dự án"}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 rounded bg-white/95 px-2 py-1 text-xs font-medium text-[var(--danger)] shadow-sm hover:bg-white"
                        onClick={() => void onDeleteMedia(m.id)}
                      >
                        Xóa
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                Chưa có ảnh — thêm ảnh để gắn vào đánh giá Maps.
              </p>
            )}
          </section>
        )}
      </div>

      <div
        className={`flex flex-wrap gap-3 ${
          mode === "create" ? "mt-5 border-t border-[var(--line)] pt-4" : ""
        }`}
      >
        {mode === "create" && createStep === 2 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setError("");
              setCreateStep(1);
            }}
          >
            Quay lại
          </button>
        )}
        {mode === "create" && createStep === 1 ? (
          <button type="button" className="btn btn-primary" onClick={goNextStep}>
            Tiếp theo
          </button>
        ) : (
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Đang lưu..." : mode === "create" ? "Tạo dự án" : "Cập nhật"}
          </button>
        )}
        <button
          type="button"
          onClick={() => router.back()}
          className="btn btn-secondary"
        >
          Hủy
        </button>
      </div>
      {mode === "create" && (
        <p className="mt-3 text-sm text-[var(--muted)]">
          Sau khi tạo dự án, bạn có thể upload ảnh vào thư viện ở trang chỉnh sửa.
        </p>
      )}
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-1.5 text-sm">
      <span className="font-medium text-[var(--ink-soft)]">{label}</span>
      {children}
    </label>
  );
}
