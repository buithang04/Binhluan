import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { adminPasswordResetSchema } from "@/lib/validations";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const body = await req.json();
  const parsed = adminPasswordResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Mật khẩu không hợp lệ (≥8 ký tự, chữ + số)" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Không tìm thấy user" }, { status: 404 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
  await prisma.refreshToken.deleteMany({ where: { userId: id } });

  await prisma.auditLog.create({
    data: {
      actorId: auth.user!.id,
      action: "USER_RESET_PASSWORD",
      entityType: "User",
      entityId: id,
      after: { email: target.email },
    },
  });

  return NextResponse.json({ ok: true });
}
