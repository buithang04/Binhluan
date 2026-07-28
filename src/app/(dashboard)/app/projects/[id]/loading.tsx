export default function ProjectDetailLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-9 w-64 rounded bg-[var(--surface-muted)]" />
      <div className="h-32 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)]" />
      <div className="h-48 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)]" />
      <div className="h-64 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface-muted)]" />
    </div>
  );
}
