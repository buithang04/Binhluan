import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const OUTREACH_TEMPLATE = `{Em chào anh chị|Anh chị ơi}, [$user_name]

{hiện tại website có đang ổn định traffic & chuyển đổi không ạ?|Đợt Google cập nhật vừa rồi Website của anh chị có bị ảnh hưởng nhiều k ạ?}

{Bên em đang triển khai gói Audit Content Website tổng thể theo chuẩn Google update mới nhất 2026|Bên em đang có gói Audit Web theo các tiêu chí mới của Google cập nhật 2026}, tập trung:

- {Tối ưu tăng trưởng organic traffic bền vững|Giúp Organic Traffic tăng đều và bền vững}

- Tăng tỷ lệ hiển thị trên {AIO|AI Overview} lên tới {40%|30-40%} sau {khi tiếp nhận|3-6 tuần}

- {Nâng cao tỷ lệ chuyển đổi (CVR) từ content|Tăng chuyển đổi đơn hàng}

- {Chuẩn hoá nội dung theo EEAT - Content chất lượng không spam AI|Làm mới nội dung theo chuẩn EEAT}

{Bên em sẽ audit chi tiết từng bài viết, cấu trúc content, search intent & đưa ra lộ trình tối ưu + ước tính tỷ lệ tăng trưởng rõ ràng.|Bên em sẽ Audit Bài viết, cấu trúc Content, sau đó đưa ra lộ trình tối ưu để tăng tỷ lệ chuyển đổi đơn hàng}

{Anh chị quan tâm để em gửi báo cáo demo & tư vấn chi tiết tới mình ạ|Anh chị quan tâm nhắn em Website [$website], em phân tích và tư vấn cụ thể tới Anh chị nhé}

---
Brand: [$brand_name]
Sản phẩm:
[$product_list]`;

async function main() {
  const packages = [
    {
      code: "A",
      name: "Gói A",
      description: "Gói cơ bản — 30 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 30,
    },
    {
      code: "B",
      name: "Gói B",
      description: "Gói tiêu chuẩn — 50 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 50,
    },
    {
      code: "C",
      name: "Gói C",
      description: "Gói nâng cao — 100 bình luận",
      maxProducts: 200,
      maxMedia: 50,
      targetContents: 100,
    },
  ];

  for (const pkg of packages) {
    await prisma.package.upsert({
      where: { code: pkg.code },
      update: pkg,
      create: pkg,
    });
  }

  const templates = [
    {
      code: "AUDIT_OUTREACH",
      name: "Outreach Audit Website 2026",
      type: "OUTREACH_EMAIL" as const,
      tone: "FRIENDLY" as const,
      bodySpin: OUTREACH_TEMPLATE,
    },
    {
      code: "BRAND_INTRO",
      name: "Giới thiệu thương hiệu",
      type: "BRAND_COPY" as const,
      tone: "FORMAL" as const,
      bodySpin: `[$tone_opener], em liên hệ từ [$brand_name].

{Chúng tôi|Bên em} {chuyên|tập trung} phục vụ [$target_audience] tại [$target_market].

{Một số sản phẩm nổi bật|Danh mục chính}:
[$product_list]

{Anh chị cần thêm thông tin|Nếu quan tâm} {nhắn em|liên hệ em} nhé ạ.
[$tone_closer]`,
    },
    {
      code: "CONSULT_SHORT",
      name: "Tin nhắn tư vấn ngắn",
      type: "CONSULT_MESSAGE" as const,
      tone: "CASUAL" as const,
      bodySpin: `{Em chào anh chị|Chào [$user_name]}, {em|mình} {thấy|đọc qua} [$brand_name] {khá phù hợp|đang phát triển tốt} với [$target_market].

{Ghi chú nội bộ|Lưu ý viết}: [$writing_notes]

{Muốn trao đổi thêm không ạ?|Anh chị có 5 phút trao đổi không ạ?}`,
    },
  ];

  for (const t of templates) {
    await prisma.contentTemplate.upsert({
      where: { code: t.code },
      update: { name: t.name, bodySpin: t.bodySpin, type: t.type, tone: t.tone, isActive: true },
      create: t,
    });
  }

  const passwordHash = await bcrypt.hash("Admin@123", 10);
  await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: { passwordHash, role: Role.ADMIN, name: "Admin" },
    create: {
      email: "admin@example.com",
      passwordHash,
      name: "Admin",
      role: Role.ADMIN,
    },
  });

  console.log("Seed OK: packages, templates, admin@example.com / Admin@123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
