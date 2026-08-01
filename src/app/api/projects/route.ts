import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { projectCreateSchema, formatZodFlatten } from "@/lib/validations";
import { buildProjectPlaceFields } from "@/lib/project-place-fields";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = session.user.role === "ADMIN";
  const projects = await prisma.project.findMany({
    where: isAdmin ? undefined : { userId: session.user.id },
    include: {
      package: { select: { id: true, code: true, name: true, targetContents: true } },
      _count: { select: { products: true, media: true } },
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const parsed = projectCreateSchema.safeParse(body);
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

    const placeFields = buildProjectPlaceFields({
      googleMapsUrl: data.googleMapsUrl,
      placeKey: data.placeKey,
      resolvedUrl: data.resolvedUrl,
    });

    const project = await prisma.project.create({
      data: {
        userId: session.user.id,
        packageId: data.packageId,
        brandName: data.brandName,
        website: data.website,
        brandDescription: data.brandDescription,
        targetAudience: data.targetAudience,
        targetMarket: data.targetMarket,
        writingNotes: data.writingNotes,
        googleMapsUrl: data.googleMapsUrl,
        placeKey: placeFields.placeKey,
        resolvedUrl: placeFields.resolvedUrl,
        placeResolvedAt: placeFields.placeResolvedAt ?? null,
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
          : data.currentRating != null || data.reviewCount != null
            ? new Date()
            : null,
        reviewsToPost: pkg.targetContents,
        startAt: new Date(data.startAt),
        endAt: new Date(data.endAt),
        status: "DRAFT",
        products: {
          create: data.products.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        },
      },
      include: { package: true, products: true },
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (e) {
    console.error("[projects] create failed", e);
    return NextResponse.json({ error: "Không thể tạo dự án" }, { status: 500 });
  }
}
