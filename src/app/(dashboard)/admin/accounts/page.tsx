"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusLight, formatAliveLabel, formatLoginStatus } from "@/components/StatusLight";
import { AdminLiveBrowserSync } from "@/components/AdminLiveBrowserSync";
import { apmFetch } from "@/lib/apm-client";
import {
  downloadAccountsTemplate,
  parseAccountsSpreadsheet,
  type ImportAccountRow,
} from "@/lib/import-accounts";

type Profile = {
  id: string;
  status?: string;
  browserIndex?: number;
  browserAlive?: boolean;
  proxy?: { id?: string; host?: string; port?: number; country?: string | null } | null;
};

type Account = {
  id: string;
  email: string;
  status: string;
  loginIssue?: string | null;
  recoveryEmail?: string | null;
  password?: string;
  totpSecret?: string;
  hasPassword?: boolean;
  hasTotp?: boolean;
  profile?: Profile | null;
};

type OpenResult = {
  action?: "focus" | "login" | "pending";
  browserIndex?: number;
  jobRunId?: string;
};

type ImportResult = {
  ok?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  errorCount?: number;
  message?: string;
  createdIds?: Array<{ id: string; email: string }>;
  errors?: Array<{ row: number; email?: string; error: string }>;
};

/** Lỗi cứng — sang acc tiếp. RECAPTCHA/CHALLENGE = chờ giải tay, không bỏ qua. */
function isPermanentLoginIssue(issue?: string | null): boolean {
  const v = (issue || "").toUpperCase();
  return (
    v === "EMAIL_NOT_FOUND" ||
    v === "WRONG_PASSWORD" ||
    v === "BROWSER_BLOCKED"
  );
}

function isWaitingManualSolve(issue?: string | null): boolean {
  const v = (issue || "").toUpperCase();
  return v === "RECAPTCHA" || v === "CHALLENGE";
}

function needsLiveStatus(list: Account[]): boolean {
  return list.some(
    (a) =>
      a.loginIssue ||
      a.profile?.browserAlive ||
      a.profile?.status === "QUEUED" ||
      a.profile?.status === "RUNNING",
  );
}

function accountsSnapshot(list: Account[]): string {
  return list
    .map(
      (a) =>
        [
          a.id,
          a.email,
          a.status,
          a.loginIssue ?? "",
          a.hasPassword ? "1" : "0",
          a.hasTotp || a.totpSecret ? "1" : "0",
          a.profile?.id ?? "",
          a.profile?.status ?? "",
          a.profile?.browserIndex ?? "",
          a.profile?.browserAlive ? "1" : "0",
        ].join("|"),
    )
    .join(";");
}

function accountIsReady(account: Account): boolean {
  return account.status === "READY" || account.profile?.status === "READY";
}

/** Nhãn trạng thái — ưu tiên profile QUEUED/RUNNING khi đang mở Chrome. */
function accountStatusLabel(account: Account): string {
  if (accountIsReady(account)) return "Sẵn sàng";
  const ps = (account.profile?.status || "").toUpperCase();
  if (ps === "RUNNING") return "Đang chạy";
  if (ps === "QUEUED") return "Trong hàng đợi";
  return formatLoginStatus(account.status || "UNREADY", account.loginIssue);
}

/** Browser đang mở hoặc worker đang xử lý LOGIN. */
function profileBrowserActive(account: Account): boolean {
  if (!account.profile) return false;
  if (account.profile.browserAlive) return true;
  const ps = (account.profile.status || "").toUpperCase();
  return ps === "QUEUED" || ps === "RUNNING";
}

function optimisticOpeningPatch(account: Account): Account {
  if (!account.profile) return account;
  return {
    ...account,
    loginIssue: null,
    profile: {
      ...account.profile,
      status: "QUEUED",
      browserAlive: true,
    },
  };
}

