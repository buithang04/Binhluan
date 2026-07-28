type Tone = "ok" | "bad" | "warn" | "neutral";

function toneFor(value: string, kind: "health" | "status" | "alive" | "auto" = "auto"): Tone {
  const v = value.trim().toUpperCase();
  if (!v || v === "—" || v === "-") return "neutral";

  if (kind === "alive") {
    if (
      ["ALIVE", "TRUE", "1", "YES", "ON", "ĐANG MỞ", "DANG MO", "BẬT", "BAT"].includes(v) ||
      v.includes("ĐANG MỞ") ||
      v.includes("DANG MO")
    ) {
      return "ok";
    }
    return "bad";
  }

  if (kind === "health" || kind === "auto") {
    if (["WORKING", "OK", "HEALTHY", "UP", "GOOD", "LIVE", "TỐT", "TOT"].includes(v)) {
      return "ok";
    }
    if (["UNKNOWN", "CHECKING", "PENDING", "WARMING", "IDLE"].includes(v)) return "warn";
    if (["DEAD", "DOWN", "FAIL", "FAILED", "ERROR", "BAD", "TIMEOUT", "BANNED"].includes(v)) {
      return "bad";
    }
  }

  if (kind === "status" || kind === "auto") {
    // Chưa sẵn sàng trước — tránh "CHƯA SẴN SÀNG".includes("SẴN SÀNG") thành xanh
    if (
      [
        "QUEUED",
        "PENDING",
        "WAITING",
        "PAUSED",
        "ASSIGNED",
        "UNREADY",
        "CHƯA SẴN SÀNG",
        "CHUA SAN SANG",
      ].includes(v) ||
      v.includes("CHƯA SẴN") ||
      v.includes("CHUA SAN") ||
      v.includes("HÀNG ĐỢI")
    ) {
      return "warn";
    }
    if (
      [
        "ACTIVE",
        "READY",
        "RUNNING",
        "SUCCESS",
        "DONE",
        "COMPLETED",
        "ONLINE",
        "SẴN SÀNG",
        "SAN SANG",
        "ĐANG CHẠY",
        "DANG CHAY",
      ].includes(v) ||
      v === "SẴN SÀNG" ||
      v.includes("ĐANG CHẠY")
    ) {
      return "ok";
    }
    if (
      v.includes("RECAPTCHA") ||
      v.includes("CAPTCHA") ||
      v.includes("CHỜ GIẢI") ||
      v.includes("CHALLENGE") ||
      v.includes("XÁC MINH")
    ) {
      return "warn";
    }
    if (
      v.includes("SAI MK") ||
      v.includes("MẬT KHẨU") ||
      v.includes("EMAIL") ||
      v.includes("KHÔNG TỒN TẠI") ||
      v.includes("CHẶN")
    ) {
      return "bad";
    }
    if (
      ["INACTIVE", "DISABLED", "OFF", "ERROR", "FAILED", "FAIL", "BLOCKED", "BANNED", "DEAD", "TẮT", "TAT"].includes(
        v,
      )
    ) {
      return "bad";
    }
  }

  return "neutral";
}

/** Map mã trạng thái API → nhãn tiếng Việt */
export function formatStatusLabel(status: string): string {
  switch ((status || "").toUpperCase()) {
    case "READY":
      return "Sẵn sàng";
    case "UNREADY":
      return "Chưa sẵn sàng";
    case "RUNNING":
      return "Đang chạy";
    case "QUEUED":
      return "Trong hàng đợi";
    case "PENDING":
    case "WAITING":
      return "Đang chờ";
    case "PAUSED":
      return "Tạm dừng";
    case "SUCCESS":
    case "DONE":
    case "COMPLETED":
      return "Thành công";
    case "FAILED":
    case "FAIL":
    case "ERROR":
      return "Lỗi";
    case "BLOCKED":
    case "BANNED":
      return "Bị chặn";
    case "ACTIVE":
    case "ONLINE":
      return "Hoạt động";
    case "INACTIVE":
    case "DISABLED":
    case "OFF":
      return "Tắt";
    case "WORKING":
    case "HEALTHY":
    case "OK":
      return "Tốt";
    case "DEAD":
    case "DOWN":
      return "Hỏng";
    case "UNKNOWN":
      return "Không rõ";
    default:
      return status || "—";
  }
}

/** Map mã loginIssue → nhãn trạng thái đăng nhập tiếng Việt */
export function formatLoginStatus(status: string, loginIssue?: string | null): string {
  if (status === "READY") return "Sẵn sàng";
  switch ((loginIssue || "").toUpperCase()) {
    case "EMAIL_NOT_FOUND":
      return "Email không tồn tại";
    case "WRONG_PASSWORD":
      return "Sai mật khẩu";
    case "RECAPTCHA":
      return "Chờ giải reCAPTCHA tay";
    case "BROWSER_BLOCKED":
      return "Trình duyệt bị chặn";
    case "CHALLENGE":
      return "Chờ xác minh tay";
    default:
      return formatStatusLabel(status || "UNREADY");
  }
}

export function formatAliveLabel(alive: boolean): string {
  return alive ? "Đang mở" : "Tắt";
}

function displayLabel(raw: string, kind: "health" | "status" | "alive" | "auto"): string {
  const t = raw.trim();
  if (!t || t === "—" || t === "-") return "—";

  if (kind === "alive") {
    const u = t.toUpperCase();
    if (["ALIVE", "TRUE", "1", "YES", "ON"].includes(u)) return "Đang mở";
    if (["OFF", "FALSE", "0", "NO"].includes(u)) return "Tắt";
    return t;
  }

  // Mã API kiểu READY / QUEUED → tiếng Việt; chuỗi đã Việt giữ nguyên
  if (/^[A-Z][A-Z0-9_]*$/.test(t)) {
    return formatStatusLabel(t);
  }
  return t;
}

export function StatusLight({
  value,
  kind = "auto",
}: {
  value: unknown;
  kind?: "health" | "status" | "alive" | "auto";
}) {
  const raw = value == null ? "—" : String(value);
  const text = displayLabel(raw, kind);
  const tone = toneFor(raw, kind);

  return (
    <span className={`status-light status-light-${tone}`}>
      <span className="status-light-dot" aria-hidden />
      <span className="status-light-label">{text}</span>
    </span>
  );
}
