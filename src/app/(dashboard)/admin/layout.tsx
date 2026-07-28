/** Role ADMIN đã được middleware chặn. */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="text-[14px] leading-relaxed text-[var(--ink)]">{children}</div>;
}
