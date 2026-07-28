#!/usr/bin/env node
/**
 * Sync APM root .env into apps and packages/prisma.
 * Also mirror public APP_URL from monorepo root `.env` → WEB_ORIGIN / APP_URL
 * so deploy only needs to set APP_URL (and NEXTAUTH_URL) once at repo root.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(root, "..");
const src = path.join(root, ".env");
if (!fs.existsSync(src)) {
  console.error("Missing .env at", src);
  process.exit(1);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function upsertEnvLine(text, key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, "");
  }
}

let content = fs.readFileSync(src, "utf8");
const apmEnv = parseEnv(content);

// Prefer LAN_APP_URL (if set) then monorepo root APP_URL / NEXTAUTH_URL.
// This avoids remote devices being redirected to localhost in LAN testing.
const rootEnvPath = path.join(monorepoRoot, ".env");
let publicUrl = apmEnv.APP_URL || apmEnv.WEB_ORIGIN?.split(",")[0]?.trim() || "";
if (fs.existsSync(rootEnvPath)) {
  const rootEnv = parseEnv(fs.readFileSync(rootEnvPath, "utf8"));
  publicUrl =
    rootEnv.LAN_APP_URL ||
    process.env.LAN_APP_URL ||
    rootEnv.APP_URL ||
    rootEnv.NEXTAUTH_URL ||
    publicUrl;
}

if (publicUrl) {
  const origin = originOf(publicUrl);
  content = upsertEnvLine(content, "APP_URL", origin);
  // Keep local origins for dev convenience + any existing explicit extras.
  const extras = (apmEnv.WEB_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && originOf(s) !== origin);
  const localDevOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
  const webOrigin = [...new Set([origin, ...localDevOrigins, ...extras])].join(",");
  content = upsertEnvLine(content, "WEB_ORIGIN", webOrigin);
  fs.writeFileSync(src, content);
  console.log(`mirrored public URL → APP_URL/WEB_ORIGIN = ${origin}`);

  // Keep NextAuth URL in sync with APP_URL at monorepo root
  if (fs.existsSync(rootEnvPath)) {
    let rootText = fs.readFileSync(rootEnvPath, "utf8");
    rootText = upsertEnvLine(rootText, "APP_URL", origin);
    rootText = upsertEnvLine(rootText, "NEXTAUTH_URL", origin);
    fs.writeFileSync(rootEnvPath, rootText);
    console.log(`synced root APP_URL + NEXTAUTH_URL = ${origin}`);
  }
}

const targets = [
  "apps/api/.env",
  "apps/worker/.env",
  "apps/web/.env",
  "apps/scheduler/.env",
  "packages/prisma/.env",
];
for (const t of targets) {
  const dest = path.join(root, t);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("synced", t);
}
