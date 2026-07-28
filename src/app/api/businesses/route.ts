import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { businessCreateSchema, formatZodFlatten } from "@/lib/validations";

async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return session.user;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const activeOnly = url.searchParams.get("active") === "1";
  const countOnly = url.searchParams.get("countOnly") === "1";

  const where = {
    userId: user.id,
    ...(activeOnly ? { isActive: true } : {}),
    ...(q
      ? {
          OR: [
            { brandName: { contains: q, mode: "insensitive" as const } },
            { targetAudience: { contains: q, mode: "insensitive" as const } },
            { website: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  if (countOnly) {
    const total = await prisma.business.count({ where });
    return NextResponse.json({ total });
  }

  const businesses = await prisma.business.findMany({
    where,
    include: {
      products: { orderBy: { createdAt: "asc" } },
    },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });

  return NextResponse.json({
    businesses,
    total: businesses.length,
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = businessCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: formatZodFlatten(parsed.error.flatten()), details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const count = await prisma.business.count({ where: { userId: user.id } });
  const makeActive = data.setActive || count === 0;

  const business = await prisma.$transaction(async (tx) => {
    if (makeActive) {
      await tx.business.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false },
      });
    }
    return tx.business.create({
      data: {
        userId: user.id,
        brandName: data.brandName,
        website: data.website ?? null,
        brandDescription: data.brandDescription || "",
        targetAudience: data.targetAudience || "",
        targetMarket: data.targetMarket || "",
        writingNotes: data.writingNotes || null,
        isActive: makeActive,
        products: {
          create: data.products.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        },
      },
      include: { products: true },
    });
  });

  return NextResponse.json({ business }, { status: 201 });
}
