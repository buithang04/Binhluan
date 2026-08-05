"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusLight } from "@/components/StatusLight";
import { apmFetch } from "@/lib/apm-client";

type ProxyRow = {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username?: string | null;
  password?: string | null;
  country?: string | null;
  city?: string | null;
  note?: string | null;
  status: string;
  health: string;
  maxProfiles?: number;
  currentProfiles?: number;
  available?: boolean;
  locked?: boolean;
  cooling?: boolean;
  lockedUntil?: string | null;
  cooldownUntil?: string | null;
  lastCheckedAt?: string | null;
};

type ImportConfig = {
  name: string;
  curl: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  listPath: string;
  hostPath: string;
  portPath: string;
  usernamePath: string;
  passwordPath: string;
  protocolPath: string;
  countryPath: string;
  cityPath: string;
  idPath: string;
  filterPath: string;
  filterEquals: string;
  notePrefix: string;
  pageParam: string;
  limitParam: string;
  hasNextPath: string;
  disableOthers: boolean;
  onlyValidPath: string;
  onlyValidEquals: string;
};

type ImportConfigRes = {
  config: ImportConfig;
  headersMasked: Record<string, string>;
  presets: { id: string; name: string }[];
};

type TestResult = {
  ok: boolean;
  host: string;
  directIp?: string | null;
  exitIp?: string | null;
  mapsOk?: boolean | null;
  ms?: number;
  error?: string | null;
  message?: string;
};

const emptyForm = {
  host: "",
  port: "8080",
  protocol: "http",
  username: "",
  password: "",
  country: "VN",
  city: "",
  note: "",
  maxProfiles: "10",
  status: "ACTIVE",
  health: "UNKNOWN",
};

const inputCls =
  "mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm";
const monoCls = `${inputCls} font-mono text-xs`;

function authTokenFromHeader(h?: string): string {
  if (!h) return "";
  return h.replace(/^(Bearer|Token)\s+/i, "").trim();
}

function authSchemeFromHeader(h?: string): "Bearer" | "Token" {
  if (h && /^Token\s+/i.test(h)) return "Token";
  return "Bearer";
}

/** Tooltip giờ VN + còn lại (phút). */
function formatUntilTooltip(
  until: string | null | undefined,
  kind: "cooldown" | "lock",
): string | undefined {
  if (!until) return undefined;
  const end = new Date(until);
  if (Number.isNaN(end.getTime())) return undefined;
  const msLeft = end.getTime() - Date.now();
  if (msLeft <= 0) return undefined;
  const mins = Math.max(1, Math.ceil(msLeft / 60_000));
  const when = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(end);
  return kind === "cooldown"
    ? `Cooldown đến ${when} (còn ~${mins} phút)`
    : `Lock đến ${when} (còn ~${mins} phút)`;
}

