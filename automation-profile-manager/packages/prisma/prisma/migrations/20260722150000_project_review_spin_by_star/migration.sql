-- Spin template theo mức sao (1-5) + đánh dấu đã sinh nội dung 1 lần
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "reviewSpinByStar" JSONB;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "reviewContentGeneratedAt" TIMESTAMP(3);
