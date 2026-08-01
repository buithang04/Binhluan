import "server-only";
import { prisma } from "@/lib/prisma";
import { loginIssueMessage } from "@/lib/review-errors";

export type ProfileForReview = {
  id: string;
  status: string;
  browserAlive: boolean;
  leaseUntil: Date | null;
  currentTask: string | null;
  account: {
    status: string;
    email: string;
    loginIssue: string | null;
  };
};

/** Proxy ACTIVE + WORKING, không lock/cooldown. */
export async function countAvailableProxies(now = new Date()) {
  return prisma.proxy.count({
    where: {
      status: "ACTIVE",
      health: "WORKING",
      AND: [
        { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        { OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: now } }] },
      ],
    },
  });
}

/**
 * Account/profile chưa READY → cần mở Chrome như luồng thêm mail (LOGIN),
 * để nhìn thấy captcha/verify và hoàn tất đăng nhập.
 */
export function needsBrowserLoginOpen(
  profile: ProfileForReview | null,
): { open: true; email: string; reason: string } | { open: false } {
  if (!profile) return { open: false };

  const email = profile.account.email;
  if (profile.status === "DISABLED" || profile.status === "ERROR") {
    return { open: false };
  }
  if (
    profile.account.status === "DISABLED" ||
    profile.account.status === "ERROR"
  ) {
    return { open: false };
  }

  // Đang LOGIN → vẫn mở/focus để user thấy cửa sổ
  if (
    (profile.status === "QUEUED" || profile.status === "RUNNING") &&
    profile.currentTask === "LOGIN"
  ) {
    return {
      open: true,
      email,
      reason: "đang đăng nhập — đã đưa Chrome lên màn hình",
    };
  }

  // Job khác đang chạy → không xen LOGIN
  if (profile.status === "QUEUED" || profile.status === "RUNNING") {
    return { open: false };
  }

  const loginErr = loginIssueMessage(profile.account.loginIssue);
  if (loginErr) {
    return {
      open: true,
      email,
      reason: `${loginErr} — đã mở Chrome để xử lý`,
    };
  }

  if (profile.account.status !== "READY") {
    return {
      open: true,
      email,
      reason: `account ${profile.account.status} — đã mở Chrome đăng nhập như thêm mail`,
    };
  }

  if (profile.status !== "READY") {
    return {
      open: true,
      email,
      reason: `profile ${profile.status} — đã mở Chrome đăng nhập như thêm mail`,
    };
  }

  return { open: false };
}

export function validateProfileForReview(
  profile: ProfileForReview | null,
  now = new Date(),
): { ok: true } | { ok: false; error: string } {
  if (!profile) {
    return { ok: false, error: "Không tìm thấy profile automation cho account này" };
  }

  const email = profile.account.email;
  const loginErr = loginIssueMessage(profile.account.loginIssue);
  if (loginErr) {
    return { ok: false, error: `${loginErr} (${email})` };
  }

  if (profile.status === "DISABLED" || profile.status === "ERROR") {
    return {
      ok: false,
      error: `Account ${email} bị vô hiệu hóa hoặc lỗi (${profile.status})`,
    };
  }

  if (profile.status === "QUEUED" || profile.status === "RUNNING") {
    return {
      ok: false,
      error: `Account ${email} đang chạy job khác (${profile.currentTask || profile.status})`,
    };
  }

  if (profile.account.status !== "READY") {
    return {
      ok: false,
      error: `Account ${email} chưa READY (trạng thái: ${profile.account.status})`,
    };
  }

  if (profile.status !== "READY") {
    return {
      ok: false,
      error: `Profile ${email} chưa READY (trạng thái: ${profile.status})`,
    };
  }

  if (profile.leaseUntil && profile.leaseUntil > now) {
    return {
      ok: false,
      error: `Account ${email} đang bị lock bởi job khác — thử lại sau`,
    };
  }

  // Chrome đóng: MAPS_REVIEW sẽ tự launch — không bắt mở tay trên Admin
  return { ok: true };
}

export async function getReviewInfraWarnings(now = new Date()) {
  const warnings: { id: string; message: string; severity: "warn" | "error" }[] = [];

  const [proxyCount, readyNoBrowser] = await Promise.all([
    countAvailableProxies(now),
    prisma.profile.count({
      where: {
        status: "READY",
        browserAlive: false,
        account: { status: "READY" },
      },
    }),
  ]);

  if (proxyCount === 0) {
    warnings.push({
      id: "no-proxy",
      severity: "error",
      message:
        "Không còn proxy khả dụng (ACTIVE + WORKING, hết lock/cooldown) — thêm proxy hoặc chờ cooldown trước khi đăng",
    });
  } else if (proxyCount < 3) {
    warnings.push({
      id: "low-proxy",
      severity: "warn",
      message: `Chỉ còn ${proxyCount} proxy khả dụng — nhiều bài đăng cùng lúc có thể phải chờ`,
    });
  }

  if (readyNoBrowser > 0) {
    /* Chrome đóng vẫn OK — worker MAPS tự mở; không cảnh báo trên UI kế hoạch. */
  }

  return { warnings, proxyCount, readyNoBrowser };
}
