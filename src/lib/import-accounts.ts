/** Parse Excel/CSV → danh sách account (3 cột: tk, mk, 2fa). */
import * as XLSX from "xlsx";

export type ImportAccountRow = {
  email: string;
  password: string;
  totpSecret?: string;
};

function normHeader(h: unknown): string {
  return String(h ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function pick(row: Record<string, unknown>, key: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (normHeader(k) === key && v != null && String(v).trim()) {
      return String(v).trim();
    }
  }
  return "";
}

export function parseAccountsSpreadsheet(buffer: ArrayBuffer): ImportAccountRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const out: ImportAccountRow[] = [];
  for (const row of json) {
    const email = pick(row, "tk").toLowerCase();
    const password = pick(row, "mk");
    const totpSecret = pick(row, "2fa") || undefined;
    if (!email || !password) continue;
    out.push({ email, password, totpSecret });
  }
  return out;
}

/** Tải file mẫu Excel qua API (Content-Disposition) — tránh lỗi .crdownload trên Chrome. */
export function downloadAccountsTemplate() {
  if (typeof window === "undefined") return;
  window.location.assign("/api/admin/accounts/import-template");
}
