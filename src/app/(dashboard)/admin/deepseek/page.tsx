"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_STAR_SPIN_PROMPT_JSON,
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
      setMessage("Đã lưu — schema đầu ra đã được ép vào response_format");
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
      setMessage("Đã reset về mặc định (model + prompt + schema)");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">DeepSeek</h1>
        <p className="page-desc">
          Cấu hình model + Prompt JSON dùng khi sinh template spin theo sao (1
          lần call → nhiều mức). Schema đầu ra luôn được ép khi gọi API.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Đang tải…</p>
      ) : (
        <form onSubmit={save} className="panel space-y-4 p-5">
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

          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-[var(--ink)]">
                Prompt JSON (messages + biến {"{{ $json... }}"})
              </p>
              <button
                type="button"
                className="btn btn-secondary !py-1.5 text-xs"
                onClick={() => void resetDefaults()}
                disabled={saving}
              >
                Reset mặc định
              </button>
            </div>
            <textarea
              className="input min-h-[280px] font-mono text-xs leading-relaxed"
              value={promptJson}
              onChange={(e) => onPromptChange(e.target.value)}
              spellCheck={false}
            />
            {promptError && (
              <p className="text-xs text-[var(--danger)]">{promptError}</p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium text-[var(--ink)]">
              Schema đầu ra 
            </p>
            <p className="text-xs text-[var(--muted)]">
              Mỗi lần lưu / gọi API, hệ thống gắn{" "}
              <code className="font-mono">response_format.json_schema</code> theo
              cấu trúc này. Model phải trả{" "}
              <code className="font-mono">
                {"{ templates: [{ stars, template }] }"}
              </code>
              .
            </p>
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-muted)] p-3 font-mono text-[11px] text-[var(--ink-soft)]">
              {schemaJson}
            </pre>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Đang lưu…" : "Lưu cấu hình"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
