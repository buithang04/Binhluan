import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";
import { mediaAbsolutePath } from "@/lib/media-path";

type Ctx = { params: Promise<{ projectId: string; fileName: string }> };

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function safeFileName(name: string) {
  const base = path.basename(name);
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) return null;
  return base;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { projectId, fileName: rawName } = await ctx.params;
  const fileName = safeFileName(rawName);
  if (!fileName || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const diskPath = mediaAbsolutePath(projectId, fileName);
  try {
    const info = await stat(diskPath);
    if (!info.isFile()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const buf = await readFile(diskPath);
    const ext = path.extname(fileName).toLowerCase();
    return new NextResponse(buf, {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
