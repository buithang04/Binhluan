import { z } from "zod";
import { vnMinCampaignStartDate } from "@/lib/review-schedule";

/** Giới hạn ký tự cho mô tả doanh nghiệp / sản phẩm. */
export const DESCRIPTION_MAX_LENGTH = 10_000;

const ratingSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : NaN;
  })
  .refine((v) => v === null || (v >= 1 && v <= 5), {
    message: "Số sao phải từ 1.0 đến 5.0",
  });

/** Sao hiện tại: cho phép 0 khi place chưa có đánh giá. */
const currentRatingSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : NaN;
  })
  .refine((v) => v === null || (v >= 0 && v <= 5), {
    message: "Số sao hiện tại phải từ 0 đến 5.0 (0 = chưa có đánh giá)",
  });

const reviewCountSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : NaN;
  })
  .refine((v) => v === null || (v >= 0 && v <= 10_000_000), {
    message: "Số review không hợp lệ",
  });

/** Số từ mục tiêu — optional, rỗng = null, hợp lệ 10–2000. */
export const optionalContentWordCountSchema = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  },
  z.union([
    z.null(),
    z.number().int().min(10, "Số từ phải từ 10 đến 2000").max(2000, "Số từ phải từ 10 đến 2000"),
  ]),
);

export const productInputSchema = z.object({
  name: z.string().trim().min(2, "Tên sản phẩm tối thiểu 2 ký tự"),
  description: z
    .string()
    .trim()
    .min(10, "Mô tả sản phẩm tối thiểu 10 ký tự")
    .max(DESCRIPTION_MAX_LENGTH, `Mô tả sản phẩm tối đa ${DESCRIPTION_MAX_LENGTH} ký tự`),
});

export const projectCreateSchema = z
  .object({
    brandName: z.preprocess(
      (v) => (v == null ? "" : String(v)).trim(),
      z.string().min(2, "Brand Name tối thiểu 2 ký tự"),
    ),
    website: z.preprocess((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t ? t : null;
    }, z.union([
      z.null(),
      z.string().regex(/^https?:\/\/.+/i, "Website phải là URL hợp lệ (http/https)"),
    ])),
    brandDescription: z.preprocess(
      (v) => (v == null ? "" : String(v)).trim(),
      z.string().max(DESCRIPTION_MAX_LENGTH, `Mô tả tối đa ${DESCRIPTION_MAX_LENGTH} ký tự`),
    ),
    targetAudience: z.preprocess(
      (v) => (v == null ? "" : String(v)).trim(),
      z.string(),
    ),
    targetMarket: z.preprocess(
      (v) => (v == null ? "" : String(v)).trim(),
      z.string(),
    ),
    writingNotes: z.preprocess((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t ? t : null;
    }, z.union([z.null(), z.string()])),
    contentDirection: z.preprocess((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t ? t : null;
    }, z.union([z.null(), z.string().max(2000)])),
    contentLanguage: z.preprocess(
      (v) => {
        const t = String(v ?? "VI").trim().toUpperCase();
        return t === "EN" ? "EN" : "VI";
      },
      z.enum(["VI", "EN"]),
    ),
    contentExample: z.preprocess((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t ? t : null;
    }, z.union([z.null(), z.string().max(10000)])),
    contentWordCount: optionalContentWordCountSchema,
    googleMapsUrl: z
      .string()
      .trim()
      .min(10, "Thiếu link Google Maps")
      .refine((v) => /google\.[^/]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(v), {
        message: "Link Google Maps không hợp lệ",
      }),
    packageId: z.string().min(1, "Chọn gói"),
    desiredRating: ratingSchema,
    currentRating: currentRatingSchema,
    reviewCount: reviewCountSchema,
    ratingScannedAt: z
      .union([z.string(), z.null(), z.undefined()])
      .transform((v) => {
        if (v === null || v === undefined || v === "") return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }),
    proxyCooldownMinutes: z
      .union([z.string(), z.number(), z.null(), z.undefined()])
      .transform((v) => {
        if (v === null || v === undefined || v === "") return 60;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? Math.floor(n) : NaN;
      })
      .refine((v) => v >= 0 && v <= 10080, {
        message: "Cooldown proxy phải từ 0 đến 10080 phút",
      }),
    startAt: z.string().min(1, "Chọn ngày bắt đầu"),
    endAt: z.string().min(1, "Chọn ngày kết thúc"),
    products: z
      .array(productInputSchema)
      .min(1, "Cần ít nhất 1 sản phẩm")
      .max(50),
  })
  .superRefine((data, ctx) => {
    const start = new Date(data.startAt);
    const end = new Date(data.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      ctx.addIssue({ code: "custom", message: "Thời gian không hợp lệ", path: ["startAt"] });
      return;
    }
    const minStart = vnMinCampaignStartDate();
    // So sánh YYYY-MM-DD (input type=date) theo lịch VN — chặn hôm nay và ngày đã qua
    if (data.startAt < minStart) {
      ctx.addIssue({
        code: "custom",
        message: "Ngày bắt đầu phải từ ngày mai trở đi (không chọn hôm nay hoặc ngày đã qua)",
        path: ["startAt"],
      });
    }
    if (data.endAt < minStart) {
      ctx.addIssue({
        code: "custom",
        message: "Ngày kết thúc phải từ ngày mai trở đi (không chọn hôm nay hoặc ngày đã qua)",
        path: ["endAt"],
      });
    }
    if (start >= end) {
      ctx.addIssue({
        code: "custom",
        message: "Ngày bắt đầu phải trước ngày kết thúc",
        path: ["endAt"],
      });
    }
  });

export const projectUpdateSchema = projectCreateSchema;

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(191),
  password: z
    .string()
    .min(8)
    .max(72)
    .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
      message: "Mật khẩu cần có chữ và số",
    }),
});

export const adminUserCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(191),
  password: z
    .string()
    .min(8)
    .max(72)
    .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
      message: "Mật khẩu cần có chữ và số",
    }),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});

export const adminUserUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  isActive: z.boolean().optional(),
});

export const adminPasswordResetSchema = z.object({
  password: z
    .string()
    .min(8)
    .max(72)
    .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
      message: "Mật khẩu cần có chữ và số",
    }),
});

export const businessProductSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().min(10).max(DESCRIPTION_MAX_LENGTH),
});

export const businessCreateSchema = z.object({
  brandName: z.string().trim().min(2).max(200),
  website: z.preprocess((v) => {
    if (v === null || v === undefined || v === "") return null;
    return String(v).trim();
  }, z.union([z.string().url("Website không hợp lệ").max(500), z.null()])),
  brandDescription: z.string().trim().max(DESCRIPTION_MAX_LENGTH).optional().default(""),
  targetAudience: z.string().trim().max(2000).optional().default(""),
  targetMarket: z.string().trim().max(2000).optional().default(""),
  writingNotes: z
    .preprocess((v) => {
      if (v === null || v === undefined || v === "") return null;
      return String(v).trim();
    }, z.union([z.string().max(5000), z.null()]))
    .optional(),
  products: z.array(businessProductSchema).min(1).max(50),
  setActive: z.boolean().optional().default(false),
});

export const businessUpdateSchema = businessCreateSchema;

/** Ghép lỗi Zod thành chuỗi hiển thị UI. */
export function formatZodFlatten(flat: {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
}): string {
  const parts: string[] = [...flat.formErrors];
  for (const [key, msgs] of Object.entries(flat.fieldErrors)) {
    if (!msgs?.length) continue;
    parts.push(`${key}: ${msgs.join("; ")}`);
  }
  return parts.join(" · ") || "Dữ liệu không hợp lệ";
}
