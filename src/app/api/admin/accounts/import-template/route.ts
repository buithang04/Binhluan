import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";

const FILE_NAME = "mau-import-accounts.xlsx";
const MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const diskPath = path.join(process.cwd(), "public", FILE_NAME);
  try {
    const buf = await readFile(diskPath);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": MIME,
        "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Không tìm thấy file mẫu" }, { status: 404 });
  }
}
