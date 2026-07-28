"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import {
  blobToFile,
  editedFileName,
  getEditedImageBlob,
  guessMimeType,
} from "@/lib/crop-image";

type AspectOption = { id: string; label: string; value?: number };

const ASPECT_OPTIONS: AspectOption[] = [
  { id: "free", label: "Tự do" },
  { id: "1:1", label: "1:1", value: 1 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "3:4", label: "3:4", value: 3 / 4 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
];

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Lucide rotate-ccw */
function IconRotateLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 3v5h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Lucide rotate-cw */
function IconRotateRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 3v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconReset() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 3v5h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-soft)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-ink)]"
    >
      {children}
    </button>
  );
}

export type MediaEditModalProps = {
  imageSrc: string;
  originalFileName?: string;
  caption: string;
  saving?: boolean;
  dirty?: boolean;
  error?: string;
  onCaptionChange: (value: string) => void;
  onClose: () => void;
  onDelete: () => void;
  onSave: (file: File | null) => void;
  onReplaceImage?: (file: File) => void;
};

export function MediaEditModal({
  imageSrc,
  originalFileName,
  caption,
  saving = false,
  dirty = false,
  error: externalError,
  onCaptionChange,
  onClose,
  onDelete,
  onSave,
  onReplaceImage,
}: MediaEditModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [aspectId, setAspectId] = useState("free");
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const replaceRef = useRef<HTMLInputElement>(null);

  const aspect = ASPECT_OPTIONS.find((o) => o.id === aspectId)?.value;

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedArea(pixels);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !processing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving, processing]);

  function resetTransforms() {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    setAspectId("free");
  }

  async function handleSave() {
    if (!croppedArea) return;
    setProcessing(true);
    setError("");
    try {
      const mime = guessMimeType(originalFileName);
      const blob = await getEditedImageBlob(
        imageSrc,
        croppedArea,
        rotation,
        { horizontal: false, vertical: false },
        mime,
      );
      if (!blob) {
        setError("Không xử lý được ảnh");
        return;
      }
      onSave(blobToFile(blob, editedFileName(originalFileName)));
    } catch {
      setError("Không xử lý được ảnh");
    } finally {
      setProcessing(false);
    }
  }

  const busy = saving || processing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="panel flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden shadow-[var(--shadow-md)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <h3 className="font-display text-base font-semibold text-[var(--ink)]">
              Chỉnh sửa ảnh
            </h3>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Kéo để di chuyển · Cuộn để zoom
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] transition hover:bg-[var(--ghost-hover)] hover:text-[var(--ink)] disabled:opacity-50"
              aria-label="Đóng"
            >
              <IconClose />
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || !croppedArea}
              className="btn btn-primary !py-2"
            >
              {busy ? "Đang lưu…" : "Lưu"}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Crop canvas */}
          <div className="relative h-64 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line)] bg-[#1a1f26] sm:h-72">
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              rotation={rotation}
              aspect={aspect}
              showGrid
              cropShape="rect"
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onRotationChange={setRotation}
              onCropComplete={onCropComplete}
              style={{
                containerStyle: { background: "#1a1f26" },
                cropAreaStyle: {
                  border: "2px solid rgba(255,255,255,0.9)",
                  borderRadius: 4,
                },
              }}
            />
            {dirty && (
              <span className="absolute left-3 top-3 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-semibold text-white">
                Đã chỉnh sửa
              </span>
            )}
          </div>

          {/* Aspect ratios */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {ASPECT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAspectId(opt.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  aspectId === opt.id
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--line)] bg-[var(--surface-muted)] text-[var(--ink-soft)] hover:border-[var(--accent)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Tools */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex gap-1.5">
              <ToolButton label="Xoay trái" onClick={() => setRotation((r) => r - 90)}>
                <IconRotateLeft />
              </ToolButton>
              <ToolButton label="Xoay phải" onClick={() => setRotation((r) => r + 90)}>
                <IconRotateRight />
              </ToolButton>
              <ToolButton label="Đặt lại" onClick={resetTransforms}>
                <IconReset />
              </ToolButton>
            </div>
            <label className="flex min-w-[10rem] flex-1 items-center gap-2 text-xs text-[var(--muted)]">
              <span className="shrink-0">Zoom</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.02}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]"
              />
              <span className="w-9 shrink-0 text-right tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
            </label>
          </div>

          {/* Caption + actions */}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              <span className="font-medium text-[var(--ink-soft)]">Chú thích</span>
              <input
                className="input"
                value={caption}
                onChange={(e) => onCaptionChange(e.target.value)}
                placeholder="Mô tả ngắn (tuỳ chọn)"
                maxLength={200}
              />
            </label>
            <div className="flex shrink-0 flex-wrap gap-2">
              {onReplaceImage && (
                <>
                  <input
                    ref={replaceRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onReplaceImage(f);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => replaceRef.current?.click()}
                  >
                    Đổi ảnh
                  </button>
                </>
              )}
              <button
                type="button"
                className="text-sm text-[var(--danger)] hover:underline"
                disabled={busy}
                onClick={onDelete}
              >
                Xóa ảnh
              </button>
            </div>
          </div>

          {(error || externalError) && (
            <p className="mt-3 text-sm text-[var(--danger)]">{error || externalError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
