"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { ApmAdminTable } from "@/components/ApmAdminTable";
import { StatusLight } from "@/components/StatusLight";
import { apmFetch } from "@/lib/apm-client";

type SyncStatus = {
  enabled: boolean;
  intervalSec: number;
  mode: string;
  running: boolean;
  hasApiToken?: boolean;
  apiTokenHint?: string | null;
  apiBaseUrl?: string;
  lastError?: string | null;
  lastResult?: { imported: number; updated: number; skipped: number } | null;
};

export default function AdminProxiesPage() {
  const { data: session } = useSession();
  const token = session?.apmAccessToken;
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [apiToken, setApiToken] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [tableKey, setTableKey] = useState(0);

  const loadSync = useCallback(async () => {
    if (!token) return;
    try {
      const s = await apmFetch<SyncStatus>("/proxies/sync/status", token);
      setSync(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void loadSync();
  }, [loadSync]);

  const runSync = async () => {
    if (!token) {
      setErr("Chưa đăng nhập APM");
      return;
    }
    setSyncing(true);
    setErr("");
    setMsg("");
    try {
      const res = await apmFetch<{
        imported: number;
        updated: number;
        skipped: number;
      }>("/proxies/import/webshare", token, {
        method: "POST",
        body: JSON.stringify({
          apiToken: apiToken.trim() || undefined,
          mode: sync?.mode || "direct",
          onlyValid: true,
          maxProfiles: 10,
        }),
      });
      setMsg(
        `Sync xong: +${res.imported} mới, ${res.updated} cập nhật, ${res.skipped} bỏ qua`,
      );
      setTableKey((k) => k + 1);
      await loadSync();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="panel space-y-4 p-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--fg)]">
            Webshare API (đồng bộ proxy)
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Token cố định nằm trong file{" "}
            <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">
              automation-profile-manager/apps/api/.env
            </code>{" "}
            → biến <code className="text-xs">WEBSHARE_API_TOKEN</code>. Đổi xong chạy{" "}
            <code className="text-xs">pm2 restart binhluan --update-env</code>.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
            <div className="text-xs text-[var(--muted)]">API endpoint</div>
            <div className="mt-0.5 break-all font-mono text-sm">
              {sync?.apiBaseUrl || "https://proxy.webshare.io/api/v2/proxy/list/"}
            </div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              Đổi bằng <code>WEBSHARE_API_BASE</code> trong .env
            </div>
          </div>
          <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
            <div className="text-xs text-[var(--muted)]">Token (.env)</div>
            <div className="mt-0.5 font-mono text-sm">
              {sync?.hasApiToken
                ? `đã cấu hình ${sync.apiTokenHint || ""}`
                : "chưa có — thêm WEBSHARE_API_TOKEN"}
            </div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              Auto-sync: {sync?.enabled ? `bật · mỗi ${sync.intervalSec}s · ${sync.mode}` : "tắt"}
              {sync?.running ? " · đang chạy…" : ""}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="block min-w-0 flex-1 text-sm">
            <span className="text-[var(--muted)]">
              Token tạm (để trống = dùng token trong .env)
            </span>
            <input
              type="password"
              autoComplete="off"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="w001… hoặc dán token mới để sync thử"
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void runSync()}
            className="btn btn-primary shrink-0"
          >
            {syncing ? "Đang sync…" : "Sync Webshare ngay"}
          </button>
        </div>

        {msg && (
          <p className="text-sm text-[var(--success, #15803d)]">{msg}</p>
        )}
        {err && (
          <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {err}
          </p>
        )}
        {sync?.lastError && (
          <p className="text-xs text-[var(--muted)]">
            Lỗi sync gần nhất: {sync.lastError}
          </p>
        )}
      </section>

      <ApmAdminTable
        key={tableKey}
        title="Proxies"
        active="/admin/proxies"
        path="/proxies"
        columns={[
          {
            key: "host",
            label: "Host",
            render: (r) => `${r.host}:${r.port}`,
          },
          { key: "country", label: "Country" },
          {
            key: "health",
            label: "Health",
            render: (r) => <StatusLight value={r.health} kind="health" />,
          },
          {
            key: "status",
            label: "Status",
            render: (r) => <StatusLight value={r.status} kind="status" />,
          },
          {
            key: "available",
            label: "Queue",
            render: (r) => {
              if (r.locked) return "🔒 lock";
              if (r.cooling) return "⏳ cooldown";
              if (r.available) return "sẵn sàng";
              return "—";
            },
          },
          {
            key: "currentProfiles",
            label: "Profiles",
            render: (r) => `${r.currentProfiles ?? 0}/${r.maxProfiles ?? "—"}`,
          },
        ]}
      />
    </div>
  );
}
