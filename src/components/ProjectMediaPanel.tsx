"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MediaEditModal } from "@/components/MediaEditModal";
import { MAX_PROJECT_MEDIA } from "@/lib/limits";

export type MediaItem = {
  id: string;
  filePath: string;
  caption: string | null;
  fileName?: string;
};

export function ProjectMediaPanel({
  projectId,
  initialMedia,
}: {
  projectId: string;
  initialMedia: MediaItem[];
}) {
  const [media, setMedia] = useState<MediaItem[]>(initialMedia);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MediaItem | null>(null);
  const [editCaption, setEditCaption] = useState("");
  const [editorSrc, setEditorSrc] = useState("");
  const [editorFileName, setEditorFileName] = useState<string | undefined>();
  const [pendingBlobUrl, setPendingBlobUrl] = useState<string | null>(null);
  const [imageReplaced, setImageReplaced] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(() => initialMedia.length === 0);

  useEffect(() => {
    setMedia(initialMedia);
  }, [initialMedia]);

  useEffect(() => {
    return () => {
      if (pendingBlobUrl) URL.revokeObjectURL(pendingBlobUrl);
    };
  }, [pendingBlobUrl]);

  const openEdit = useCallback((item: MediaItem) => {
    setEditing(item);
    setEditCaption(item.caption || "");
    setEditorSrc(item.filePath);
    setEditorFileName(item.fileName);
    setImageReplaced(false);
    setPendingBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError("");
  }, []);

  const closeEdit = useCallback(() => {
    setEditing(null);
    setEditCaption("");
    setEditorSrc("");
    setEditorFileName(undefined);
    setImageReplaced(false);
    setPendingBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError("");
  }, []);

  function handleReplaceImage(file: File) {
    const url = URL.createObjectURL(file);
    setPendingBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setEditorSrc(url);
    setEditorFileName(file.name);
    setImageReplaced(true);
  }

  async function onUploadMany(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const room = Math.max(0, MAX_PROJECT_MEDIA - media.length);
    if (room <= 0) {
      setError(`Tối đa ${MAX_PROJECT_MEDIA} ảnh mỗi dự án`);
      return;
    }
    const batch = list.slice(0, room);
    setUploading(true);
    setError("");
    try {
      for (const file of batch) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/media`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Upload thất bại");
          break;
        }
        setMedia((m) => [...m, data.media]);
      }
      if (list.length > room) {
        setError(`Chỉ thêm được ${room} ảnh nữa (tối đa ${MAX_PROJECT_MEDIA})`);
      }
    } catch {
      setError("Upload thất bại");
    } finally {
      setUploading(false);
    }
  }

  async function saveEdit(editedFile: File | null) {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const captionChanged =
        (editCaption || "") !== (editing.caption || "");
      const hasImageChange = !!editedFile || imageReplaced;

      let res: Response;
      if (hasImageChange && editedFile) {
        const form = new FormData();
        form.append("file", editedFile);
        form.append("caption", editCaption);
        res = await fetch(`/api/projects/${projectId}/media/${editing.id}`, {
          method: "PATCH",
          body: form,
        });
      } else if (captionChanged) {
        res = await fetch(`/api/projects/${projectId}/media/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caption: editCaption || null }),
        });
      } else {
        closeEdit();
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lưu thất bại");
        return;
      }
      setMedia((items) =>
        items.map((m) => (m.id === editing.id ? data.media : m)),
      );
      closeEdit();
    } catch {
      setError("Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  async function deleteMedia() {
    if (!editing || !confirm("Xóa ảnh này?")) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${editing.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Xóa thất bại");
        return;
      }
      setMedia((items) => items.filter((m) => m.id !== editing.id));
      closeEdit();
    } catch {
      setError("Xóa thất bại");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <div className="min-w-0">
              <h2 className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
                Thư viện ảnh ({media.length}/{MAX_PROJECT_MEDIA})
              </h2>
              {!open && (
                <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                  {media.length === 0
                    ? "Chưa có ảnh — bấm để mở và thêm"
                    : `${media.length} ảnh · JPG/PNG/WebP · bấm để mở`}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 text-sm text-[var(--muted)] transition-transform ${
                open ? "rotate-180" : ""
              }`}
              aria-hidden
            >
              ▼
            </span>
          </button>
          <input
            ref={fileInputRef}
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
          <button
            type="button"
            className="btn btn-primary btn-sm shrink-0"
            disabled={uploading || media.length >= MAX_PROJECT_MEDIA}
            onClick={() => {
              setOpen(true);
              fileInputRef.current?.click();
            }}
          >
            {uploading ? "Đang tải…" : "+ Thêm ảnh"}
          </button>
        </div>

        {!open && media.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto px-4 py-2.5 sm:px-5">
            {media.slice(0, 12).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setOpen(true);
                  openEdit(m);
                }}
                className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-[var(--line)]"
                title={m.caption || m.fileName || "Ảnh"}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.filePath} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
            {media.length > 12 && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--line)] text-xs text-[var(--muted)]"
              >
                +{media.length - 12}
              </button>
            )}
          </div>
        )}

        {open && (
          <div className="space-y-3 p-4 sm:p-5">
            <p className="text-xs text-[var(--muted)]">
              JPG / PNG / WebP · tối đa 5MB/ảnh · kéo thả để thêm
            </p>

            {error && !editing && (
              <p className="text-sm text-[var(--danger)]">{error}</p>
            )}

            {media.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex min-h-[5rem] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-4 text-center transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="text-sm text-[var(--ink)]">Chưa có ảnh — bấm để thêm</span>
              </button>
            ) : (
              <div
                className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (uploading || media.length >= MAX_PROJECT_MEDIA) return;
                  const files = e.dataTransfer.files;
                  if (files?.length) void onUploadMany(files);
                }}
              >
                {media.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => openEdit(m)}
                    className="group relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] text-left transition hover:border-[var(--accent)]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={m.filePath}
                      alt={m.caption || ""}
                      className="h-full w-full object-cover"
                    />
                    {m.caption ? (
                      <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">
                        {m.caption}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {editing && editorSrc && (
        <MediaEditModal
          imageSrc={editorSrc}
          originalFileName={editorFileName}
          caption={editCaption}
          saving={saving}
          dirty={imageReplaced}
          error={error}
          onCaptionChange={setEditCaption}
          onClose={closeEdit}
          onDelete={() => void deleteMedia()}
          onReplaceImage={handleReplaceImage}
          onSave={(file) => void saveEdit(file)}
        />
      )}
    </>
  );
}
