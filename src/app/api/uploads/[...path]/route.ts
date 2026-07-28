import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { getToken } from "next-auth/jwt";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token?.id || token.error === "IdleTimeout") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parts = (await ctx.params).path;
  if (!parts?.length || parts.some((p) => p.includes("..") || p.includes("\\"))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const root = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
  const filePath = path.resolve(root, ...parts);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : "image/jpeg";
    return new NextResponse(data, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
