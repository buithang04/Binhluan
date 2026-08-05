/**
 * Test MAPS proxy gate giống worker:
 * Chrome --proxy-server + page.authenticate → ipify exit IP ≠ IP máy
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer");
const { PrismaClient } = require("@prisma/client");
const { decryptSecret } = require("../packages/crypto/dist/index.js");

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  process.env[k] = v;
}

const prisma = new PrismaClient();

async function getDirectIp() {
  const res = await fetch("https://api.ipify.org?format=json", {
    signal: AbortSignal.timeout(15000),
  });
  return (await res.json()).ip;
}

async function testOneChromeGate(proxy, directIp) {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `hp-gate-${proxy.port}-`),
  );
  const proxyServer = `http://${proxy.host}:${proxy.port}`;
  let browser;
  const started = Date.now();
  try {
    browser = await puppeteer.launch({
      headless: true,
      channel: "chrome",
      userDataDir,
      args: [
        `--proxy-server=${proxyServer}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--window-size=900,700",
      ],
    });
    const page = await browser.newPage();
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
    await page.goto("https://api.ipify.org?format=json", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const body = await page.evaluate(() => document.body?.innerText || "");
    const m = body.match(/"ip"\s*:\s*"([^"]+)"/);
    const exitIp = m?.[1] || "";
    if (!exitIp) {
      return {
        ok: false,
        exitIp: null,
        ms: Date.now() - started,
        error: `no ip body=${body.slice(0, 80)}`,
      };
    }
    if (exitIp === directIp) {
      return {
        ok: false,
        exitIp,
        ms: Date.now() - started,
        error: "exit IP = machine IP",
      };
    }
    // Thử mở Google Maps homepage qua proxy (không đăng review)
    let mapsOk = false;
    let mapsErr = null;
    try {
      const resp = await page.goto("https://www.google.com/maps", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      mapsOk = Boolean(resp && resp.status() < 400);
      if (!mapsOk) mapsErr = `status ${resp?.status()}`;
    } catch (e) {
      mapsErr = e instanceof Error ? e.message : String(e);
    }
    return {
      ok: true,
      exitIp,
      mapsOk,
      mapsErr,
      ms: Date.now() - started,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      exitIp: null,
      mapsOk: false,
      mapsErr: null,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const limit = Number(process.argv[2] || 3);
  const directIp = await getDirectIp();
  console.log("Machine IP:", directIp);
  console.log(`Chrome+CDP gate test — ${limit} proxy(s)\n`);

  const rows = await prisma.proxy.findMany({
    where: {
      status: "ACTIVE",
      health: "WORKING",
      note: { startsWith: "homeproxy:" },
    },
    orderBy: { host: "asc" },
    take: limit,
  });

  if (!rows.length) throw new Error("Không có HomeProxy ACTIVE trong DB");

  const results = [];
  for (const row of rows) {
    const username = row.usernameEnc
      ? decryptSecret(Buffer.from(row.usernameEnc))
      : null;
    const password = row.passwordEnc
      ? decryptSecret(Buffer.from(row.passwordEnc))
      : null;
    const label = `${row.host}:${row.port}`;
    process.stdout.write(`→ ${label} … `);
    if (!username || !password) {
      console.log("FAIL missing creds");
      results.push({ host: label, ok: false, error: "missing creds" });
      continue;
    }
    const r = await testOneChromeGate(
      {
        host: row.host,
        port: row.port,
        username,
        password,
      },
      directIp,
    );
    if (r.ok) {
      console.log(
        `OK exit=${r.exitIp} maps=${r.mapsOk ? "OK" : "FAIL:" + r.mapsErr} ${r.ms}ms`,
      );
    } else {
      console.log(`FAIL ${r.error} ${r.ms}ms`);
    }
    results.push({ host: label, ...r });
  }

  const ok = results.filter((x) => x.ok && x.mapsOk !== false).length;
  // mapsOk false still counts gate ok if exit IP ok — report separately
  const gateOk = results.filter((x) => x.ok).length;
  const mapsOk = results.filter((x) => x.mapsOk).length;
  console.log("\nSummary:", {
    gateOk,
    mapsOk,
    fail: results.length - gateOk,
    total: results.length,
    directIp,
  });
  if (gateOk < results.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
