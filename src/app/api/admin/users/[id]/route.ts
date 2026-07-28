import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { adminUserUpdateSchema } from "@/lib/validations";

type Ctx = { params: Promise<{ id: string }> };

async function countAdmins(excludeId?: string) {
  return prisma.user.count({
    where: {
      role: "ADMIN",
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const body = await req.json();
  const parsed = adminUserUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Không tìm thấy user" }, { status: 404 });
  }

  if (id === auth.user!.id && parsed.data.role === "USER") {
    return NextResponse.json({ error: "Không thể tự hạ quyền admin" }, { status: 400 });
  }
  if (id === auth.user!.id && parsed.data.isActive === false) {
    return NextResponse.json({ error: "Không thể tự khóa tài khoản" }, { status: 400 });
  }

  if (target.role === "ADMIN" && parsed.data.role === "USER") {
    const others = await countAdmins(id);
    if (others === 0) {
      return NextResponse.json({ error: "Phải giữ ít nhất một admin" }, { status: 400 });
    }
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      ...(parsed.data.isActive === true
        ? { failedLoginAttempts: 0, lockedUntil: null }
        : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      lockedUntil: true,
    },
  });

  if (parsed.data.isActive === false) {
    await prisma.refreshToken.deleteMany({ where: { userId: id } });
  }

  await prisma.auditLog.create({
    data: {
      actorId: auth.user!.id,
      action: "USER_UPDATE",
      entityType: "User",
      entityId: id,
      after: parsed.data,
    },
  });

  return NextResponse.json({ user });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  if (id === auth.user!.id) {
    return NextResponse.json({ error: "Không thể xóa chính mình" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  });
  if (!target) {
    return NextResponse.json({ error: "Không tìm thấy user" }, { status: 404 });
  }

  if (target.role === "ADMIN") {
    const others = await countAdmins(id);
    if (others === 0) {
      return NextResponse.json({ error: "Phải giữ ít nhất một admin" }, { status: 400 });
    }
  }

  if (target._count.projects > 0) {
    return NextResponse.json(
      { error: "User còn dự án — hãy vô hiệu hóa thay vì xóa" },
      { status: 409 },
    );
  }

  await prisma.user.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      actorId: auth.user!.id,
      action: "USER_DELETE",
      entityType: "User",
      entityId: id,
      before: { email: target.email },
    },
  });

  return NextResponse.json({ ok: true });
}
