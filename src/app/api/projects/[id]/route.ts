import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { projectUpdateSchema, formatZodFlatten } from "@/lib/validations";

type Ctx = { params: Promise<{ id: string }> };

async function getOwnedProject(id: string, userId: string, isAdmin: boolean) {
  return prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId },
    include: { package: true, products: true, media: true },
  });
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const project = await getOwnedProject(
    id,
    session.user.id,
    session.user.role === "ADMIN",
  );
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

export async function PUT(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const existing = await getOwnedProject(
    id,
    session.user.id,
    session.user.role === "ADMIN",
  );
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  try {
    const body = await req.json();
    const parsed = projectUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      return NextResponse.json(
        {
          error: formatZodFlatten(flat),
          details: flat,
        },
        { status: 400 },
      );
    }

    const data = parsed.data;
    const pkg = await prisma.package.findUnique({ where: { id: data.packageId } });
    if (!pkg) {
      return NextResponse.json({ error: "Gói không tồn tại" }, { status: 400 });
    }

    const project = await prisma.$transaction(async (tx) => {
      await tx.product.deleteMany({ where: { projectId: id } });
      return tx.project.update({
        where: { id },
        data: {
          packageId: data.packageId,
          brandName: data.brandName,
          website: data.website,
          brandDescription: data.brandDescription,
          targetAudience: data.targetAudience,
          targetMarket: data.targetMarket,
          writingNotes: data.writingNotes,
          googleMapsUrl: data.googleMapsUrl,
          desiredRating:
            data.desiredRating === null
              ? null
              : new Prisma.Decimal(data.desiredRating),
          currentRating:
            data.currentRating === null
              ? null
              : new Prisma.Decimal(data.currentRating),
          reviewCount: data.reviewCount,
          ratingScannedAt: data.ratingScannedAt
            ? new Date(data.ratingScannedAt)
            : undefined,
          reviewsToPost: pkg.targetContents,
          proxyCooldownMinutes: data.proxyCooldownMinutes,
          startAt: new Date(data.startAt),
          endAt: new Date(data.endAt),
          products: {
            create: data.products.map((p) => ({
              name: p.name,
              description: p.description,
            })),
          },
        },
        include: { package: true, products: true, media: true },
      });
    });

    return NextResponse.json({ project });
  } catch (e) {
    console.error("[projects] update failed", e);
    return NextResponse.json({ error: "Không thể cập nhật dự án" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const existing = await getOwnedProject(id, session.user.id, isAdmin);
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  // User thường: đã sinh nội dung thì không xóa (kể cả còn DRAFT).
  if (
    !isAdmin &&
    existing.reviewContentGeneratedAt &&
    existing.reviewContentGeneratedAt.getTime() > 0
  ) {
    return NextResponse.json(
      { error: "Dự án đã sinh nội dung — không thể xóa" },
      { status: 403 },
    );
  }

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
