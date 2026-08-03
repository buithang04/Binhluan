const VN_TZ = "Asia/Ho_Chi_Minh";
const DAY_MS = 86_400_000;

/** Bài đầu không sớm hơn now + lead (mặc định 15 phút). */
export const SCHEDULE_MIN_LEAD_MS = 15 * 60_000;
/** Khoảng cách tối thiểu giữa 2 mốc lịch liên tiếp (mặc định 15 phút). */
export const SCHEDULE_MIN_SLOT_GAP_MS = 15 * 60_000;

/** YYYY-MM-DD theo lịch VN. */
export function vnCalendarDateString(value = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD (lịch dân dụng). */
export function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Ngày sớm nhất được chọn: hôm nay (VN) — không chọn ngày đã qua. */
export function vnMinCampaignStartDate(now = new Date()): string {
  return vnCalendarDateString(now);
}

/** true khi hôm nay (VN) đã qua ngày kết thúc chiến dịch trong gói. */
export function isCampaignEndDatePassed(
  endAt: Date | string,
  now = new Date(),
): boolean {
  const endYmd =
    typeof endAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endAt.trim())
      ? endAt.trim()
      : vnCalendarDateString(typeof endAt === "string" ? new Date(endAt) : endAt);
  return vnCalendarDateString(now) > endYmd;
}

export function campaignEndDatePassedMessage(endAt: Date | string): string {
  const endYmd =
    typeof endAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endAt.trim())
      ? endAt.trim()
      : vnCalendarDateString(typeof endAt === "string" ? new Date(endAt) : endAt);
  return `Chiến dịch đã hết hạn (kết thúc ${endYmdDisplay(endYmd)}) — gia hạn ngày kết thúc trên dự án rồi lập kế hoạch lại`;
}

