/** Nhãn lỗi review / automation — dùng được cả client lẫn server. */

const LOGIN_ISSUE_VI: Record<string, string> = {
  EMAIL_NOT_FOUND: "Email Google không tồn tại",
  WRONG_PASSWORD: "Sai mật khẩu Google",
  RECAPTCHA: "Cần giải reCAPTCHA trên Chrome",
  CHALLENGE: "Cần xác minh Google trên Chrome",
  BROWSER_BLOCKED: "Chrome bị Google chặn",
};

const ERROR_RULES: { test: RegExp; message: string }[] = [
  {
    test: /ALREADY_REVIEWED_AT_PLACE|đã có bình luận tại địa điểm/i,
    message: "Mail đã bình luận địa điểm này — chọn mail khác",
  },
  {
    test: /Chưa gán mail/i,
    message: "Chưa gán mail — chọn mail trước khi đăng",
  },
  {
    test: /Test d\?ng|Test dừng/i,
    message: "Đã tạm dừng test — bấm Đăng lại",
  },
  {
    test: /MAPS_REVIEW bị chặn: proxy|auth thất bại|ERR_TUNNEL|warmup không trả IP/i,
    message: "Proxy lỗi — hệ thống đang thử proxy khác; kiểm tra Webshare nếu lặp lại",
  },
  {
    test: /Google chưa đăng nhập|accounts\.google\.com|signin\/identifier/i,
    message: "Google chưa đăng nhập — mở Chrome đăng nhập rồi Đăng lại",
  },
  {
    test: /đang chờ proxy|không còn proxy|proxy trống|proxy.*cooldown|đang lock hoặc cooldown/i,
    message: "Đang chờ proxy — sẽ tự đăng khi có slot",
  },
  {
    test: /không chiếm được proxy|proxy \(race\)/i,
    message: "Không gán được proxy — thử lại sau",
  },
  {
    test: /MAPS_REVIEW requires a locked proxy/i,
    message: "Job thiếu proxy",
  },
  {
    test: /profile already queued|already queued\/running/i,
    message: "Account đang chạy job khác",
  },
  {
    test: /profile is disabled/i,
    message: "Profile bị vô hiệu hóa",
  },
  {
    test: /MAPS_REVIEW bị chặn|exit IP trùng IP máy|proxy .* auth thất bại|thiếu user\/pass/i,
    message: "Proxy chưa sẵn sàng — kiểm tra Webshare",
  },
  {
    test: /devtools|reconnect|KHÔNG tự kill|không reconnect được/i,
    message:
      "Chrome profile đang bận — hệ thống sẽ tự thử lại; nếu lặp lại, đóng Chrome thừa rồi Đăng lại",
  },
  {
    test: /chờ job trước|chờ Chrome job|Chrome kẹt/i,
    message: "Đang chờ Chrome profile — sẽ tự đăng khi sẵn sàng",
  },
  {
    test: /browser không còn mở|bấm mở browser/i,
    message: "Chrome đã đóng — bấm Đăng để mở lại",
  },
  {
    test: /chrome chưa mở|browseralive|chưa mở browser|chưa mở chrome/i,
    message: "Chrome chưa mở — bấm Đăng để mở",
  },
  {
    test: /không tìm thấy nút viết|chỉnh sửa đánh giá/i,
    message: "Không thấy nút viết đánh giá trên Maps",
  },
  {
    test: /không tìm thấy iframe form đánh giá/i,
    message: "Không mở được form đánh giá Maps",
  },
  {
    test: /không chọn được.*sao/i,
    message: "Không chọn được số sao trên Maps",
  },
  {
    test: /nút đăng chưa sẵn sàng|thiếu sao\/nội dung/i,
    message: "Form Maps chưa sẵn sàng đăng",
  },
  {
    test: /không nhập được bình luận/i,
    message: "Không nhập được bình luận trên Maps",
  },
  {
    test: /không click đăng/i,
    message: "Không bấm được nút Đăng trên Maps",
  },
  {
    test: /thiếu apmprofileid|missing profile/i,
    message: "Chưa gán account — lập lại kế hoạch",
  },
  {
    test: /đã mở Chrome|đưa Chrome lên màn hình/i,
    message: "Chưa READY — hoàn tất đăng nhập Chrome rồi Đăng lại",
  },
  {
    test: /account chưa ready|chưa ready/i,
    message: "Account chưa READY — đăng nhập Chrome rồi Đăng lại",
  },
  {
    test: /account đang bị lock|lease/i,
    message: "Account đang bị lock bởi job khác",
  },
  {
    test: /econnrefused|fetch failed|apm login failed|internal api/i,
    message: "Không kết nối được máy chủ automation",
  },
  {
    test: /invalid lease/i,
    message: "Job hết hạn (lease) — thử Đăng lại",
  },
  {
    test: /timeout|timed out|navigation timeout/i,
    message: "Timeout Maps — thử Đăng lại",
  },
];

/** Bỏ URL / backtick dài để không tràn UI. */
function scrubErrorNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\(\s*đang ở\s*\)/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[—\-–]\s*[—\-–]\s*/g, " — ")
    .replace(/^\s*[—\-–]\s*|\s*[—\-–]\s*$/g, "")
    .trim();
}

function clampMsg(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export function loginIssueMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return LOGIN_ISSUE_VI[code.toUpperCase()] ?? `Lỗi đăng nhập: ${code}`;
}

/**
 * Chuẩn hóa lỗi thô → tiếng Việt ngắn.
 * @param maxLen mặc định 90 (UI bảng / Bài lỗi). Truyền lớn hơn nếu cần log.
 */
export function formatReviewError(
  raw: string | null | undefined,
  maxLen = 90,
): string {
  if (!raw?.trim()) return "";
  const text = raw.trim();

  for (const issue of Object.keys(LOGIN_ISSUE_VI)) {
    if (text.toUpperCase().includes(issue)) {
      return LOGIN_ISSUE_VI[issue]!;
    }
  }

  for (const rule of ERROR_RULES) {
    if (rule.test.test(text)) return clampMsg(rule.message, maxLen);
  }

  return clampMsg(scrubErrorNoise(text) || text, maxLen);
}
