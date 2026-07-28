import { PrismaClient } from "@prisma/client";
import { encryptSecret, hashPassword } from "@apm/crypto";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = "admin@apm.local";
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: hashPassword("Admin@123"),
      role: "ADMIN",
    },
  });

  await prisma.taskDefinition.upsert({
    where: { code: "LOGIN" },
    update: {},
    create: {
      code: "LOGIN",
      name: "Login / restore session",
      timeoutMs: 180000,
      maxRetries: 2,
      handlerKey: "login",
    },
  });

  await prisma.taskDefinition.upsert({
    where: { code: "HEALTHCHECK" },
    update: {},
    create: {
      code: "HEALTHCHECK",
      name: "Open browser and verify proxy",
      timeoutMs: 60000,
      maxRetries: 1,
      handlerKey: "healthcheck",
    },
  });

  await prisma.taskDefinition.upsert({
    where: { code: "BROWSER_CHECK" },
    update: {},
    create: {
      code: "BROWSER_CHECK",
      name: "Check browser IP / UA via proxy",
      timeoutMs: 90000,
      maxRetries: 1,
      handlerKey: "browser_check",
    },
  });

  await prisma.taskDefinition.upsert({
    where: { code: "MAPS_REVIEW" },
    update: {},
    create: {
      code: "MAPS_REVIEW",
      name: "Post Google Maps review",
      timeoutMs: 300000,
      maxRetries: 1,
      handlerKey: "maps_review",
    },
  });

  const proxy = await prisma.proxy.upsert({
    where: { host_port: { host: "127.0.0.1", port: 8080 } },
    update: {},
    create: {
      host: "127.0.0.1",
      port: 8080,
      protocol: "http",
      country: "VN",
      note: "Local demo proxy (replace in production)",
      maxProfiles: 10,
      status: "ACTIVE",
      usernameEnc: encryptSecret("proxy-user"),
      passwordEnc: encryptSecret("proxy-pass"),
    },
  });

  const account = await prisma.googleAccount.upsert({
    where: { email: "demo.account@example.com" },
    update: {},
    create: {
      email: "demo.account@example.com",
      passwordEnc: encryptSecret("DemoPass123!"),
      recoveryEmail: "recovery@example.com",
      status: "READY",
    },
  });

  const existing = await prisma.profile.findUnique({ where: { accountId: account.id } });
  if (!existing) {
    const profile = await prisma.profile.create({
      data: {
        accountId: account.id,
        proxyId: null,
        browserIndex: 1,
        browserProfilePath: `profiles/${account.id}`,
        cookiePath: `profiles/${account.id}/cookies.json`,
        localStoragePath: `profiles/${account.id}/localStorage.json`,
        cooldownMinutes: 60,
        timezone: "Asia/Ho_Chi_Minh",
        language: "vi-VN",
        status: "READY",
        nextRun: new Date(),
        viewport: { width: 1280, height: 800 },
      },
    });
    void profile;
    // Proxy không gắn sticky — lấy random + lock lúc chạy MAPS_REVIEW
  }

  console.log("Seed OK");
  console.log(`Admin: ${admin.email} / Admin@123`);

  // CRM packages + templates (shared DB)
  const packages = [
    {
      code: "A",
      name: "Gói A",
      description: "Gói cơ bản — 30 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 30,
    },
    {
      code: "B",
      name: "Gói B",
      description: "Gói tiêu chuẩn — 50 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 50,
    },
    {
      code: "C",
      name: "Gói C",
      description: "Gói nâng cao — 100 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 100,
    },
  ];
  for (const pkg of packages) {
    await prisma.package.upsert({
      where: { code: pkg.code },
      update: pkg,
      create: pkg,
    });
  }

  const outreach = `{Em chào anh chị|Anh chị ơi}, [$user_name]

{hiện tại website có đang ổn định traffic & chuyển đổi không ạ?|Đợt Google cập nhật vừa rồi Website của anh chị có bị ảnh hưởng nhiều k ạ?}

Brand: [$brand_name]
[$product_list]`;

  await prisma.contentTemplate.upsert({
    where: { code: "AUDIT_OUTREACH" },
    update: { bodySpin: outreach, isActive: true },
    create: {
      code: "AUDIT_OUTREACH",
      name: "Outreach Audit Website 2026",
      type: "OUTREACH_EMAIL",
      tone: "FRIENDLY",
      bodySpin: outreach,
    },
  });

  // Demo user (USER role) for /app
  await prisma.user.upsert({
    where: { email: "user@apm.local" },
    update: {},
    create: {
      email: "user@apm.local",
      passwordHash: hashPassword("User@123"),
      name: "Demo User",
      role: "USER",
    },
  });
  console.log("User: user@apm.local / User@123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
