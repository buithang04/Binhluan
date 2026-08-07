import * as XLSX from "xlsx";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";

const FILE_NAME = "mau-import-accounts.xlsx";
const MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const rows = [
    {
      tk: "example@gmail.com",
      mk: "MatKhau123",
      "2fa": "",
      ten: "Nguyen Van A",
      diachi: "123 Duong ABC, Quan 1, TP.HCM",
      avatar: "https://example.com/avatar.jpg",
    },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "accounts");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": MIME,
      "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