export default function AdminProxiesPage() {
  const { data: session } = useSession();
  const token = session?.apmAccessToken;

  const [rows, setRows] = useState<ProxyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [cooldownMinutes, setCooldownMinutes] = useState("60");
  const [cooldownSaving, setCooldownSaving] = useState(false);

  const [importCfg, setImportCfg] = useState<ImportConfigRes | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [authScheme, setAuthScheme] = useState<"Bearer" | "Token">("Bearer");
  const [authToken, setAuthToken] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [pasteCurl, setPasteCurl] = useState("");
  const [showCurlPaste, setShowCurlPaste] = useState(false);
  const [showCurlPreview, setShowCurlPreview] = useState(false);
  const [showAdvancedMap, setShowAdvancedMap] = useState(false);
  const [mapFields, setMapFields] = useState({
    listPath: "data",
    hostPath: "proxy.ipaddress.domain|proxy.ipaddress.ip",
    portPath: "proxy.port",
    usernamePath: "proxy.username",
    passwordPath: "proxy.password",
    protocolPath: "protocol|proxy.protocol",
    cityPath: "proxy.ipaddress.location",
    idPath: "code",
    filterPath: "proxy.ipaddress.categorytype.slug",
    filterEquals: "static",
    notePrefix: "homeproxy",
    disableOthers: true,
  });
  const [cfgSaving, setCfgSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testLog, setTestLog] = useState<TestResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const flash = (okMsg: string, error?: string) => {
    setMsg(okMsg);
    setErr(error || "");
  };

  const applyConfigToForm = useCallback((res: ImportConfigRes) => {
    setImportCfg(res);
    const c = res.config;
    setApiUrl(c.url || "");
    const rawAuth = c.headers?.Authorization || c.headers?.authorization || "";
    setAuthScheme(authSchemeFromHeader(rawAuth));
    setAuthToken(authTokenFromHeader(rawAuth));
    setMerchantId(c.headers?.["x-merchant-id"] || "");
    setMapFields({
      listPath: c.listPath || "",
      hostPath: c.hostPath || "",
      portPath: c.portPath || "",
      usernamePath: c.usernamePath || "",
      passwordPath: c.passwordPath || "",
      protocolPath: c.protocolPath || "",
      cityPath: c.cityPath || "",
      idPath: c.idPath || "",
      filterPath: c.filterPath || "",
      filterEquals: c.filterEquals || "",
      notePrefix: c.notePrefix || "import",
      disableOthers: Boolean(c.disableOthers),
    });
  }, []);

  const loadRows = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await apmFetch<ProxyRow[]>("/proxies", token);
      const list = Array.isArray(data) ? data : [];
      setRows(list);
      setSelectedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          if (list.some((r) => r.id === id)) next.add(id);
        }
        return next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadCooldown = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apmFetch<{ cooldownMinutes: number }>(
        "/proxies/settings/maps-cooldown",
        token,
      );
      setCooldownMinutes(String(res.cooldownMinutes ?? 60));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  const loadImportConfig = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apmFetch<ImportConfigRes>("/proxies/import/config", token);
      applyConfigToForm(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [token, applyConfigToForm]);

  useEffect(() => {
    void loadRows();
    void loadCooldown();
    void loadImportConfig();
  }, [loadRows, loadCooldown, loadImportConfig]);

  const liveCurlPreview = useMemo(() => {
    const lines = [`curl -X GET "${apiUrl || "https://…"}"`];
    if (authToken.trim()) {
      lines.push(`  -H "Authorization: ${authScheme} ${authToken.trim()}"`);
    }
    if (merchantId.trim()) {
      lines.push(`  -H "x-merchant-id: ${merchantId.trim()}"`);
    }
    lines.push(`  -H "Accept: application/json"`);
    return lines.join("\n");
  }, [apiUrl, authScheme, authToken, merchantId]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => r.status === "ACTIVE").length;
    const working = rows.filter((r) => r.health === "WORKING").length;
    const ready = rows.filter((r) => r.available).length;
    return { total: rows.length, active, working, ready };
  }, [rows]);

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.id)));
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveCooldown = async () => {
    if (!token) return;
    const n = Number(cooldownMinutes);
    if (!Number.isFinite(n) || n < 0 || n > 10080) {
      flash("", "Cooldown phải từ 0 đến 10080 phút");
      return;
    }
    setCooldownSaving(true);
    try {
      const res = await apmFetch<{ cooldownMinutes: number }>(
        "/proxies/settings/maps-cooldown",
        token,
        {
          method: "PUT",
          body: JSON.stringify({ cooldownMinutes: Math.floor(n) }),
        },
      );
      setCooldownMinutes(String(res.cooldownMinutes));
      flash(`Đã lưu cooldown ${res.cooldownMinutes} phút`);
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setCooldownSaving(false);
    }
  };

  const saveImportConfig = async (extra?: { curl?: string }) => {
    if (!token) return null;
    setCfgSaving(true);
    setErr("");
    try {
      const res = await apmFetch<ImportConfigRes>("/proxies/import/config", token, {
        method: "PUT",
        body: JSON.stringify({
          url: apiUrl.trim(),
          authorization: authToken.trim()
            ? `${authScheme} ${authToken.trim()}`
            : undefined,
          merchantId,
          curl: extra?.curl,
          config: {
            ...mapFields,
            name: importCfg?.config.name || "Custom",
          },
        }),
      });
      applyConfigToForm(res);
      return res;
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setCfgSaving(false);
    }
  };

  const applyPreset = async (preset: "homeproxy" | "webshare") => {
    if (!token) return;
    setCfgSaving(true);
    try {
      const res = await apmFetch<ImportConfigRes>("/proxies/import/config", token, {
        method: "PUT",
        body: JSON.stringify({ preset }),
      });
      applyConfigToForm(res);
      setPasteCurl("");
      flash(`Đã nạp preset ${res.config.name} (token lấy từ .env nếu có)`);
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setCfgSaving(false);
    }
  };

  const applyPastedCurl = async () => {
    if (!pasteCurl.trim()) {
      flash("", "Dán cURL trước");
      return;
    }
    const res = await saveImportConfig({ curl: pasteCurl });
    if (res) {
      setShowCurlPaste(false);
      flash("Đã parse cURL → URL / token / headers");
    }
  };

  const runImport = async () => {
    if (!token) return;
    setSyncing(true);
    setErr("");
    try {
      const saved = await saveImportConfig(
        pasteCurl.trim() ? { curl: pasteCurl } : undefined,
      );
      if (!saved) return;
      const res = await apmFetch<{
        imported: number;
        updated: number;
        skipped: number;
        disabled?: number;
      }>("/proxies/import/config/run", token, {
        method: "POST",
        body: JSON.stringify({ disableOthers: mapFields.disableOthers }),
      });
      flash(
        `Sync xong: +${res.imported} mới · ${res.updated} cập nhật · bỏ qua ${res.skipped}` +
          (res.disabled ? ` · tắt ${res.disabled} proxy khác` : ""),
      );
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (row: ProxyRow) => {
    setEditingId(row.id);
    setForm({
      host: row.host,
      port: String(row.port),
      protocol: row.protocol || "http",
      username: row.username || "",
      password: row.password || "",
      country: row.country || "",
      city: row.city || "",
      note: row.note || "",
      maxProfiles: String(row.maxProfiles ?? 10),
      status: row.status || "ACTIVE",
      health: row.health || "UNKNOWN",
    });
    setShowForm(true);
  };

  const saveProxy = async () => {
    if (!token) return;
    const port = Number(form.port);
    if (!form.host.trim() || !Number.isFinite(port)) {
      flash("", "Thiếu host/port hợp lệ");
      return;
    }
    setFormBusy(true);
    try {
      const body = {
        host: form.host.trim(),
        port,
        protocol: form.protocol as "http" | "https" | "socks5",
        username: form.username || null,
        password: form.password || null,
        country: form.country || null,
        city: form.city || null,
        note: form.note || null,
        maxProfiles: Math.max(1, Number(form.maxProfiles) || 10),
        status: form.status as "ACTIVE" | "DISABLED",
        health: form.health as "WORKING" | "FAILED" | "UNKNOWN",
      };
      if (editingId) {
        await apmFetch(`/proxies/${editingId}`, token, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        flash(`Đã cập nhật ${body.host}:${body.port}`);
      } else {
        await apmFetch("/proxies", token, {
          method: "POST",
          body: JSON.stringify(body),
        });
        flash(`Đã thêm ${body.host}:${body.port}`);
      }
      setShowForm(false);
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setFormBusy(false);
    }
  };

  const deleteProxy = async (row: ProxyRow) => {
    if (!token) return;
    if (!window.confirm(`Xóa proxy ${row.host}:${row.port}?`)) return;
    try {
      await apmFetch(`/proxies/${row.id}`, token, { method: "DELETE" });
      flash(`Đã xóa ${row.host}:${row.port}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    }
  };

  const bulkTest = async () => {
    if (!token || selectedIds.size === 0) return;
    setBulkBusy(true);
    setTestingAll(true);
    try {
      const ids = [...selectedIds];
      const res = await apmFetch<{
        ok: number;
        fail: number;
        total: number;
        results: TestResult[];
      }>("/proxies/test-many", token, {
        method: "POST",
        body: JSON.stringify({ ids, deep: true }),
      });
      setTestLog(res.results || []);
      flash(`Test ${ids.length} proxy đã chọn: ${res.ok} OK · ${res.fail} lỗi`);
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
      setTestingAll(false);
    }
  };

  const bulkDelete = async () => {
    if (!token || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    if (!window.confirm(`Xóa ${ids.length} proxy đã chọn?`)) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      for (const id of ids) {
        try {
          await apmFetch(`/proxies/${id}`, token, { method: "DELETE" });
          ok += 1;
        } catch {
          /* continue */
        }
      }
      setSelectedIds(new Set());
      flash(`Đã xóa ${ok}/${ids.length} proxy`);
      await loadRows();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkSetStatus = async (status: "ACTIVE" | "DISABLED") => {
    if (!token || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      for (const id of selectedIds) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        try {
          await apmFetch(`/proxies/${id}`, token, {
            method: "PUT",
            body: JSON.stringify({
              host: row.host,
              port: row.port,
              protocol: row.protocol || "http",
              status,
            }),
          });
          ok += 1;
        } catch {
          /* continue */
        }
      }
      flash(status === "ACTIVE" ? `Đã bật ${ok} proxy` : `Đã tắt ${ok} proxy`);
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const testOne = async (row: ProxyRow) => {
    if (!token) return;
    setTestingId(row.id);
    try {
      const res = await apmFetch<TestResult>(`/proxies/${row.id}/test`, token, {
        method: "POST",
        body: JSON.stringify({ deep: true }),
      });
      setTestLog((prev) => [res, ...prev].slice(0, 20));
      flash(res.message || (res.ok ? "Test OK" : "Test FAIL"));
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setTestingId(null);
    }
  };

  const testAll = async () => {
    if (!token) return;
    setTestingAll(true);
    try {
      const ids = rows.filter((r) => r.status === "ACTIVE").map((r) => r.id);
      const res = await apmFetch<{
        ok: number;
        fail: number;
        total: number;
        results: TestResult[];
      }>("/proxies/test-many", token, {
        method: "POST",
        body: JSON.stringify({ ids, deep: true }),
      });
      setTestLog(res.results || []);
      flash(`Test xong: ${res.ok}/${res.total} OK · ${res.fail} lỗi`);
      await loadRows();
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setTestingAll(false);
    }
  };

  const testFormProxy = async () => {
    if (!token) return;
    setFormBusy(true);
    try {
      const res = await apmFetch<TestResult>("/proxies/test", token, {
        method: "POST",
        body: JSON.stringify({
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username || null,
          password: form.password || null,
          protocol: form.protocol,
          deep: true,
        }),
      });
      setTestLog((prev) => [res, ...prev].slice(0, 20));
      flash(res.message || (res.ok ? "Test OK" : "Test FAIL"));
    } catch (e) {
      flash("", e instanceof Error ? e.message : String(e));
    } finally {
      setFormBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Proxies</h1>
          <p className="page-desc">
            Import từ API (cURL) · test giống gate đăng bài · sửa / xóa từng proxy.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-[var(--muted)]">
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1">
            Tổng {stats.total}
          </span>
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1">
            ACTIVE {stats.active}
          </span>
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1">
            WORKING {stats.working}
          </span>
          <span className="rounded-full border border-[var(--border)] px-2.5 py-1">
            Sẵn sàng {stats.ready}
          </span>
        </div>
      </div>

      {(msg || err) && (
        <div className="space-y-2">
          {msg && (
            <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--success,#15803d)]">
              {msg}
            </p>
          )}
          {err && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
              {err}
            </p>
          )}
        </div>
      )}

      {/* Cooldown */}
      <section className="panel space-y-3 p-4">
        <div>
          <h2 className="text-base font-semibold">Cooldown proxy sau bình luận Maps</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Mỗi lần đăng thành công, proxy bị khóa cooldown trước khi dùng lại (toàn hệ thống).
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label
            className="block text-sm"
            title="Thời gian khóa proxy sau mỗi lần đăng Maps thành công. Di chuột vào cột Queue trong bảng để xem từng proxy còn cooldown đến khi nào."
          >
            <span className="text-[var(--muted)]">Số phút</span>
            <input
              type="number"
              min={0}
              max={10080}
              value={cooldownMinutes}
              onChange={(e) => setCooldownMinutes(e.target.value)}
              className={`${inputCls} w-36 font-mono`}
              title={`Cooldown hiện tại: ${cooldownMinutes} phút — sau khi đăng Maps xong, proxy bị khóa trong khoảng thời gian này`}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={cooldownSaving}
            onClick={() => void saveCooldown()}
          >
            {cooldownSaving ? "Đang lưu…" : "Lưu cooldown"}
          </button>
        </div>
      </section>

      {/* Import config */}
      <section className="panel space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Nguồn import API</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Điền URL + token, hoặc dán cURL từ docs nhà cung cấp. Preset HomeProxy / Webshare
              tự lấy token từ <code className="text-xs">.env</code> nếu còn placeholder.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(importCfg?.presets || []).map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn btn-soft"
                disabled={cfgSaving}
                onClick={() => void applyPreset(p.id as "homeproxy" | "webshare")}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <label className="block text-sm lg:col-span-2">
            <span className="text-[var(--muted)]">API URL (list proxy)</span>
            <input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              className={monoCls}
              placeholder="https://api.homeproxy.vn/api/v1/users/proxies?page=1&limit=100"
            />
          </label>

          <label className="block text-sm">
            <span className="text-[var(--muted)]">Authorization</span>
            <div className="mt-1 flex gap-2">
              <select
                value={authScheme}
                onChange={(e) =>
                  setAuthScheme(e.target.value as "Bearer" | "Token")
                }
                className="w-28 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
              >
                <option value="Bearer">Bearer</option>
                <option value="Token">Token</option>
              </select>
              <input
                type="password"
                autoComplete="off"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                className={`${monoCls} !mt-0 flex-1`}
                placeholder="API token (để trống = giữ token đã lưu)"
              />
            </div>
            {importCfg?.headersMasked?.Authorization && (
              <p className="mt-1 font-mono text-xs text-[var(--muted)]">
                Đang lưu: {importCfg.headersMasked.Authorization}
              </p>
            )}
          </label>

          <label className="block text-sm">
            <span className="text-[var(--muted)]">x-merchant-id (HomeProxy)</span>
            <input
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              className={monoCls}
              placeholder="uuid merchant — để trống nếu không cần"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => setShowCurlPaste((v) => !v)}
          >
            {showCurlPaste ? "Ẩn dán cURL" : "Dán cURL…"}
          </button>
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => setShowCurlPreview((v) => !v)}
          >
            {showCurlPreview ? "Ẩn preview" : "Xem cURL sẽ gọi"}
          </button>
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => setShowAdvancedMap((v) => !v)}
          >
            {showAdvancedMap ? "Ẩn mapping" : "Mapping JSON path"}
          </button>
        </div>

        {showCurlPaste && (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="text-xs text-[var(--muted)]">
              Dán nguyên lệnh curl từ tài liệu API → Áp dụng để điền URL/headers.
            </p>
            <textarea
              value={pasteCurl}
              onChange={(e) => setPasteCurl(e.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs leading-relaxed"
              placeholder={'curl -X GET "https://…" -H "Authorization: Bearer …"'}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={cfgSaving}
              onClick={() => void applyPastedCurl()}
            >
              Áp dụng cURL
            </button>
          </div>
        )}

        {showCurlPreview && (
          <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs leading-relaxed text-[var(--fg)]">
            {liveCurlPreview}
          </pre>
        )}

        {showAdvancedMap && (
          <div className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] p-3 sm:grid-cols-2">
            {(
              [
                ["listPath", "List path"],
                ["hostPath", "Host path"],
                ["portPath", "Port path"],
                ["usernamePath", "Username path"],
                ["passwordPath", "Password path"],
                ["protocolPath", "Protocol path"],
                ["cityPath", "City path"],
                ["idPath", "Id path"],
                ["filterPath", "Filter path"],
                ["filterEquals", "Filter equals"],
                ["notePrefix", "Note prefix"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block text-sm">
                <span className="text-[var(--muted)]">{label}</span>
                <input
                  value={mapFields[key]}
                  onChange={(e) =>
                    setMapFields((f) => ({ ...f, [key]: e.target.value }))
                  }
                  className={monoCls}
                />
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={mapFields.disableOthers}
                onChange={(e) =>
                  setMapFields((f) => ({ ...f, disableOthers: e.target.checked }))
                }
              />
              Sync xong → DISABLED proxy không thuộc note prefix này
            </label>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={cfgSaving}
            onClick={async () => {
              const res = await saveImportConfig();
              if (res) flash("Đã lưu cấu hình import");
            }}
          >
            {cfgSaving ? "Đang lưu…" : "Lưu cấu hình"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={syncing || cfgSaving}
            onClick={() => void runImport()}
          >
            {syncing ? "Đang sync…" : "Sync proxy ngay"}
          </button>
        </div>
      </section>

      {/* CRUD form */}
      {showForm && (
        <section className="panel space-y-4 p-4">
          <h2 className="text-base font-semibold">
            {editingId ? "Sửa proxy" : "Thêm proxy thủ công"}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ["host", "Host"],
                ["port", "Port"],
                ["username", "Username"],
                ["password", "Password"],
                ["country", "Country"],
                ["city", "City"],
                ["note", "Note"],
                ["maxProfiles", "Max profiles"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block text-sm">
                <span className="text-[var(--muted)]">{label}</span>
                <input
                  type={key === "password" ? "password" : "text"}
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  className={monoCls}
                />
              </label>
            ))}
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Protocol</span>
              <select
                value={form.protocol}
                onChange={(e) => setForm((f) => ({ ...f, protocol: e.target.value }))}
                className={inputCls}
              >
                <option value="http">http</option>
                <option value="https">https</option>
                <option value="socks5">socks5</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Status</span>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                className={inputCls}
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="DISABLED">DISABLED</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">Health</span>
              <select
                value={form.health}
                onChange={(e) => setForm((f) => ({ ...f, health: e.target.value }))}
                className={inputCls}
              >
                <option value="WORKING">WORKING</option>
                <option value="FAILED">FAILED</option>
                <option value="UNKNOWN">UNKNOWN</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={formBusy}
              onClick={() => void saveProxy()}
            >
              {formBusy ? "Đang lưu…" : editingId ? "Cập nhật" : "Thêm mới"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={formBusy}
              onClick={() => void testFormProxy()}
            >
              Test kết nối
            </button>
            <button type="button" className="btn btn-soft" onClick={() => setShowForm(false)}>
              Đóng
            </button>
          </div>
        </section>
      )}

      {/* Table */}
      <section className="panel space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Danh sách proxy</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-soft" onClick={() => void loadRows()}>
              Refresh
            </button>
            <button type="button" className="btn btn-secondary" onClick={openCreate}>
              + Thêm proxy
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={testingAll || bulkBusy || !stats.active}
              onClick={() => void testAll()}
            >
              {testingAll && !bulkBusy ? "Đang test…" : "Test tất cả ACTIVE"}
            </button>
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
            <span className="text-sm text-[var(--muted)]">
              Đã chọn <strong className="text-[var(--fg)]">{selectedIds.size}</strong>
            </span>
            <button
              type="button"
              className="btn btn-soft !px-2.5 !py-1 text-xs"
              disabled={bulkBusy || testingAll}
              onClick={() => void bulkTest()}
            >
              Test đã chọn
            </button>
            <button
              type="button"
              className="btn btn-soft !px-2.5 !py-1 text-xs"
              disabled={bulkBusy}
              onClick={() => void bulkSetStatus("ACTIVE")}
            >
              Bật ACTIVE
            </button>
            <button
              type="button"
              className="btn btn-soft !px-2.5 !py-1 text-xs"
              disabled={bulkBusy}
              onClick={() => void bulkSetStatus("DISABLED")}
            >
              Tắt DISABLED
            </button>
            <button
              type="button"
              className="btn btn-soft !px-2.5 !py-1 text-xs text-[var(--danger)]"
              disabled={bulkBusy}
              onClick={() => void bulkDelete()}
            >
              Xóa đã chọn
            </button>
            <button
              type="button"
              className="btn btn-soft !px-2.5 !py-1 text-xs"
              disabled={bulkBusy}
              onClick={() => setSelectedIds(new Set())}
            >
              Bỏ chọn
            </button>
          </div>
        )}

        {loading ? (
          <p className="py-8 text-center text-sm text-[var(--muted)]">Đang tải…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleSelectAll}
                      aria-label="Chọn tất cả"
                    />
                  </th>
                  <th>Host</th>
                  <th>User</th>
                  <th>Meta</th>
                  <th>Health</th>
                  <th>Status</th>
                  <th>Queue</th>
                  <th className="whitespace-nowrap text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={selectedIds.has(r.id) ? "bg-[var(--surface-2)]" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                        aria-label={`Chọn ${r.host}:${r.port}`}
                      />
                    </td>
                    <td className="font-mono text-xs">
                      <div>
                        {r.host}:{r.port}
                      </div>
                      <div className="text-[var(--muted)]">{r.protocol}</div>
                    </td>
                    <td className="font-mono text-xs">
                      <div>{r.username || "—"}</div>
                      <div className="text-[var(--muted)]">
                        {r.password ? "pass ····" : "no pass"}
                      </div>
                    </td>
                    <td className="text-xs">
                      <div>{[r.country, r.city].filter(Boolean).join(" · ") || "—"}</div>
                      <div
                        className="max-w-[10rem] truncate text-[var(--muted)]"
                        title={r.note || ""}
                      >
                        {r.note || "—"}
                      </div>
                    </td>
                    <td>
                      <StatusLight value={r.health} kind="health" />
                    </td>
                    <td>
                      <StatusLight value={r.status} kind="status" />
                    </td>
                    <td
                      className="cursor-help text-xs whitespace-nowrap"
                      title={
                        r.locked
                          ? formatUntilTooltip(r.lockedUntil, "lock")
                          : r.cooling
                            ? formatUntilTooltip(r.cooldownUntil, "cooldown")
                            : r.available
                              ? "Proxy sẵn sàng dùng"
                              : undefined
                      }
                    >
                      {r.locked
                        ? "🔒 lock"
                        : r.cooling
                          ? "⏳ cooldown"
                          : r.available
                            ? "sẵn sàng"
                            : "—"}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
                        <button
                          type="button"
                          className="btn btn-soft shrink-0 !px-2 !py-1 text-xs"
                          disabled={testingId === r.id || testingAll || bulkBusy}
                          onClick={() => void testOne(r)}
                        >
                          {testingId === r.id ? "…" : "Test"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-soft shrink-0 !px-2 !py-1 text-xs"
                          onClick={() => openEdit(r)}
                        >
                          Sửa
                        </button>
                        <button
                          type="button"
                          className="btn btn-soft shrink-0 !px-2 !py-1 text-xs text-[var(--danger)]"
                          onClick={() => void deleteProxy(r)}
                        >
                          Xóa
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={8} className="!py-10 text-center text-[var(--muted)]">
                      Chưa có proxy — bấm Sync hoặc Thêm thủ công
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {testLog.length > 0 && (
        <section className="panel space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Kết quả test</h2>
            <button type="button" className="btn btn-soft text-xs" onClick={() => setTestLog([])}>
              Xóa log
            </button>
          </div>
          <ul className="space-y-2 text-sm">
            {testLog.map((t, i) => (
              <li
                key={`${t.host}-${i}`}
                className={
                  t.ok ? "text-[var(--success,#15803d)]" : "text-[var(--danger)]"
                }
              >
                <span className="font-mono">{t.host}</span>
                {" — "}
                {t.message || (t.ok ? "OK" : t.error)}
                {t.exitIp ? ` · exit ${t.exitIp}` : ""}
                {t.ms != null ? ` · ${t.ms}ms` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
