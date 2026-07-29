/** Nhãn lỗi review / automation — dùng được cả client lẫn server. */

const LOGIN_ISSUE_VI: Record<string, string> = {
  EMAIL_NOT_FOUND: "Email Google không tồn tại — kiểm tra account trong Admin > Accounts",
  WRONG_PASSWORD: "Sai mật khẩu Google — cập nhật mật khẩu trong Admin > Accounts",
  RECAPTCHA: "Cần giải reCAPTCHA thủ công trên Chrome — mở browser và xử lý",
  CHALLENGE: "Cần xác minh Google thủ công trên Chrome — mở browser và làm theo hướng dẫn",
  BROWSER_BLOCKED: "Chrome bị Google chặn — reset browser và đăng nhập lại",
};

const ERROR_RULES: { test: RegExp; message: string }[] = [
  {
    // Dữ liệu test cũ bị PowerShell ghi lỗi encoding → "Test d?ng ? ch? ch?y 1 b?i"
    test: /Test d\?ng|Test dừng/i,
    message: "Đã tạm dừng test (chỉ chạy 1 bài) — bấm Đăng để chạy lại",
  },
  {
    test: /không còn proxy|proxy trống|proxy.*cooldown|đang lock hoặc cooldown/i,
    message:
      "Không còn proxy khả dụng (đang lock hoặc cooldown) — thêm proxy hoặc chờ hết cooldown",
  },
  {
    test: /không chiếm được proxy|proxy \(race\)/i,
    message: "Không gán được proxy (đang tranh chấp) — thử lại sau vài giây",
  },
  {
    test: /MAPS_REVIEW requires a locked proxy/i,
    message: "Job không có proxy — hệ thống chưa lock được proxy cho bài đăng này",
  },
  {
    test: /profile already queued|already queued\/running/i,
    message: "Account đang chạy job khác — đợi job hiện tại hoàn thành",
  },
  {
    test: /profile is disabled/i,
    message: "Profile bị vô hiệu hóa",
  },
  {
    test: /MAPS_REVIEW bị chặn|exit IP trùng IP máy|proxy .* auth thất bại|thiếu user\/pass/i,
    message:
      "Proxy chưa sẵn sàng — không vào Maps (tránh spam IP máy). Kiểm tra proxy Webshare / user-pass",
  },
  {
    test: /browser không còn mở|bấm mở browser/i,
    message: "Chrome đã đóng — hệ thống sẽ tự mở lại khi bấm Đăng",
  },
  {
    test: /chrome chưa mở|browseralive|chưa mở browser|chưa mở chrome/i,
    message: "Chrome chưa mở — hệ thống sẽ tự mở khi bấm Đăng",
  },
  {
    test: /không tìm thấy nút viết|chỉnh sửa đánh giá/i,
    message:
      "Không tìm thấy nút viết đánh giá trên Maps (có thể chưa đăng nhập đúng tài khoản Google)",
  },
  {
    test: /không tìm thấy iframe form đánh giá/i,
    message: "Không mở được form đánh giá Maps",
  },
  {
    test: /không chọn được.*sao/i,
    message: "Không chọn được số sao trên form Maps",
  },
  {
    test: /nút đăng chưa sẵn sàng|thiếu sao\/nội dung/i,
    message: "Form Maps chưa sẵn sàng đăng — kiểm tra sao / nội dung / hộp hủy đánh giá",
  },
  {
    test: /không nhập được bình luận/i,
    message: "Không nhập được nội dung bình luận trên Maps",
  },
  {
    test: /không click đăng/i,
    message: "Không bấm được nút Đăng trên Maps",
  },
  {
    test: /thiếu apmprofileid|missing profile/i,
    message: "Chưa gán account cho bài đăng — lập lại kế hoạch",
  },
  {
    test: /đã mở Chrome|đưa Chrome lên màn hình/i,
    message:
      "Account chưa READY — đã mở Chrome đăng nhập như thêm mail. Hoàn tất rồi bấm Đăng lại",
  },
  {
    test: /account chưa ready|chưa ready/i,
    message:
      "Account chưa READY — hệ thống sẽ mở Chrome đăng nhập; hoàn tất rồi bấm Đăng lại",
  },
  {
    test: /account đang bị lock|lease/i,
    message: "Account đang bị lock bởi job khác",
  },
  {
    test: /econnrefused|fetch failed|apm login failed|internal api/i,
    message:
      "Không kết nối được máy chủ automation — kiểm tra npm run dev (API + worker) đang chạy",
  },
  {
    test: /invalid lease/i,
    message: "Job automation hết hạn (lease) — thử đăng lại",
  },
];

export function loginIssueMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return LOGIN_ISSUE_VI[code.toUpperCase()] ?? `Lỗi đăng nhập: ${code}`;
}

/** Chuẩn hóa thông báo lỗi thô → tiếng Việt dễ hiểu. */
export function formatReviewError(raw: string | null | undefined): string {
  if (!raw?.trim()) return "";
  const text = raw.trim();

  for (const issue of Object.keys(LOGIN_ISSUE_VI)) {
    if (text.toUpperCase().includes(issue)) {
      return LOGIN_ISSUE_VI[issue]!;
    }
  }

  for (const rule of ERROR_RULES) {
    if (rule.test.test(text)) return rule.message;
  }

  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}
