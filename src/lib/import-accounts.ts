/** Parse Excel/CSV → danh sách account (email, password, 2fa). */
import * as XLSX from "xlsx";

export type ImportAccountRow = {
  email: string;
  password: string;
  recoveryPhone?: string;
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

function pick(
  row: Record<string, unknown>,
  keys: string[],
): string {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    map.set(normHeader(k), v);
  }
  for (const key of keys) {
    const v = map.get(key);
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

const EMAIL_KEYS = [
  "email",
  "mail",
  "gmail",
  "taikhoan",
  "tk",
  "account",
  "username",
  "user",
  "login",
];
const PASS_KEYS = ["password", "pass", "mk", "matkhau", "pwd", "passw"];
const PHONE_KEYS = ["recoveryphone", "phone", "sdt", "dienthoai", "phonekhoiphuc"];
const TOTP_KEYS = [
  "totpsecret",
  "totp",
  "2fa",
  "twofa",
  "fa",
  "otp",
  "secret",
  "authenticator",
  "googleauthenticator",
  "ma2fa",
];

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
    const email = pick(row, EMAIL_KEYS).toLowerCase();
    const password = pick(row, PASS_KEYS);
    const recoveryPhone = pick(row, PHONE_KEYS) || undefined;
    const totpSecret = pick(row, TOTP_KEYS) || undefined;
    if (!email && !password) continue;
    out.push({ email, password, recoveryPhone, totpSecret });
  }
  return out;
}

/** Tải file mẫu Excel email / password / 2fa */
export function downloadAccountsTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["email", "password", "2fa"],
    [
      "vidu1@gmail.com",
      "MatKhau123",
      "bjxj pwb4 rlcl bzod 3xq2 vg2e casq rzck",
    ],
    ["vidu2@gmail.com", "MatKhau456", ""],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "accounts");
  XLSX.writeFile(wb, "mau-import-accounts.xlsx");
}
