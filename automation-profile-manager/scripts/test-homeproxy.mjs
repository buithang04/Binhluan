import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

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

function getDirectIp() {
  return new Promise((resolve, reject) => {
    https
      .get("https://api.ipify.org?format=json", { timeout: 15000 }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).ip);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function testViaProxyAgent({ host, port, user, pass }) {
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  const agent = new HttpsProxyAgent(proxyUrl);
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.ipify.org?format=json",
      { agent, timeout: 25000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let ip = null;
          try {
            ip = JSON.parse(body).ip;
          } catch {
            ip = body.slice(0, 80);
          }
          resolve({
            ok: res.statusCode === 200 && Boolean(ip),
            status: res.statusCode,
            exitIp: ip,
            ms: Date.now() - started,
            error: null,
            via: "https-proxy-agent",
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        status: null,
        exitIp: null,
        ms: Date.now() - started,
        error: "timeout",
        via: "https-proxy-agent",
      });
    });
    req.on("error", (e) => {
      resolve({
        ok: false,
        status: null,
        exitIp: null,
        ms: Date.now() - started,
        error: e.message,
        via: "https-proxy-agent",
      });
    });
  });
}

function testViaCurl({ host, port, user, pass }) {
  const started = Date.now();
  const proxy = `http://${user}:${pass}@${host}:${port}`;
  const r = spawnSync(
    "curl.exe",
    [
      "-sS",
      "-m",
      "25",
      "-x",
      proxy,
      "https://api.ipify.org?format=json",
    ],
    { encoding: "utf8" },
  );
  const ms = Date.now() - started;
  if (r.status !== 0) {
    return {
      ok: false,
      status: null,
      exitIp: null,
      ms,
      error: (r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 200),
      via: "curl",
    };
  }
  try {
    const ip = JSON.parse(r.stdout).ip;
    return { ok: Boolean(ip), status: 200, exitIp: ip, ms, error: null, via: "curl" };
  } catch {
    return {
      ok: false,
      status: null,
      exitIp: null,
      ms,
      error: `bad body: ${r.stdout.slice(0, 120)}`,
      via: "curl",
    };
  }
}

async function main() {
  loadEnv(path.join(root, ".env"));
  const token = process.env.HOMEPROXY_API_TOKEN?.trim();
  const merchantId = process.env.HOMEPROXY_MERCHANT_ID?.trim();
  if (!token) throw new Error("missing HOMEPROXY_API_TOKEN");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (merchantId) headers["x-merchant-id"] = merchantId;

  const listRes = await fetch(
    "https://api.homeproxy.vn/api/v1/users/proxies?page=1&limit=100",
    { headers },
  );
  if (!listRes.ok) {
    throw new Error(`list ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
  }
  const list = await listRes.json();
  const proxies = (list.data || [])
    .filter((r) => (r.proxy?.ipaddress?.categorytype?.slug || "") === "static")
    .slice(0, 20)
    .map((r) => ({
      code: r.code,
      host: r.proxy.ipaddress.domain || r.proxy.ipaddress.ip,
      expectedIp: r.proxy.ipaddress.ip,
      port: r.proxy.port,
      user: r.proxy.username,
      pass: String(r.proxy.password),
      city: r.proxy.ipaddress.location,
      provider: r.proxy.ipaddress.provider,
    }));

  console.log(`Testing ${proxies.length} HomeProxy static proxies…`);
  let directIp;
  try {
    directIp = await getDirectIp();
  } catch (e) {
    directIp = `ERR:${e.message}`;
  }
  console.log("Machine direct IP:", directIp);
  console.log("");

  const results = [];
  for (const p of proxies) {
    process.stdout.write(`→ ${p.code} ${p.host}:${p.port} (${p.city}/${p.provider}) … `);
    let r = await testViaProxyAgent(p);
    if (!r.ok) {
      const r2 = testViaCurl(p);
      if (r2.ok || !r.error) r = r2;
      else r = { ...r2, error: `${r.error} | curl: ${r2.error}` };
    }
    const sameAsMachine =
      r.ok &&
      directIp &&
      !String(directIp).startsWith("ERR") &&
      r.exitIp === directIp;
    if (r.ok && !sameAsMachine) {
      const note =
        p.expectedIp && r.exitIp !== p.expectedIp
          ? ` listed=${p.expectedIp}`
          : "";
      console.log(`OK exit=${r.exitIp} ${r.ms}ms via=${r.via}${note}`);
    } else if (r.ok && sameAsMachine) {
      console.log(`FAIL leaked machine IP ${r.exitIp} ${r.ms}ms`);
      r.ok = false;
      r.error = "exit IP = machine IP (proxy not applied)";
    } else {
      console.log(`FAIL ${r.error || r.status} ${r.ms}ms`);
    }
    results.push({
      code: p.code,
      host: `${p.host}:${p.port}`,
      city: p.city,
      ok: r.ok,
      exitIp: r.exitIp,
      expectedIp: p.expectedIp,
      ms: r.ms,
      error: r.error,
    });
  }

  const ok = results.filter((x) => x.ok).length;
  const fail = results.length - ok;
  console.log("\nSummary:", { ok, fail, total: results.length, directIp });
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
