/** Parse cURL + JSON path helpers for configurable proxy import. */

export type ProxyImportConfig = {
  name: string;
  curl: string;
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body: string | null;
  listPath: string;
  hostPath: string;
  portPath: string;
  usernamePath: string;
  passwordPath: string;
  protocolPath: string;
  countryPath: string;
  cityPath: string;
  idPath: string;
  filterPath: string;
  filterEquals: string;
  notePrefix: string;
  pageParam: string;
  limitParam: string;
  hasNextPath: string;
  disableOthers: boolean;
  onlyValidPath: string;
  onlyValidEquals: string;
};

export const PROXY_IMPORT_SETTING_KEY = "proxy_provider_import";

/** Build readable multi-line curl (no trailing backslashes). */
export function buildCurl(config: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}): string {
  const method = (config.method || "GET").toUpperCase();
  const lines: string[] = [`curl -X ${method} "${config.url}"`];
  for (const [k, v] of Object.entries(config.headers || {})) {
    if (!k) continue;
    lines.push(`  -H "${k}: ${v}"`);
  }
  if (config.body && method !== "GET") {
    const escaped = config.body.replace(/"/g, '\\"');
    lines.push(`  -d "${escaped}"`);
  }
  return lines.join("\n");
}

function withBuiltCurl(config: ProxyImportConfig): ProxyImportConfig {
  return { ...config, curl: buildCurl(config) };
}

export const HOMEPROXY_PRESET: ProxyImportConfig = withBuiltCurl({
  name: "HomeProxy (tĩnh)",
  curl: "",
  method: "GET",
  url: "https://api.homeproxy.vn/api/v1/users/proxies?page=1&limit=100",
  headers: {
    Authorization: "Bearer YOUR_TOKEN",
    "x-merchant-id": "YOUR_MERCHANT_ID",
    Accept: "application/json",
  },
  body: null,
  listPath: "data",
  hostPath: "proxy.ipaddress.domain|proxy.ipaddress.ip",
  portPath: "proxy.port",
  usernamePath: "proxy.username",
  passwordPath: "proxy.password",
  protocolPath: "protocol|proxy.protocol",
  countryPath: "",
  cityPath: "proxy.ipaddress.location",
  idPath: "code|proxy.id",
  filterPath: "proxy.ipaddress.categorytype.slug",
  filterEquals: "static",
  notePrefix: "homeproxy",
  pageParam: "page",
  limitParam: "limit",
  hasNextPath: "hasNextPage",
  disableOthers: true,
  onlyValidPath: "",
  onlyValidEquals: "",
});

export const WEBSHARE_PRESET: ProxyImportConfig = withBuiltCurl({
  name: "Webshare",
  curl: "",
  method: "GET",
  url: "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100",
  headers: {
    Authorization: "Token YOUR_TOKEN",
  },
  body: null,
  listPath: "results",
  hostPath: "proxy_address",
  portPath: "port",
  usernamePath: "username",
  passwordPath: "password",
  protocolPath: "",
  countryPath: "country_code",
  cityPath: "city_name",
  idPath: "id",
  filterPath: "",
  filterEquals: "",
  notePrefix: "webshare",
  pageParam: "page",
  limitParam: "page_size",
  hasNextPath: "next",
  disableOthers: false,
  onlyValidPath: "valid",
  onlyValidEquals: "true",
});

/** Fill YOUR_TOKEN / YOUR_MERCHANT_ID from env when still placeholders. */
export function fillSecretsFromEnv(config: ProxyImportConfig): ProxyImportConfig {
  const headers = { ...(config.headers || {}) };
  const auth = headers.Authorization || headers.authorization || "";
  const hpToken = (process.env.HOMEPROXY_API_TOKEN || "").trim();
  const hpMid = (process.env.HOMEPROXY_MERCHANT_ID || "").trim();
  const wsToken = (process.env.WEBSHARE_API_TOKEN || "").trim();

  if (/YOUR_TOKEN/i.test(auth) || /Bearer\s*$/i.test(auth)) {
    if (/homeproxy|api\.homeproxy/i.test(config.url) && hpToken) {
      headers.Authorization = `Bearer ${hpToken}`;
    } else if (/webshare/i.test(config.url) && wsToken) {
      headers.Authorization = `Token ${wsToken}`;
    } else if (hpToken) {
      headers.Authorization = `Bearer ${hpToken}`;
    } else if (wsToken) {
      headers.Authorization = `Token ${wsToken}`;
    }
  }

  const midKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "x-merchant-id",
  );
  if (midKey && /YOUR_MERCHANT/i.test(headers[midKey] || "") && hpMid) {
    headers[midKey] = hpMid;
  } else if (!midKey && hpMid && /homeproxy/i.test(config.url)) {
    headers["x-merchant-id"] = hpMid;
  }

  const next = { ...config, headers };
  return withBuiltCurl(next);
}

