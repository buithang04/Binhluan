import { z } from "zod";

export const QUEUE_PROFILE_TASKS = "profile-tasks";
/** Lệnh nhẹ (focus cửa sổ…) — không chiếm lease / không đổi READY. */
export const QUEUE_BROWSER_CONTROL = "browser-control";

export type BrowserControlJob = {
  type: "focus";
  profileId: string;
};

export const Role = {
  ADMIN: "ADMIN",
  USER: "USER",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AccountStatus = {
  UNREADY: "UNREADY",
  READY: "READY",
  RUNNING: "RUNNING",
  ERROR: "ERROR",
  DISABLED: "DISABLED",
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ProxyStatus = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;
export type ProxyStatus = (typeof ProxyStatus)[keyof typeof ProxyStatus];

export const ProfileStatus = {
  UNREADY: "UNREADY",
  READY: "READY",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  ERROR: "ERROR",
  DISABLED: "DISABLED",
} as const;
export type ProfileStatus = (typeof ProfileStatus)[keyof typeof ProfileStatus];

export const JobStatus = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DEAD: "DEAD",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const TaskCode = {
  LOGIN: "LOGIN",
  HEALTHCHECK: "HEALTHCHECK",
  BROWSER_CHECK: "BROWSER_CHECK",
  MAPS_REVIEW: "MAPS_REVIEW",
  /** Xóa review đã đăng trên Maps (đúng account đã post). */
  MAPS_DELETE_REVIEW: "MAPS_DELETE_REVIEW",
  /** Đổi tên / avatar / địa chỉ trên myaccount.google.com. */
  ACCOUNT_PROFILE_UPDATE: "ACCOUNT_PROFILE_UPDATE",
  /** Quét tên + avatar thực tế từ myaccount.google.com. */
  SCAN_GOOGLE_PROFILE: "SCAN_GOOGLE_PROFILE",
} as const;

export const ProfileSyncStatus = {
  PENDING: "PENDING",
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  NEEDS_MANUAL: "NEEDS_MANUAL",
  FAILED: "FAILED",
} as const;
export type ProfileSyncStatus =
  (typeof ProfileSyncStatus)[keyof typeof ProfileSyncStatus];
export type TaskCode = (typeof TaskCode)[keyof typeof TaskCode];

export const mapsReviewPayloadSchema = z.object({
  placeUrl: z.string().min(10).max(2000),
  rating: z.number().int().min(1).max(5),
  reviewText: z.string().min(1).max(4000),
  imagePath: z.string().min(1).max(1000).optional().nullable(),
  /** Nhiều ảnh (1–3) — ưu tiên hơn imagePath */
  imagePaths: z.array(z.string().min(1).max(1000)).max(10).optional().nullable(),
  /** Liên kết ngược assignment (Next CRM). */
  assignmentId: z.string().uuid().optional().nullable(),
});
export type MapsReviewPayload = z.infer<typeof mapsReviewPayloadSchema>;

export const mapsDeleteReviewPayloadSchema = z.object({
  assignmentId: z.string().uuid(),
  placeUrl: z.string().min(10).max(2000),
  reviewText: z.string().max(4000).optional().nullable(),
  reviewLink: z.string().max(2000).optional().nullable(),
  stars: z.number().int().min(1).max(5).optional().nullable(),
});
export type MapsDeleteReviewPayload = z.infer<
  typeof mapsDeleteReviewPayloadSchema
>;

export const accountProfileUpdatePayloadSchema = z.object({
  accountId: z.string().uuid(),
  desiredName: z.string().max(200).optional().nullable(),
  desiredAddress: z.string().max(500).optional().nullable(),
  /** Path tuyệt đối hoặc tương đối tới file avatar đã chuẩn hóa. */
  avatarLocalPath: z.string().max(1000).optional().nullable(),
  /** Cập nhật từng phần — mặc định cả 3 nếu có dữ liệu. */
  updateName: z.boolean().optional(),
  updateAvatar: z.boolean().optional(),
  updateAddress: z.boolean().optional(),
});
export type AccountProfileUpdatePayload = z.infer<
  typeof accountProfileUpdatePayloadSchema
>;

/** Payload cho SCAN_GOOGLE_PROFILE — chỉ cần accountId để update lại DB. */
export const scanGoogleProfilePayloadSchema = z.object({
  accountId: z.string().uuid(),
});
export type ScanGoogleProfilePayload = z.infer<
  typeof scanGoogleProfilePayloadSchema
>;

export type ProfileTaskJob = {
  profileId: string;
  taskCode: TaskCode;
  leaseToken: string;
  jobRunId: string;
  payload?:
    | MapsReviewPayload
    | MapsDeleteReviewPayload
    | AccountProfileUpdatePayload
    | ScanGoogleProfilePayload
    | Record<string, unknown>
    | null;
};

export const createAccountSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  recoveryEmail: z.string().email().optional().nullable(),
  recoveryPhone: z.string().optional().nullable(),
  /** Secret TOTP (Google Authenticator) — chấp nhận có khoảng trắng; để trống = không 2FA. */
  totpSecret: z
    .string()
    .optional()
    .nullable()
    .transform((v) => {
      if (v == null) return null;
      const n = normalizeTotpSecret(v);
      return n || null;
    })
    .refine((v) => v == null || v.length >= 16, {
      message: "Mã 2FA (TOTP secret) quá ngắn — dán full secret từ Authenticator",
    }),
  status: z.enum(["UNREADY", "READY"]).optional(),
});

/** Chuẩn hóa secret TOTP: bỏ khoảng trắng/gạch, uppercase; hỗ trợ otpauth:// URI. */
export function normalizeTotpSecret(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  const fromUri = s.match(/[?&]secret=([A-Za-z2-7]+)/i);
  if (fromUri?.[1]) s = fromUri[1];
  // Chỉ giữ Base32 (A–Z, 2–7) — bỏ ký tự lạ khi copy từ Excel/chat
  return s
    .replace(/[\s\-]+/g, "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}
export const createProxySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  protocol: z.enum(["http", "https", "socks5"]).default("http"),
  country: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  maxProfiles: z.number().int().min(1).max(1000).default(10),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  health: z.enum(["WORKING", "FAILED", "UNKNOWN"]).optional(),
});

export const createProfileSchema = z.object({
  accountId: z.string().uuid(),
  /** Optional — mail/profile không gắn sticky proxy; proxy lấy random lúc chạy job. */
  proxyId: z.string().uuid().optional().nullable(),
  cooldownMinutes: z.number().int().min(1).max(10080).default(60),
  timezone: z.string().optional().nullable(),
  language: z.string().optional().nullable(),
  userAgent: z.string().optional().nullable(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .nullable(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Server/worker login — không tăng sessionVersion (không đá Admin trên trình duyệt). */
  service: z.boolean().optional(),
});

export const enqueueTaskSchema = z.object({
  taskCode: z
    .enum([
      "LOGIN",
      "HEALTHCHECK",
      "BROWSER_CHECK",
      "MAPS_REVIEW",
      "MAPS_DELETE_REVIEW",
      "ACCOUNT_PROFILE_UPDATE",
      "SCAN_GOOGLE_PROFILE",
    ])
    .default("HEALTHCHECK"),
  /** Validate theo task trong ProfilesService.enqueue */
  payload: z.unknown().optional().nullable(),
});