function endYmdDisplay(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

/** Đầu ngày theo lịch VN (UTC instant). */
function startOfVnDay(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return Date.UTC(y, m - 1, d) - 7 * 60 * 60 * 1000;
}

/**
 * Đẩy mọi mốc lịch trước `notBefore + lead` lên; các mốc liên tiếp cách nhau ≥ gap.
 * Giữ thứ tự tăng dần.
 */
export function clampScheduleNotBefore(
  times: Date[],
  notBefore: Date,
  minStepMs = SCHEDULE_MIN_SLOT_GAP_MS,
  leadMs = SCHEDULE_MIN_LEAD_MS,
): Date[] {
  if (!times.length) return times;
  const out = times
    .map((t) => new Date(t.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  let cursor = notBefore.getTime() + leadMs;
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.getTime() < cursor) {
      out[i] = new Date(cursor);
    }
    cursor = out[i]!.getTime() + minStepMs;
  }
  return out;
}

/** Phân bổ `count` bài đăng đều trong khoảng startAt–endAt (mỗi bài 6h–23h VN).
 *  `notBefore`: nếu có — ngày bắt đầu phân bổ không sớm hơn hôm nay (lập kế hoạch giữa chiến dịch). */
export function planReviewScheduleDates(
  startAt: Date,
  endAt: Date,
  count: number,
  notBefore?: Date,
): Date[] {
  if (count <= 0) return [];

  let startMs = startOfVnDay(startAt);
  if (notBefore) {
    startMs = Math.max(startMs, startOfVnDay(notBefore));
  }
  let endMs = startOfVnDay(endAt);
  if (endMs < startMs) endMs = startMs;

  const totalDays = Math.max(1, Math.floor((endMs - startMs) / DAY_MS) + 1);
  const slots: Date[] = [];

  for (let i = 0; i < count; i++) {
    const dayIndex = Math.floor((i * totalDays) / count);
    const dayMs = startMs + dayIndex * DAY_MS;
    // 6h–23h VN: giờ 6..22 + phút ngẫu nhiên (trước 23:00)
    const hour = 6 + Math.floor(Math.random() * 17);
    const minute = Math.floor(Math.random() * 60);
    slots.push(new Date(dayMs + (hour * 60 + minute) * 60 * 1000));
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}

/** Cùng profile nhiều bài → đẩy lịch sau cách nhau tối thiểu minGapMs. */
export function adjustScheduleForProfileReuse(
  times: Date[],
  profileIds: string[],
  minGapMs: number,
): Date[] {
  if (times.length !== profileIds.length || minGapMs <= 0) return times;
  const out = times.map((t) => new Date(t.getTime()));

  const byProfile = new Map<string, number[]>();
  profileIds.forEach((id, i) => {
    const list = byProfile.get(id) ?? [];
    list.push(i);
    byProfile.set(id, list);
  });

  for (const indices of byProfile.values()) {
    if (indices.length < 2) continue;
    indices.sort((a, b) => out[a]!.getTime() - out[b]!.getTime());
    for (let j = 1; j < indices.length; j++) {
      const prevIdx = indices[j - 1]!;
      const idx = indices[j]!;
      const minNext = out[prevIdx]!.getTime() + minGapMs;
      if (out[idx]!.getTime() < minNext) {
        out[idx] = new Date(minNext);
      }
    }
  }

  return out;
}

export function formatScheduleDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  // Format cố định (không phụ thuộc locale máy) — tránh hydration mismatch SSR/client
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VN_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Cửa sổ còn được auto-đăng sau mốc lịch (phút). Quá cửa sổ = quá hạn → phải lập lại / đăng tay. */
export function scheduleGraceMinutes(): number {
  const n = Number(process.env.REVIEW_SCHEDULE_GRACE_MINUTES || 120);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
}

export function scheduleGraceMs(): number {
  return scheduleGraceMinutes() * 60_000;
}

/**
 * true khi đang trong cửa sổ lịch đăng để auto-enqueue:
 * scheduledAt <= now <= scheduledAt + grace
 * (không có lịch → không auto)
 */
export function isWithinScheduleWindow(
  scheduledAt: string | Date | null | undefined,
  now = new Date(),
  graceMs = scheduleGraceMs(),
): boolean {
  if (!scheduledAt) return false;
  const d = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  if (Number.isNaN(d.getTime())) return false;
  const t = d.getTime();
  const n = now.getTime();
  return t <= n && n <= t + graceMs;
}

/** true khi đã qua cửa sổ lịch (quá hạn auto) — vẫn PENDING nhưng không auto. */
export function isScheduleOverdue(
  scheduledAt: string | Date | null | undefined,
  now = new Date(),
  graceMs = scheduleGraceMs(),
): boolean {
  if (!scheduledAt) return false;
  const d = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() > d.getTime() + graceMs;
}

/** @deprecated dùng isWithinScheduleWindow — giữ tương thích UI cũ. */
export function isScheduleDue(
  scheduledAt: string | Date | null | undefined,
  now = new Date(),
): boolean {
  return isWithinScheduleWindow(scheduledAt, now);
}

export type ScheduleState = "none" | "waiting" | "ready" | "overdue";

/**
 * Trạng thái lịch đăng:
 * - waiting: chưa tới giờ
 * - ready: trong cửa sổ lịch → auto có thể đăng
 * - overdue: quá cửa sổ → phải lập lại lịch hoặc Đăng tay
 */
export function getScheduleState(
  scheduledAt: string | Date | null | undefined,
  now = new Date(),
): ScheduleState {
  if (!scheduledAt) return "none";
  const d = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  if (Number.isNaN(d.getTime())) return "none";
  const t = d.getTime();
  const n = now.getTime();
  if (t > n) return "waiting";
  if (n <= t + scheduleGraceMs()) return "ready";
  return "overdue";
}

export function scheduleStateLabel(state: ScheduleState): string {
  switch (state) {
    case "waiting":
      return "Chờ lịch";
    case "ready":
      return "Đến lịch đăng";
    case "overdue":
      return "Quá hạn — lập lại / Đăng tay";
    default:
      return "";
  }
}

const ASSIGNMENT_STATUS_VI: Record<string, string> = {
  PENDING: "Chờ xử lý",
  QUEUED: "Đã xếp hàng",
  RUNNING: "Đang đăng",
  COMPLETED: "Hoàn thành",
  FAILED: "Thất bại",
  SKIPPED: "Bỏ qua",
};

export function assignmentStatusLabel(status: string): string {
  return ASSIGNMENT_STATUS_VI[status] ?? status;
}