export function getByPath(obj: unknown, path: string): unknown {
  if (!path?.trim()) return undefined;
  for (const alt of path.split("|").map((s) => s.trim()).filter(Boolean)) {
    let cur: unknown = obj;
    let ok = true;
    for (const key of alt.split(".").filter(Boolean)) {
      if (cur == null || typeof cur !== "object") {
        ok = false;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return undefined;
}

export function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** Parse a curl command into method/url/headers/body. */
export function parseCurlCommand(raw: string): {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body: string | null;
} {
  const text = String(raw || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    throw new Error("cURL trống");
  }

  let method: "GET" | "POST" | "PUT" = "GET";
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let url = "";

  const methodM =
    text.match(/\s-X\s+([A-Za-z]+)/i) || text.match(/\s--request\s+([A-Za-z]+)/i);
  if (methodM) {
    const m = methodM[1]!.toUpperCase();
    if (m === "POST" || m === "PUT" || m === "GET") method = m;
  }

  const headerRe = /(?:-H|--header)\s+(['"])(.*?)\1/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headerRe.exec(text))) {
    const line = hm[2] || "";
    const colon = line.indexOf(":");
    if (colon > 0) {
      const k = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      if (k) headers[k] = v;
    }
  }

  // Also support unquoted -H Key: Value (rare)
  const headerBare =
    /(?:-H|--header)\s+([A-Za-z0-9\-]+)\s*:\s*([^\s-][^\s]*(?:\s+[^\s-]+)*)/gi;
  let hb: RegExpExecArray | null;
  while ((hb = headerBare.exec(text))) {
    const k = hb[1]?.trim();
    const v = hb[2]?.trim();
    if (k && v && !headers[k]) headers[k] = v;
  }

  const dataM =
    text.match(/(?:-d|--data|--data-raw|--data-binary)\s+(['"])([\s\S]*?)\1/i) ||
    text.match(/(?:-d|--data)\s+(\S+)/i);
  if (dataM) {
    body = dataM[2] ?? dataM[1] ?? null;
    if (method === "GET") method = "POST";
  }

  const urlM =
    text.match(/curl(?:\.exe)?\s+(?:-[^\s]+\s+)*['"]?(https?:\/\/[^'"\s]+)['"]?/i) ||
    text.match(/['"](https?:\/\/[^'"]+)['"]/i) ||
    text.match(/(https?:\/\/\S+)/i);
  if (urlM) url = urlM[1]!.replace(/[\\]+$/, "");

  if (!url) throw new Error("Không tìm thấy URL trong cURL");

  return { method, url, headers, body };
}

export function applyCurlToConfig(
  config: ProxyImportConfig,
  curl: string,
): ProxyImportConfig {
  const parsed = parseCurlCommand(curl);
  return withBuiltCurl({
    ...config,
    method: parsed.method,
    url: parsed.url,
    headers: { ...config.headers, ...parsed.headers },
    body: parsed.body,
  });
}

export function maskHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (
      key.includes("authorization") ||
      key.includes("token") ||
      key.includes("api-key") ||
      key.includes("x-api")
    ) {
      const t = String(v || "");
      // Keep scheme, mask secret
      const m = t.match(/^(Bearer|Token)\s+(.+)$/i);
      if (m) {
        const secret = m[2]!;
        out[k] =
          secret.length > 8
            ? `${m[1]} ${secret.slice(0, 6)}…${secret.slice(-4)}`
            : `${m[1]} ••••`;
      } else {
        out[k] =
          t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t ? "••••" : "";
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export { withBuiltCurl };
