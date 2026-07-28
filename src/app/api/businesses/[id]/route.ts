import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { businessUpdateSchema, formatZodFlatten } from "@/lib/validations";

type Ctx = { params: Promise<{ id: string }> };

async function requireOwned(id: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const business = await prisma.business.findFirst({
    where: { id, userId: session.user.id },
    include: { products: { orderBy: { createdAt: "asc" } } },
  });
  if (!business) return { error: NextResponse.json({ error: "Không tìm thấy" }, { status: 404 }) };
  return { userId: session.user.id, business };
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const owned = await requireOwned(id);
  if (owned.error) return owned.error;
  return NextResponse.json({ business: owned.business });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const owned = await requireOwned(id);
  if (owned.error) return owned.error;

  const body = await req.json();
  const parsed = businessUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: formatZodFlatten(parsed.error.flatten()) },
      { status: 400 },
    );
  }
  const data = parsed.data;

  const business = await prisma.$transaction(async (tx) => {
    if (data.setActive) {
      await tx.business.updateMany({
        where: { userId: owned.userId, isActive: true },
        data: { isActive: false },
      });
    }
    await tx.businessProduct.deleteMany({ where: { businessId: id } });
    return tx.business.update({
      where: { id },
      data: {
        brandName: data.brandName,
        website: data.website ?? null,
        brandDescription: data.brandDescription || "",
        targetAudience: data.targetAudience || "",
        targetMarket: data.targetMarket || "",
        writingNotes: data.writingNotes || null,
        ...(data.setActive ? { isActive: true } : {}),
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

  return NextResponse.json({ business });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const owned = await requireOwned(id);
  if (owned.error) return owned.error;

  await prisma.business.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
