import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string; mediaId: string }> };

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
}

async function assertProjectAccess(id: string, userId: string, isAdmin: boolean) {
  return prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, mediaId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await assertProjectAccess(id, session.user.id, isAdmin);
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const media = await prisma.mediaAsset.findFirst({
    where: { id: mediaId, projectId: id },
  });
  if (!media) {
    return NextResponse.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    const captionRaw = form.get("caption");
    const hasCaption = captionRaw !== null && captionRaw !== undefined;
    const caption =
      typeof captionRaw === "string"
        ? captionRaw.trim()
          ? captionRaw.trim().slice(0, 200)
          : null
        : undefined;

    if (!(file instanceof File) || file.size === 0) {
      if (!hasCaption) {
        return NextResponse.json({ error: "Không có thay đổi" }, { status: 400 });
      }
      const updated = await prisma.mediaAsset.update({
        where: { id: mediaId },
        data: { caption: caption ?? null },
      });
      return NextResponse.json({ media: updated });
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

    try {
      await unlink(path.join(uploadRoot(), id, media.fileName));
    } catch {
      // file may already be missing
    }

    const updated = await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: {
        fileName,
        filePath: `/api/uploads/${id}/${fileName}`,
        mimeType: file.type,
        sizeBytes: file.size,
        ...(hasCaption ? { caption: caption ?? null } : {}),
      },
    });
    return NextResponse.json({ media: updated });
  }

  const body = (await req.json()) as { caption?: string | null };
  if (!("caption" in body)) {
    return NextResponse.json({ error: "Không có thay đổi" }, { status: 400 });
  }
  const caption =
    body.caption == null
      ? null
      : String(body.caption).trim()
        ? String(body.caption).trim().slice(0, 200)
        : null;

  const updated = await prisma.mediaAsset.update({
    where: { id: mediaId },
    data: { caption },
  });
  return NextResponse.json({ media: updated });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, mediaId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await assertProjectAccess(id, session.user.id, isAdmin);
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const media = await prisma.mediaAsset.findFirst({
    where: { id: mediaId, projectId: id },
  });
  if (!media) {
    return NextResponse.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  }

  try {
    await unlink(path.join(uploadRoot(), id, media.fileName));
  } catch {
    // file may already be missing
  }

  await prisma.mediaAsset.delete({ where: { id: mediaId } });
  return NextResponse.json({ ok: true });
}
