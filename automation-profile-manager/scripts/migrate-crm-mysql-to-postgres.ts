/**
 * One-shot: copy CRM rows from legacy MySQL (docker-compose.crm.yml) → shared Postgres.
 * Usage:
 *   docker compose -f docker-compose.crm.yml up -d mysql
 *   cd automation-profile-manager && npm run migrate:crm
 */
import { PrismaClient } from "@prisma/client";
import { createConnection } from "mysql2/promise";
import { randomUUID } from "crypto";

const pg = new PrismaClient();

async function main() {
  const mysqlUrl =
    process.env.CRM_MYSQL_URL ||
    "mysql://app:appsecret@127.0.0.1:3307/project_crm";

  console.log("Connecting MySQL", mysqlUrl.replace(/:[^:@]+@/, ":***@"));
  const conn = await createConnection(mysqlUrl);

  const idMap = new Map<string, string>(); // old cuid → new uuid (if needed we keep cuid as id)

  const [users] = await conn.query<any[]>("SELECT * FROM User");
  for (const u of users) {
    const role = u.role === "ADMIN" ? "ADMIN" : "USER";
    await pg.user.upsert({
      where: { email: u.email },
      update: {
        passwordHash: u.passwordHash,
        name: u.name,
        role,
      },
      create: {
        id: u.id,
        email: u.email,
        passwordHash: u.passwordHash,
        name: u.name,
        role,
      },
    });
    idMap.set(u.id, u.id);
  }
  console.log("Users:", users.length);

  const [packages] = await conn.query<any[]>("SELECT * FROM Package");
  for (const p of packages) {
    await pg.package.upsert({
      where: { code: p.code },
      update: {
        name: p.name,
        description: p.description,
        maxProducts: p.maxProducts,
        maxMedia: p.maxMedia,
        targetContents: p.targetContents,
      },
      create: {
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        maxProducts: p.maxProducts,
        maxMedia: p.maxMedia,
        targetContents: p.targetContents,
      },
    });
  }
  console.log("Packages:", packages.length);

  const [templates] = await conn.query<any[]>("SELECT * FROM ContentTemplate");
  for (const t of templates) {
    await pg.contentTemplate.upsert({
      where: { code: t.code },
      update: {
        name: t.name,
        type: t.type,
        tone: t.tone,
        bodySpin: t.bodySpin,
        isActive: Boolean(t.isActive),
      },
      create: {
        id: t.id,
        code: t.code,
        name: t.name,
        type: t.type,
        tone: t.tone,
        bodySpin: t.bodySpin,
        isActive: Boolean(t.isActive),
      },
    });
  }
  console.log("Templates:", templates.length);

  const [projects] = await conn.query<any[]>("SELECT * FROM Project");
  for (const p of projects) {
    await pg.project.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        userId: p.userId,
        packageId: p.packageId,
        brandName: p.brandName,
        website: p.website,
        brandDescription: p.brandDescription,
        targetAudience: p.targetAudience,
        targetMarket: p.targetMarket,
        writingNotes: p.writingNotes,
        googleMapsUrl: p.googleMapsUrl,
        desiredRating: p.desiredRating,
        currentRating: p.currentRating,
        reviewCount: p.reviewCount,
        startAt: p.startAt,
        endAt: p.endAt,
        status: p.status,
      },
    });
  }
  console.log("Projects:", projects.length);

  const [products] = await conn.query<any[]>("SELECT * FROM Product");
  for (const p of products) {
    await pg.product.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        projectId: p.projectId,
        name: p.name,
        description: p.description,
      },
    });
  }
  console.log("Products:", products.length);

  const [media] = await conn.query<any[]>("SELECT * FROM MediaAsset");
  for (const m of media) {
    await pg.mediaAsset.upsert({
      where: { id: m.id },
      update: {},
      create: {
        id: m.id,
        projectId: m.projectId,
        fileName: m.fileName,
        filePath: m.filePath,
        caption: m.caption,
        mimeType: m.mimeType,
        sizeBytes: m.sizeBytes,
      },
    });
  }
  console.log("Media:", media.length);

  const [campaigns] = await conn.query<any[]>("SELECT * FROM ContentCampaign");
  for (const c of campaigns) {
    await pg.contentCampaign.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id,
        projectId: c.projectId,
        templateId: c.templateId,
        targetCount: c.targetCount,
        status: c.status,
      },
    });
  }
  console.log("Campaigns:", campaigns.length);

  const [contents] = await conn.query<any[]>("SELECT * FROM GeneratedContent");
  for (const g of contents) {
    await pg.generatedContent.upsert({
      where: { id: g.id },
      update: {},
      create: {
        id: g.id,
        campaignId: g.campaignId,
        rawSpin: g.rawSpin,
        resolvedText: g.resolvedText,
        variantIndex: g.variantIndex,
        status: g.status,
      },
    });
  }
  console.log("GeneratedContent:", contents.length);

  await conn.end();
  console.log("CRM → Postgres migrate done");
  void idMap;
  void randomUUID;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pg.$disconnect();
  });
