import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MAX_PROJECT_MEDIA } from "@/lib/limits";

type Ctx = { params: Promise<{ id: string }> };

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: { media: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }
  if (project.media.length >= MAX_PROJECT_MEDIA) {
    return NextResponse.json(
      { error: `Tối đa ${MAX_PROJECT_MEDIA} ảnh mỗi dự án` },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  const captionRaw = form.get("caption");
  const caption =
    typeof captionRaw === "string" && captionRaw.trim()
      ? captionRaw.trim().slice(0, 200)
      : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Thiếu file ảnh" }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { error: "Chỉ chấp nhận jpg/png/webp" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Ảnh tối đa 5MB" }, { status: 400 });
  }

  const ext =
    file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const fileName = `${randomUUID()}.${ext}`;
  const dir = path.join(uploadRoot(), id);
  await mkdir(dir, { recursive: true });
  const diskPath = path.join(dir, fileName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(diskPath, buffer);

  const publicPath = `/api/uploads/${id}/${fileName}`;
  const media = await prisma.mediaAsset.create({
    data: {
      projectId: id,
      fileName,
      filePath: publicPath,
      caption,
      mimeType: file.type,
      sizeBytes: file.size,
    },
  });

  return NextResponse.json({ media }, { status: 201 });
}