const emptyForm = {
  email: "",
  password: "",
  totpSecret: "",
  status: "UNREADY",
  autoAssign: true,
};

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export default function AdminAccountsPage() {
  const { data: session, status: sessionStatus } = useSession();
  const token = session?.apmAccessToken;
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"add" | "edit" | "import" | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [importRows, setImportRows] = useState<ImportAccountRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [importAutoAssign, setImportAutoAssign] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(20);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = rows.length === 0 ? 0 : (safePage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, rows.length);
  const pageRows = rows.slice(pageStart, pageEnd);
  const pageIds = pageRows.map((r) => r.id);
  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id));
  const allPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const somePageSelected = selectedOnPage.length > 0 && !allPageSelected;
  const selectedCount = selectedIds.size;
  const selectedAccounts = rows.filter((r) => selectedIds.has(r.id));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    const alive = new Set(rows.map((r) => r.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (sessionStatus === "loading") return;
    if (!token) {
      setError("Chưa có token APM — đăng xuất rồi đăng nhập lại bằng admin@apm.local");
      setLoading(false);
      return;
    }
    if (!opts?.silent) setError("");
    try {
      const data = await apmFetch<Account[]>("/accounts", token);
      const next = Array.isArray(data) ? data : [];
      setRows((prev) =>
        accountsSnapshot(prev) === accountsSnapshot(next) ? prev : next,
      );
    } catch (e) {
      if (!opts?.silent) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [token, sessionStatus]);

  useEffect(() => {
    void load();

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setRows((current) => {
        if (needsLiveStatus(current)) void load({ silent: true });
        return current;
      });
    };
    const t = setInterval(tick, 15_000);
    const onVis = () => {
      if (!document.hidden) void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setPanel("add");
    setError("");
    setMessage("");
  }

  function openEdit(account: Account) {
    setEditing(account);
    setForm({
      email: account.email,
      password: account.password || "",
      totpSecret: account.totpSecret || "",
      status: account.status === "READY" ? "READY" : "UNREADY",
      autoAssign: false,
    });
    setPanel("edit");
    setError("");
    setMessage("");
  }

  function closePanel() {
    setPanel(null);
    setEditing(null);
    setForm(emptyForm);
    setImportRows([]);
    setImportFileName("");
  }

  function openImport() {
    setPanel("import");
    setEditing(null);
    setImportRows([]);
    setImportFileName("");
    setUpdateExisting(false);
    setImportAutoAssign(false);
    setError("");
    setMessage("");
  }

  async function onPickExcel(file: File | null) {
    if (!file) return;
    setError("");
    setMessage("");
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseAccountsSpreadsheet(buf);
      if (!parsed.length) {
        setImportRows([]);
        setImportFileName(file.name);
        setError("File không có dòng hợp lệ. Cần cột email + mật khẩu.");
        return;
      }
      setImportRows(parsed);
      setImportFileName(file.name);
      setMessage(`Đã đọc ${parsed.length} dòng từ ${file.name}`);
    } catch (e) {
      setImportRows([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitImport(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !importRows.length) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await apmFetch<ImportResult>("/accounts/import", token, {
        method: "POST",
        body: JSON.stringify({
          accounts: importRows,
          updateExisting,
        }),
      });

      let extra = "";
      if (importAutoAssign && res.createdIds?.length) {
        // 1 hồ sơ / lần: tạo browser + LOGIN, chờ xong rồi mới acc tiếp
        let done = 0;
        for (const row of res.createdIds) {
          try {
            await apmFetch("/profiles/auto-assign", token, {
              method: "POST",
              body: JSON.stringify({ accountId: row.id, openLogin: true }),
            });
            done += 1;
            setMessage(
              `Đang đăng nhập lần lượt ${done}/${res.createdIds.length}: ${row.email}…`,
            );
            // RECAPTCHA có thể kéo dài — tối đa ~12 phút / acc
            let deadline = Date.now() + 12 * 60_000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 2500));
              const list = await apmFetch<Account[]>("/accounts", token);
              const acc = (Array.isArray(list) ? list : []).find((a) => a.id === row.id);
              if (!acc) break;
              if (acc.status === "READY") break;
              if (isWaitingManualSolve(acc.loginIssue)) {
                // Gia hạn deadline khi đang chờ giải tay
                deadline = Math.max(deadline, Date.now() + 8 * 60_000);
                setMessage(
                  `DỪNG — ${row.email}: chờ giải reCAPTCHA / xác minh tay trên Chrome (#${acc.profile?.browserIndex ?? "?"}). Không sang tài khoản tiếp.`,
                );
                continue;
              }
              if (isPermanentLoginIssue(acc.loginIssue)) break;
              // Hết RUNNING/QUEUED LOGIN → coi như xong vòng này
              const task = acc.profile?.status;
              if (task && task !== "QUEUED" && task !== "RUNNING" && task !== "READY") {
                if (!acc.profile?.browserAlive || isPermanentLoginIssue(acc.loginIssue)) break;
              }
            }
          } catch {
            /* proxy hết / lỗi — sang acc tiếp */
          }
        }
        extra =
          done > 0
            ? ` · Đã chạy đăng nhập lần lượt ${done}/${res.createdIds.length} (1 hồ sơ / lần).`
            : " · Không mở được Chrome (lỗi tạo hồ sơ / đăng nhập).";
      }

      setMessage((res.message || "Nhập xong") + extra);
      if (res.errors?.length) {
        const sample = res.errors
          .slice(0, 5)
          .map((x) => `dòng ${x.row}: ${x.error}`)
          .join("; ");
        setError(`Một số dòng lỗi (${res.errorCount}): ${sample}`);
      }
      closePanel();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const created = await apmFetch<{ id: string }>("/accounts", token, {
        method: "POST",
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          ...(form.totpSecret.trim()
            ? { totpSecret: form.totpSecret.trim() }
            : {}),
        }),
      });
      if (form.autoAssign) {
        await apmFetch("/profiles/auto-assign", token, {
          method: "POST",
          body: JSON.stringify({ accountId: created.id, openLogin: true }),
        });
        setMessage(
          "Đã thêm email — đang mở Chrome mới, tự điền đăng nhập. Giữ cửa sổ mở đến khi trạng thái = Sẵn sàng.",
        );
      } else {
        setMessage("Đã thêm email (chưa mở trình duyệt)");
      }
      closePanel();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !editing) return;
    const totpRaw = form.totpSecret.trim();
    if (totpRaw) {
      const normalized = totpRaw
        .replace(/[\s\-]+/g, "")
        .toUpperCase()
        .replace(/[^A-Z2-7]/g, "");
      const fromUri = totpRaw.match(/[?&]secret=([A-Za-z2-7]+)/i)?.[1];
      const secret = (fromUri || normalized).replace(/[^A-Z2-7]/gi, "").toUpperCase();
      if (secret.length > 0 && secret.length < 16) {
        setError(
          `Mã 2FA quá ngắn (${secret.length} ký tự). Cần dán full secret Authenticator (≥16 ký tự), không phải mã OTP 6 số.`,
        );
        return;
      }
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await apmFetch<{
        emailChanged?: boolean;
        message?: string;
        hasTotp?: boolean;
      }>(`/accounts/${editing.id}`, token, {
        method: "PUT",
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          status: form.status,
          ...(form.password.trim() ? { password: form.password } : {}),
          ...(totpRaw ? { totpSecret: totpRaw } : {}),
        }),
      });
      const emailNorm = form.email.trim().toLowerCase();
      setMessage(
        res.message ||
          (res.emailChanged
            ? `Đã đổi email — bấm Mở để đăng nhập ${emailNorm}`
            : `Đã cập nhật ${emailNorm}`),
      );
      // Cập nhật bảng ngay (tránh snapshot cũ giữ hasTotp=false đến khi F5)
      setRows((prev) =>
        prev.map((r) =>
          r.id === editing.id
            ? {
                ...r,
                email: emailNorm,
                status: res.emailChanged ? "UNREADY" : form.status,
                hasTotp: totpRaw ? true : Boolean(res.hasTotp ?? r.hasTotp),
                totpSecret: totpRaw || r.totpSecret || "",
                hasPassword: form.password.trim() ? true : r.hasPassword,
              }
            : r,
        ),
      );
      closePanel();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount(account: Account) {
    if (!token) return;
    const ok = window.confirm(
      `Xóa tài khoản ${account.email}?\nHồ sơ Chrome gắn kèm (nếu có) cũng sẽ bị xóa.`,
    );
    if (!ok) return;
    setBusyId(account.id);
    setError("");
    setMessage("");
    try {
      await apmFetch(`/accounts/${account.id}`, token, { method: "DELETE" });
      setMessage(`Đã xóa ${account.email}`);
      if (editing?.id === account.id) closePanel();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function resetBrowserProfile(account: Account) {
    if (!token) return;
    const ok = window.confirm(
      `Làm mới Chrome cho ${account.email}?\nXóa phiên cũ — sau đó bấm Mở để đăng nhập lại.`,
    );
    if (!ok) return;
    setBusyId(account.id);
    setError("");
    setMessage("");
    try {
      const res = await apmFetch<{ message?: string }>(
        `/accounts/${account.id}/reset-browser`,
        token,
        { method: "POST", body: "{}" },
      );
      setMessage(res.message || `Đã làm mới hồ sơ — bấm Mở để đăng nhập ${account.email}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function openOrFocusBrowser(account: Account) {
    if (!token) return;
    setBusyId(account.id);
    setError("");
    setMessage("");
    if (account.profile) {
      setRows((prev) =>
        prev.map((a) => (a.id === account.id ? optimisticOpeningPatch(a) : a)),
      );
    }
    try {
      if (!account.profile) {
        await apmFetch("/profiles/auto-assign", token, {
          method: "POST",
          body: JSON.stringify({ accountId: account.id, openLogin: true }),
        });
        setMessage("Đã tạo hồ sơ — đang mở Chrome đăng nhập…");
        await load({ silent: true });
        return;
      }

      const alive = !!account.profile.browserAlive;
      const fullyReady =
        alive &&
        (account.status === "READY" || account.profile.status === "READY");
      const res = await apmFetch<OpenResult>(
        fullyReady
          ? `/profiles/${account.profile.id}/focus-browser`
          : `/profiles/${account.profile.id}/open-browser`,
        token,
        { method: "POST", body: "{}" },
      );

      await load({ silent: true });

      const idx = res.browserIndex ?? account.profile.browserIndex ?? "?";
      if (res.action === "focus") {
        setMessage(`Chrome #${idx} — đã đưa lên màn hình.`);
        return;
      }

      if (res.action === "pending") {
        setMessage(`Chrome #${idx} đang đăng nhập — đã gửi lệnh hiện cửa sổ.`);
        return;
      }

      setMessage(
        alive
          ? `Chrome #${idx} — đang tự điền đăng nhập / xác minh…`
          : `Đang mở Chrome #${idx} đăng nhập…`,
      );

      const targetId = account.id;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        if (!token) break;
        try {
          const list = await apmFetch<Account[]>("/accounts", token);
          setRows((prev) =>
            accountsSnapshot(prev) === accountsSnapshot(list) ? prev : list,
          );
          const fresh = list.find((a) => a.id === targetId);
          if (!fresh) break;
          if (accountIsReady(fresh)) {
            setMessage(`Chrome #${idx} — đăng nhập thành công (READY).`);
            break;
          }
          if (
            fresh.profile?.browserAlive &&
            (fresh.profile.status === "RUNNING" || fresh.profile.status === "QUEUED")
          ) {
            /* Chrome đã mở — tiếp tục poll tới READY */
          }
        } catch {
          /* poll tiếp */
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await load({ silent: true });
    } finally {
      setBusyId(null);
    }
  }

  async function bulkDelete() {
    if (!token || !selectedAccounts.length) return;
    const ok = window.confirm(
      `Xóa ${selectedAccounts.length} tài khoản đã chọn?\nHồ sơ Chrome gắn kèm (nếu có) cũng sẽ bị xóa.`,
    );
    if (!ok) return;
    setBulkBusy(true);
    setError("");
    setMessage("");
    const total = selectedAccounts.length;
    let done = 0;
    const fails: string[] = [];
    for (const acc of selectedAccounts) {
      try {
        await apmFetch(`/accounts/${acc.id}`, token, { method: "DELETE" });
        done += 1;
        if (editing?.id === acc.id) closePanel();
      } catch (err) {
        fails.push(`${acc.email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    clearSelection();
    await load();
    setMessage(`Đã xóa ${done}/${total} tài khoản.`);
    if (fails.length) setError(fails.slice(0, 3).join("; "));
    setBulkBusy(false);
  }

  async function bulkReset() {
    if (!token || !selectedAccounts.length) return;
    const withProfile = selectedAccounts.filter((a) => a.profile);
    if (!withProfile.length) {
      setError("Các tài khoản đã chọn chưa có hồ sơ Chrome để làm mới.");
      return;
    }
    const ok = window.confirm(
      `Làm mới Chrome cho ${withProfile.length} tài khoản?\nXóa phiên cũ — sau đó bấm Mở để đăng nhập lại.`,
    );
    if (!ok) return;
    setBulkBusy(true);
    setError("");
    setMessage("");
    let done = 0;
    const fails: string[] = [];
    for (const acc of withProfile) {
      try {
        await apmFetch(`/accounts/${acc.id}/reset-browser`, token, {
          method: "POST",
          body: "{}",
        });
        done += 1;
      } catch (err) {
        fails.push(`${acc.email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await load();
    setMessage(`Đã làm mới ${done}/${withProfile.length} hồ sơ.`);
    if (fails.length) setError(fails.slice(0, 3).join("; "));
    setBulkBusy(false);
  }

  async function bulkOpen() {
    if (!token || !selectedAccounts.length) return;
    const total = selectedAccounts.length;
    setBulkBusy(true);
    setError("");
    setMessage("");
    let done = 0;
    const fails: string[] = [];
    let stoppedForCaptcha = false;

    for (const acc of selectedAccounts) {
      try {
        setMessage(`Đang mở lần lượt ${done + 1}/${total}: ${acc.email}…`);
        if (!acc.profile) {
          await apmFetch("/profiles/auto-assign", token, {
            method: "POST",
            body: JSON.stringify({ accountId: acc.id, openLogin: true }),
          });
        } else {
          await apmFetch(`/profiles/${acc.profile.id}/open-browser`, token, {
            method: "POST",
            body: "{}",
          });
        }
        done += 1;

        // Chờ job LOGIN xong / READY / lỗi cứng — tránh mở nhiều Chrome chồng lên nhau
        const deadline = Date.now() + 12 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2500));
          const list = await apmFetch<Account[]>("/accounts", token);
          const cur = (Array.isArray(list) ? list : []).find((a) => a.id === acc.id);
          if (!cur) break;
          if (cur.status === "READY") break;
          if (isWaitingManualSolve(cur.loginIssue)) {
            stoppedForCaptcha = true;
            setMessage(
              `DỪNG — ${cur.email}: chờ giải reCAPTCHA / xác minh tay trên Chrome (#${cur.profile?.browserIndex ?? "?"}). Không mở tài khoản tiếp.`,
            );
            break;
          }
          if (isPermanentLoginIssue(cur.loginIssue)) break;
          const task = cur.profile?.status;
          if (task && task !== "QUEUED" && task !== "RUNNING") break;
        }
        if (stoppedForCaptcha) break;
      } catch (err) {
        fails.push(`${acc.email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await load();
    if (!stoppedForCaptcha) {
      setMessage(`Đã mở lần lượt ${done}/${total} tài khoản (1 Chrome / lần).`);
    }
    if (fails.length) setError(fails.slice(0, 3).join("; "));
    setBulkBusy(false);
  }

  async function verifyAllProfiles() {
    if (!token) return;
    const ok = window.confirm(
      "Kiểm tra tất cả hồ sơ?\nWorker sẽ mở Chrome lần lượt (1 hồ sơ/lần) để xác minh đăng nhập Google.\nDừng lại nếu gặp reCAPTCHA / xác minh tay.",
    );
    if (!ok) return;
    setBulkBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await apmFetch<{
        message?: string;
        total?: number;
        enqueued?: number;
        skipped?: number;
      }>("/profiles/verify-all-sessions", token, {
        method: "POST",
        body: "{}",
      });
      setMessage(
        res.message ||
          `Đã xếp hàng kiểm tra ${res.enqueued ?? 0}/${res.total ?? 0} hồ sơ.`,
      );
      await load({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  async function stopRunningJobs(scope: "all" | "selected") {
    if (!token) return;
    const profileIds =
      scope === "selected"
        ? selectedAccounts.map((a) => a.profile?.id).filter((id): id is string => !!id)
        : undefined;
    if (scope === "selected" && !profileIds?.length) {
      setError("Tài khoản đã chọn chưa có hồ sơ / công việc.");
      return;
    }
    const label =
      scope === "selected"
        ? `${profileIds!.length} hồ sơ đã chọn`
        : "tất cả công việc đang xếp hàng / đang chạy + cảnh báo captcha";
    const ok = window.confirm(
      `Dừng ${label}?\nWorker hủy công việc / chờ captcha.\nBanner “Chờ xác minh tay” sẽ tắt.`,
    );
    if (!ok) return;
    setBulkBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await apmFetch<{
        message?: string;
        stopped?: number;
        clearedCaptcha?: number;
      }>("/profiles/stop-jobs", token, {
        method: "POST",
        body: JSON.stringify(
          scope === "selected" ? { profileIds } : { all: true },
        ),
      });
      setMessage(res.message || `Đã dừng ${res.stopped ?? 0} công việc.`);
      // Cập nhật ngay UI: xóa loginIssue captcha local để banner biến mất, không chờ poll
      setRows((prev) =>
        prev.map((r) => {
          if (!isWaitingManualSolve(r.loginIssue)) return r;
          if (scope === "all") return { ...r, loginIssue: null };
          if (r.profile && profileIds?.includes(r.profile.id)) {
            return { ...r, loginIssue: null };
          }
          return r;
        }),
      );
      await load({ silent: true });
      window.setTimeout(() => setMessage(""), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <AdminLiveBrowserSync
        token={token}
        enabled={needsLiveStatus(rows)}
        onChange={() => void load({ silent: true })}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Tài khoản Google</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={bulkBusy}
            title="Mở Chrome lần lượt để kiểm tra session Google còn sống"
            onClick={() => void verifyAllProfiles()}
          >
            Kiểm tra hồ sơ
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={bulkBusy}
            title="Hủy công việc đang xếp hàng / đang chạy — giữ nguyên trạng thái tài khoản"
            onClick={() => void stopRunningJobs("all")}
          >
            Dừng công việc
          </button>
          <button type="button" className="btn btn-secondary" onClick={openImport}>
            Nhập Excel
          </button>
          <button type="button" className="btn btn-primary" onClick={openAdd}>
            + Thêm email
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-[var(--radius-sm)] bg-[var(--signal-soft)] px-3 py-2 text-sm text-[var(--signal-ink)]">
          {message}
        </p>
      )}
      {rows.some((r) => isWaitingManualSolve(r.loginIssue)) && (
        <div
          className="rounded-[var(--radius-sm)] border border-[var(--warn)]/35 bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn-ink)]"
          role="alert"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                DỪNG — cần giải reCAPTCHA / xác minh tay trên Chrome
              </p>
              <p className="mt-1 opacity-90">
                Worker đang chờ, không tự chọn ảnh. Mở cửa sổ Chrome của tài khoản bên dưới, giải
                xong rồi đợi trạng thái chuyển sang Sẵn sàng.
              </p>
              <ul className="mt-2 list-inside list-disc font-medium">
                {rows
                  .filter((r) => isWaitingManualSolve(r.loginIssue))
                  .map((r) => (
                    <li key={r.id}>
                      {r.email}
                      {r.profile?.browserIndex != null
                        ? ` — Chrome #${r.profile.browserIndex}`
                        : ""}
                      {" · "}
                      {formatLoginStatus(r.status, r.loginIssue)}
                    </li>
                  ))}
              </ul>
            </div>
            <button
              type="button"
              className="btn btn-secondary shrink-0 !py-1.5 text-xs"
              disabled={bulkBusy}
              onClick={() => void stopRunningJobs("all")}
            >
              Dừng công việc
            </button>
          </div>
        </div>
      )}

      {panel === "import" && (
        <form onSubmit={submitImport} className="panel grid max-w-2xl gap-3 p-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[var(--ink)]">
              Nhập Excel / CSV
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Cột: <code>email</code>, <code>password</code> (bắt buộc). Tuỳ chọn:{" "}
              <code>2fa</code> / <code>totp</code>. Chấp nhận tên cột tiếng Việt: tk, mk,
              mật khẩu…
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => void onPickExcel(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileRef.current?.click()}
            >
              Chọn file…
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => downloadAccountsTemplate()}
            >
              Tải file mẫu
            </button>
          </div>
          {importFileName && (
            <p className="text-sm text-[var(--ink-soft)]">
              File: <span className="font-medium">{importFileName}</span>
              {importRows.length > 0 ? ` — ${importRows.length} dòng` : ""}
            </p>
          )}
          {importRows.length > 0 && (
            <div className="max-h-40 overflow-auto rounded-[var(--radius-sm)] border border-[var(--line)] text-xs">
              <table className="data-table !text-xs">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Email</th>
                    <th>Mật khẩu</th>
                    <th>2FA</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.slice(0, 20).map((r, i) => (
                    <tr key={`${r.email}-${i}`}>
                      <td>{i + 1}</td>
                      <td>{r.email || "—"}</td>
                      <td>{r.password ? "••••••" : "—"}</td>
                      <td>{r.totpSecret ? "Có" : "Không"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {importRows.length > 20 && (
                <p className="px-2 py-1 text-[var(--muted)]">
                  … và {importRows.length - 20} dòng nữa
                </p>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => setUpdateExisting(e.target.checked)}
            />
            Cập nhật mật khẩu nếu email đã tồn tại
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--ink-soft)]">
            <input
              type="checkbox"
              checked={importAutoAssign}
              onChange={(e) => setImportAutoAssign(e.target.checked)}
            />
            Sau nhập: tạo hồ sơ + đăng nhập lần lượt (1 hồ sơ xong mới tới hồ sơ tiếp)
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !importRows.length}
            >
              {saving ? "Đang nhập…" : `Nhập ${importRows.length || ""}`.trim()}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closePanel}
              disabled={saving}
            >
              Hủy
            </button>
          </div>
        </form>
      )}

      {panel === "add" && (
        <form
          onSubmit={createAccount}
          className="panel grid max-w-xl gap-3 p-5 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <h2 className="font-display text-base font-semibold text-[var(--ink)]">
              Thêm Gmail
            </h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Mở trình duyệt sạch, điền email/mật khẩu, giữ Chrome sống sau khi đăng nhập.
            </p>
          </div>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="font-medium text-[var(--ink-soft)]">Email *</span>
            <input
              className="input"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="account@gmail.com"
            />
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="font-medium text-[var(--ink-soft)]">Mật khẩu *</span>
            <input
              className="input"
              type="password"
              required
              minLength={6}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="font-medium text-[var(--ink-soft)]">Mã 2FA</span>
            <input
              className="input font-mono text-sm"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.totpSecret}
              onChange={(e) => setForm({ ...form, totpSecret: e.target.value })}
              placeholder="vd: bjxj pwb4 rlcl bzod … (dán mã Authenticator)"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              Khi Google hỏi mã 2 bước, hệ thống gọi 2fa.live lấy mã rồi tự điền.
            </p>
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--ink-soft)] sm:col-span-2">
            <input
              type="checkbox"
              checked={form.autoAssign}
              onChange={(e) => setForm({ ...form, autoAssign: e.target.checked })}
            />
            Tự tạo hồ sơ trình duyệt + đăng nhập ngay (không gắn proxy)
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Đang lưu…" : "Thêm"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closePanel}
              disabled={saving}
            >
              Hủy
            </button>
          </div>
        </form>
      )}

      {panel === "edit" && editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal
          aria-labelledby="edit-account-title"
          onClick={() => {
            if (!saving) closePanel();
          }}
        >
          <form
            onSubmit={updateAccount}
            className="panel account-edit-modal flex flex-col gap-2.5 p-4 shadow-[var(--shadow-md)]"
            style={{ width: 500, maxWidth: "calc(100vw - 2rem)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2
                  id="edit-account-title"
                  className="font-display text-sm font-semibold text-[var(--ink)]"
                >
                  Sửa tài khoản
                </h2>
                <p className="mt-0.5 text-xs leading-snug text-[var(--muted)]">
                  Để trống = giữ nguyên. Đổi email → đăng nhập lại.
                </p>
              </div>
              <button
                type="button"
                onClick={closePanel}
                disabled={saving}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-lg leading-none text-[var(--muted)] transition hover:bg-[var(--ghost-hover)] hover:text-[var(--ink)] disabled:opacity-50"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-[var(--ink-soft)]">Email *</span>
              <input
                className="input"
                type="email"
                required
                autoFocus
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="account@gmail.com"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-medium text-[var(--ink-soft)]">
                Mật khẩu
                {!(editing.hasPassword || editing.password || form.password) && (
                  <span className="rounded bg-[var(--warn-soft)] px-1.5 py-0.5 text-xs font-normal text-[var(--warn-ink)]">
                    Chưa có
                  </span>
                )}
              </span>
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={
                  editing.hasPassword || editing.password
                    ? "******"
                    : "Nhập mật khẩu"
                }
                autoComplete="new-password"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-medium text-[var(--ink-soft)]">
                Mã 2FA
                {!(editing.hasTotp || editing.totpSecret || form.totpSecret) && (
                  <span className="rounded bg-[var(--warn-soft)] px-1.5 py-0.5 text-xs font-normal text-[var(--warn-ink)]">
                    Chưa có
                  </span>
                )}
              </span>
              <input
                className="input font-mono text-sm"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.totpSecret}
                onChange={(e) => setForm({ ...form, totpSecret: e.target.value })}
                placeholder={
                  editing.hasTotp || editing.totpSecret
                    ? "******"
                    : "dán secret dài (vd: BJXJPWB4…) — không phải mã 6 số"
                }
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-[var(--ink-soft)]">Trạng thái</span>
              <select
                className="input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value="UNREADY">Chưa sẵn sàng</option>
                <option value="READY">Sẵn sàng</option>
              </select>
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Đang lưu…" : "Lưu"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closePanel}
                disabled={saving}
              >
                Hủy
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="panel px-4 py-10 text-center text-sm text-[var(--muted)]">Đang tải…</div>
      ) : (
        <div className="panel overflow-hidden">
          {selectedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--surface-muted)] px-4 py-2.5 text-sm">
              <p className="text-[var(--ink-soft)]">
                Đã chọn{" "}
                <span className="font-semibold text-[var(--ink)]">{selectedCount}</span> tài khoản
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary !py-1.5 text-xs"
                  disabled={bulkBusy}
                  onClick={() => void bulkOpen()}
                >
                  {bulkBusy ? "…" : "Mở"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary !py-1.5 text-xs"
                  disabled={bulkBusy}
                  onClick={() => void bulkReset()}
                >
                  Làm mới
                </button>
                <button
                  type="button"
                  className="btn btn-secondary !py-1.5 text-xs"
                  disabled={bulkBusy}
                  title="Dừng công việc đang chạy của tài khoản đã chọn"
                  onClick={() => void stopRunningJobs("selected")}
                >
                  Dừng
                </button>
                <button
                  type="button"
                  className="btn btn-secondary !py-1.5 text-xs text-[var(--danger)]"
                  disabled={bulkBusy}
                  onClick={() => void bulkDelete()}
                >
                  Xóa
                </button>
                <button
                  type="button"
                  className="btn btn-secondary !py-1.5 text-xs"
                  disabled={bulkBusy}
                  onClick={clearSelection}
                >
                  Bỏ chọn
                </button>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      className="row-check"
                      checked={allPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = somePageSelected;
                      }}
                      disabled={!pageIds.length || bulkBusy}
                      onChange={toggleSelectPage}
                      title={allPageSelected ? "Bỏ chọn trang này" : "Chọn cả trang"}
                      aria-label="Chọn cả trang"
                    />
                  </th>
                  <th className="w-14 whitespace-nowrap">STT</th>
                  <th>Email</th>
                  <th>2FA</th>
                  <th>Trạng thái đăng nhập</th>
                  <th>Trình duyệt</th>
                  <th className="sticky-actions-col whitespace-nowrap">Thao tác nhanh</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const alive = profileBrowserActive(r);
                  const ready = accountIsReady(r);
                  const showFocus = !!r.profile?.browserAlive && ready;
                  const busy = busyId === r.id || bulkBusy;
                  const checked = selectedIds.has(r.id);
                  const statusLabel = accountStatusLabel(r);
                  return (
                    <tr key={r.id} className={checked ? "row-selected" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          className="row-check"
                          checked={checked}
                          disabled={bulkBusy}
                          onChange={() => toggleSelect(r.id)}
                          aria-label={`Chọn ${r.email}`}
                        />
                      </td>
                      <td className="font-mono text-[var(--muted)] tabular-nums">
                        {pageStart + i + 1}
                      </td>
                      <td className="font-medium">{r.email}</td>
                      <td>
                        {r.hasTotp || r.totpSecret ? (
                          <span className="text-xs font-medium text-[var(--signal-ink)]">Có</span>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">Không</span>
                        )}
                      </td>
                      <td>
                        <StatusLight value={statusLabel} kind="status" />
                      </td>
                      <td>
                        {r.profile ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="font-mono text-xs">
                              #{r.profile.browserIndex ?? "?"}
                            </span>
                            <StatusLight value={formatAliveLabel(alive)} kind="alive" />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="sticky-actions-col">
                        <div className="action-btns">
                          <button
                            type="button"
                            className="action-btn action-btn-primary"
                            disabled={busy}
                            title={
                              showFocus
                                ? "Đưa cửa sổ Chrome lên"
                                : alive
                                  ? "Tiếp tục đăng nhập — tự điền email/mk/2FA"
                                  : "Mở Chrome đăng nhập"
                            }
                            onClick={() => void openOrFocusBrowser(r)}
                          >
                            {busyId === r.id ? "…" : showFocus ? "Hiện" : "Mở"}
                          </button>
                          <button
                            type="button"
                            className="action-btn action-btn-edit"
                            disabled={busy}
                            title="Sửa email / mật khẩu"
                            onClick={() => openEdit(r)}
                          >
                            Sửa
                          </button>
                          <button
                            type="button"
                            className="action-btn action-btn-edit"
                            disabled={busy || !r.profile}
                            title="Xóa phiên Chrome cũ (khi bị lặp đăng nhập)"
                            onClick={() => void resetBrowserProfile(r)}
                          >
                            Làm mới
                          </button>
                          <button
                            type="button"
                            className="action-btn action-btn-danger"
                            disabled={busy}
                            title="Xóa tài khoản"
                            onClick={() => void deleteAccount(r)}
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="!py-10 text-center text-[var(--muted)]">
                      Chưa có tài khoản — bấm Thêm email
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {rows.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-4 py-3 text-sm">
              <p className="text-[var(--muted)]">
                Hiển thị{" "}
                <span className="font-medium text-[var(--ink-soft)]">
                  {pageStart + 1}–{pageEnd}
                </span>{" "}
                / {rows.length}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[var(--ink-soft)]">
                  <span className="text-[var(--muted)]">Số dòng</span>
                  <select
                    className="input !w-auto !min-w-0 !py-1.5 !text-sm"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
                      setPage(1);
                    }}
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="btn btn-secondary !px-2.5 !py-1.5 text-xs"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Trước
                  </button>
                  <span className="min-w-[4.5rem] text-center tabular-nums text-[var(--ink-soft)]">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary !px-2.5 !py-1.5 text-xs"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Sau
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
