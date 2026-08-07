/** Parse Excel/CSV → danh sách account (tk, mk, 2fa + tên/địa chỉ/avatar tuỳ chọn). */
import * as XLSX from "xlsx";

export type ImportAccountRow = {
  email: string;
  password: string;
  totpSecret?: string;
  desiredName?: string;
  desiredAddress?: string;
  desiredAvatarUrl?: string;
};

function normHeader(h: unknown): string {
  return String(h ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    // NFD không tách đ/Đ — phải map tay, nếu không "Địa chỉ" thành "iachi".
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const nk = normHeader(key);
    for (const [k, v] of Object.entries(row)) {
      if (normHeader(k) === nk && v != null && String(v).trim()) {
        return String(v).trim();
      }
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
    const email = pick(row, ["tk", "email"]).toLowerCase();
    const password = pick(row, ["mk", "password"]);
    const totpSecret = pick(row, ["2fa", "totp", "totpSecret"]) || undefined;
    const desiredName = pick(row, ["ten", "name", "desiredName"]) || undefined;
    const desiredAddress =
      pick(row, ["diachi", "address", "desiredAddress"]) || undefined;
    const desiredAvatarUrl =
      pick(row, ["avatar", "avatarUrl", "avatar_url", "desiredAvatarUrl"]) ||
      undefined;
    if (!email || !password) continue;
    out.push({
      email,
      password,
      totpSecret,
      desiredName,
      desiredAddress,
      desiredAvatarUrl,
    });
  }
  return out;
}

export type ProfileGender = "MALE" | "FEMALE" | null;

export type ProfileSheetRow = {
  name: string;
  gender: ProfileGender;
  address: string;
};

function parseGender(raw: string): ProfileGender {
  const v = normHeader(raw);
  if (!v) return null;
  if (v === "nam" || v === "male" || v === "m" || v === "nampp") return "MALE";
  if (v === "nu" || v === "female" || v === "f" || v === "nugioi") return "FEMALE";
  return null;
}

/**
 * Parse danh sách hồ sơ (Họ tên / Giới tính / Địa chỉ).
 * Cột Avatar trong file bị bỏ qua — ảnh lấy từ thư mục nam/nữ theo giới tính.
 */
export function parseProfileSpreadsheet(buffer: ArrayBuffer): ProfileSheetRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const out: ProfileSheetRow[] = [];
  for (const row of json) {
    const name = pick(row, ["hoten", "hovaten", "ten", "name", "fullname"]);
    const address = pick(row, ["diachi", "address"]);
    const gender = parseGender(pick(row, ["gioitinh", "gender", "sex"]));
    if (!name && !address) continue;
    out.push({ name, gender, address });
  }
  return out;
}

/** Tải file mẫu Excel qua API (Content-Disposition) — tránh lỗi .crdownload trên Chrome. */
export function downloadAccountsTemplate() {
  if (typeof window === "undefined") return;
  window.location.assign("/api/admin/accounts/import-template");
}
