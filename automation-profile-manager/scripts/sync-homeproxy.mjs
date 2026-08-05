/**
 * One-shot: sync HomeProxy static proxies into DB.
 * Usage: node scripts/sync-homeproxy.mjs
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const prisma = new PrismaClient();

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

function encryptSecret(plain) {
  const raw = process.env.ENCRYPTION_KEY || "";
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, enc]));
}

async function main() {
  loadEnv(path.join(root, ".env"));

  const token = process.env.HOMEPROXY_API_TOKEN?.trim();
  const merchantId = process.env.HOMEPROXY_MERCHANT_ID?.trim();
  if (!token) throw new Error("missing HOMEPROXY_API_TOKEN");

  const base = (
    process.env.HOMEPROXY_API_BASE || "https://api.homeproxy.vn/api/v1"
  ).replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (merchantId) headers["x-merchant-id"] = merchantId;

  let page = 1;
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  while (page <= 50) {
    const url = `${base}/users/proxies?page=${page}&limit=100`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const rows = data.data || [];
    if (!rows.length) break;

    for (const item of rows) {
      const p = item.proxy;
      if (!p) {
        skipped++;
        continue;
      }
      const slug = (p.ipaddress?.categorytype?.slug || "").toLowerCase();
      if (slug !== "static" && !slug.includes("tinh")) {
        skipped++;
        continue;
      }
      const host = (p.ipaddress?.domain || p.ipaddress?.ip || "").trim();
      const port = Number(p.port);
      if (!host || !port) {
        skipped++;
        continue;
      }
      const noteId = item.code || p.id || `${host}:${port}`;
      const payload = {
        protocol: "http",
        country: "VN",
        city: p.ipaddress?.location || null,
        note: `homeproxy:${noteId}${
          p.ipaddress?.provider ? `:${p.ipaddress.provider}` : ""
        }`,
        maxProfiles: 10,
        status: "ACTIVE",
        health: "WORKING",
        lastCheckedAt: new Date(),
        usernameEnc: p.username ? encryptSecret(p.username) : null,
        passwordEnc: p.password ? encryptSecret(String(p.password)) : null,
      };
      const existing = await prisma.proxy.findUnique({
        where: { host_port: { host, port } },
      });
      if (existing) {
        await prisma.proxy.update({ where: { id: existing.id }, data: payload });
        updated++;
      } else {
        await prisma.proxy.create({ data: { host, port, ...payload } });
        imported++;
      }
    }
    if (!data.hasNextPage) break;
    page++;
  }

  const disabled = await prisma.proxy.updateMany({
    where: {
      status: "ACTIVE",
      OR: [{ note: { startsWith: "webshare:" } }, { note: "webshare" }],
    },
    data: { status: "DISABLED" },
  });

  const active = await prisma.proxy.findMany({
    where: { status: "ACTIVE", note: { startsWith: "homeproxy:" } },
    select: { host: true, port: true, city: true, note: true },
    orderBy: { host: "asc" },
  });

  console.log(
    JSON.stringify(
      {
        imported,
        updated,
        skipped,
        disabledWebshare: disabled.count,
        activeHomeproxy: active.length,
        sample: active.slice(0, 3),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
