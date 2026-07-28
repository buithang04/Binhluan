import type { NextConfig } from "next";

/** Internal Nest URL — set APM_API_URL in .env (không lộ ra browser). */
const APM = (process.env.APM_API_URL || "http://127.0.0.1:4000/api").replace(/\/$/, "");

/** LAN dev: tránh cảnh báo cross-origin + chậm HMR từ máy khác cùng Wi‑Fi */
function devAllowedOrigins(): string[] | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  const raw = process.env.LAN_APP_URL?.trim() || process.env.APP_URL?.trim() || "";
  if (!raw) return undefined;
  try {
    const { hostname } = new URL(raw);
    if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
      return [hostname];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

const allowedDevOrigins = devAllowedOrigins();

/**
 * Worker giữ hàng chục nghìn file Chrome profile trong repo và ghi liên tục.
 * Không loại khỏi watcher thì dev server recompile mỗi vài giây → chuyển trang rất lâu.
 */
const WATCH_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/automation-profile-manager/**",
  "**/uploads/**",
];

const nextConfig: NextConfig = {
  ...(allowedDevOrigins ? { allowedDevOrigins } : {}),
  serverExternalPackages: ["puppeteer", "@prisma/client", "prisma"],
  experimental: {
    optimizePackageImports: ["next-auth/react"],
  },
  outputFileTracingExcludes: {
    "*": ["automation-profile-manager/**", "uploads/**"],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: WATCH_IGNORED,
        aggregateTimeout: 300,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/projects", destination: "/app", permanent: false },
      { source: "/projects/:path*", destination: "/app/projects/:path*", permanent: false },
      { source: "/accounts", destination: "/admin/accounts", permanent: false },
      { source: "/proxies", destination: "/admin/proxies", permanent: false },
      { source: "/profiles", destination: "/admin/profiles", permanent: false },
      { source: "/jobs", destination: "/admin/jobs", permanent: false },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/apm-api/:path*",
        destination: `${APM}/:path*`,
      },
    ];
  },
};

export default nextConfig;
