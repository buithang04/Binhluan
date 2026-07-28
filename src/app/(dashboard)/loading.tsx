export default function DashboardLoading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 w-48 rounded bg-[var(--surface-muted)]" />
      <div className="h-4 w-72 rounded bg-[var(--surface-muted)]" />
      <div className="mt-6 h-40 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)]" />
      <div className="h-40 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)]" />
    </div>
  );
}
