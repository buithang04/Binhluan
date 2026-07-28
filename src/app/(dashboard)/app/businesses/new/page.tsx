import Link from "next/link";
import { BusinessForm } from "@/components/BusinessForm";

export default function NewBusinessPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-[var(--muted)]">Doanh nghiệp / Tạo mới</p>
        <h1 className="page-title">Tạo doanh nghiệp</h1>
        <p className="page-desc">
          Lưu hồ sơ để tái sử dụng. Đặt Active để tự điền khi tạo dự án.
        </p>
      </div>
      <div className="panel p-5 sm:p-6">
        <BusinessForm mode="create" />
      </div>
      <p className="text-sm text-[var(--muted)]">
        <Link href="/app/businesses" className="link-accent">
          ← Về danh sách
        </Link>
      </p>
    </div>
  );
}
