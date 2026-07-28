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
      <section className="panel space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-[var(--ink)]">
              Thư viện ảnh ({media.length})
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              JPG / PNG / WebP · tối đa 5MB/ảnh · {media.length}/{MAX_PROJECT_MEDIA}
            </p>
          </div>
          <div>
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
              className="btn btn-primary"
              disabled={uploading || media.length >= MAX_PROJECT_MEDIA}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Đang tải…" : "+ Thêm ảnh"}
            </button>
          </div>
        </div>

        {error && !editing && (
          <p className="text-sm text-[var(--danger)]">{error}</p>
        )}

        {media.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex min-h-[7rem] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-[var(--line)] bg-[var(--surface-muted)] px-4 py-6 text-center transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-sm font-medium text-[var(--ink)]">
              Chưa có ảnh — bấm để thêm
            </span>
            <span className="text-xs text-[var(--muted)]">
              Hoặc kéo thả ảnh vào lưới bên dưới
            </span>
          </button>
        ) : (
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5"
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
                className="group relative aspect-square overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)] text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-md"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={m.filePath}
                  alt={m.caption || ""}
                  className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent opacity-80 transition group-hover:opacity-100" />
                <div className="absolute inset-x-0 bottom-0 p-2.5">
                  <span className="block truncate text-xs font-medium text-white">
                    {m.caption || "Ảnh dự án"}
                  </span>
                  <span className="mt-0.5 block text-xs text-white/65">
                    Chỉnh sửa
                  </span>
                </div>
              </button>
            ))}
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
