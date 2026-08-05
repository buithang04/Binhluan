"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_STAR_SPIN_PROMPT_JSON,
  PROMPT_VARIABLE_GROUPS,
  validatePromptJsonText,
} from "@/lib/prompt-template";
import { STAR_SPIN_OUTPUT_SCHEMA } from "@/lib/deepseek-schema";

type Settings = {
  model: string;
  baseUrl: string;
  promptJson: string;
  outputSchema: typeof STAR_SPIN_OUTPUT_SCHEMA;
};

export default function AdminDeepSeekPage() {
  const [model, setModel] = useState("deepseek-v4-flash");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [promptJson, setPromptJson] = useState(DEFAULT_STAR_SPIN_PROMPT_JSON);
  const [schemaJson] = useState(() =>
    JSON.stringify(STAR_SPIN_OUTPUT_SCHEMA, null, 2),
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [promptError, setPromptError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  function fitPromptHeight() {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(320, el.scrollHeight + 4)}px`;
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/deepseek");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Không tải được cấu hình");
        return;
      }
      const s = data.settings as Settings;
      setModel(s.model);
      setBaseUrl(s.baseUrl);
      setPromptJson(s.promptJson);
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!loading) fitPromptHeight();
  }, [loading, promptJson]);

  useEffect(() => {
    if (!schemaOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSchemaOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [schemaOpen]);

  function onPromptChange(v: string) {
    setPromptJson(v);
    const check = validatePromptJsonText(v);
    setPromptError(check.ok ? "" : check.error || "JSON không hợp lệ");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const check = validatePromptJsonText(promptJson);
    if (!check.ok) {
      setPromptError(check.error || "JSON không hợp lệ");
      setError("Sửa Prompt JSON trước khi lưu");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/deepseek", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, baseUrl, promptJson }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lưu thất bại");
        return;
      }
      const s = data.settings as Settings;
      setPromptJson(s.promptJson);
      setModel(s.model);
      setMessage("Đã lưu cấu hình DeepSeek");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/deepseek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Reset thất bại");
        return;
      }
      const s = data.settings as Settings;
      setModel(s.model);
      setBaseUrl(s.baseUrl);
      setPromptJson(s.promptJson);
      setPromptError("");
      setMessage("Đã reset về mặc định");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  }

  function variableSource(path: string): "Tự sinh" | "Nhập tay" {
    if (
      path === "$json.settings.star_guide" ||
      path === "$json.settings.star_levels" ||
      path === "$json.settings.star_levels_count" ||
      path === "$json.settings.stars" ||
      path === "$json.settings.star_label" ||
      path === "$json.spin.resolved_text"
    ) {
      return "Tự sinh";
    }
    return "Nhập tay";
  }

  return (
    <div className="space-y-6">
      <h1 className="page-title">DeepSeek</h1>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Đang tải…</p>
      ) : (
        <form onSubmit={save} className="panel space-y-4 overflow-visible p-5">
          {error && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
              {error}
            </p>
          )}
          {message && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--signal-soft)] px-3 py-2 text-sm text-[#087f5b]">
              {message}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-[var(--ink-soft)]">Model</span>
              <input
                className="input font-mono text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="deepseek-v4-flash"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-[var(--ink-soft)]">Base URL</span>
              <input
                className="input font-mono text-sm"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-[var(--ink)]">
              Prompt JSON (messages + biến {"{{ $json... }}"})
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-secondary !py-1.5 text-xs"
                onClick={() => setSchemaOpen(true)}
              >
                Xem schema đầu ra
              </button>
              <button
                type="button"
                className="btn btn-secondary !py-1.5 text-xs"
                onClick={() => void resetDefaults()}
                disabled={saving}
              >
                Reset mặc định
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <textarea
              ref={promptRef}
              className="input w-full resize-y overflow-y-auto font-mono text-sm leading-relaxed"
              style={{ minHeight: 320 }}
              value={promptJson}
              onChange={(e) => onPromptChange(e.target.value)}
              onInput={fitPromptHeight}
              spellCheck={false}
            />
            {promptError && (
              <p className="text-xs text-[var(--danger)]">{promptError}</p>
            )}
          </div>

          <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3">
            <p className="text-sm font-medium text-[var(--ink)]">Khung dữ liệu đầu vào prompt</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Danh sách tất cả trường có thể gọi trong prompt JSON.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--line)] text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                    <th className="py-2 pr-3">Cách gọi</th>
                    <th className="py-2 pr-3">Tên cột (lúc nhập dữ liệu)</th>
                  </tr>
                </thead>
                <tbody>
                  {PROMPT_VARIABLE_GROUPS.map((group) => (
                    group.items.map((item, idx) => (
                      <tr key={`${group.label}-${item.path}`} className="border-b border-[var(--line)]/60 align-top">
                        <td className="py-2 pr-3 font-mono text-xs text-[var(--ink-soft)]">
                          <span className="font-sans">{`{{ ${item.path} }}`}</span>
                        </td>
                        <td className="py-2 pr-3 text-xs text-[var(--ink-soft)]">
                          {item.label}
                          {idx === 0 ? ` (${group.label})` : ""}
                          <span className="ml-2 text-[11px] text-[var(--muted)]">
                            · {variableSource(item.path)}
                          </span>
                        </td>
                      </tr>
                    ))
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Đang lưu…" : "Lưu cấu hình"}
            </button>
          </div>
        </form>
      )}

      {schemaOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden overscroll-none bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Schema đầu ra"
          onClick={() => setSchemaOpen(false)}
          onWheel={(e) => {
            // Backdrop / ngoài khung modal: không cuộn trang phía sau
            if (e.target === e.currentTarget) e.preventDefault();
          }}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-md)]"
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
              <p className="text-sm font-medium text-[var(--ink)]">
                Schema đầu ra (tham chiếu)
              </p>
              <button
                type="button"
                className="btn btn-secondary !py-1.5 text-xs"
                onClick={() => setSchemaOpen(false)}
              >
                Đóng
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 font-mono text-sm leading-relaxed text-[var(--ink-soft)]">
              {schemaJson}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
