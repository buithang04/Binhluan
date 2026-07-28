import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

/** Bỏ Active — doanh nghiệp này không còn auto-fill khi tạo dự án. */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const owned = await prisma.business.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!owned) {
    return NextResponse.json({ error: "Không tìm thấy" }, { status: 404 });
  }

  const business = await prisma.business.update({
    where: { id },
    data: { isActive: false },
    select: { id: true, brandName: true, isActive: true },
  });

  return NextResponse.json({ business });
}
