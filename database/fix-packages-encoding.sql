-- Sửa tên/mô tả gói bình luận bị lỗi encoding từ backup cũ
UPDATE "Package" SET
  name = 'Gói A',
  description = 'Gói cơ bản — 30 bình luận',
  "updatedAt" = NOW()
WHERE code = 'A';

UPDATE "Package" SET
  name = 'Gói B',
  description = 'Gói tiêu chuẩn — 50 bình luận',
  "updatedAt" = NOW()
WHERE code = 'B';

UPDATE "Package" SET
  name = 'Gói C',
  description = 'Gói nâng cao — 100 bình luận',
  "updatedAt" = NOW()
WHERE code = 'C';

SELECT code, name, description FROM "Package" ORDER BY code;
