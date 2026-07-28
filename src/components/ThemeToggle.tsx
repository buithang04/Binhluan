"use client";

import { useTheme } from "@/lib/theme";
import { ClientOnly } from "@/components/ClientOnly";

type Props = {
  className?: string;
  compact?: boolean;
};

function ThemeToggleFallback({ compact = false, className = "" }: Props) {
  return (
    <span
      className={`theme-toggle ${compact ? "theme-toggle-compact" : ""} ${className}`.trim()}
      aria-hidden
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-thumb" />
      </span>
      {!compact && (
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--muted)]">
          Theme
        </span>
      )}
    </span>
  );
}

function ThemeToggleInner({ className = "", compact = false }: Props) {
  const { toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle ${compact ? "theme-toggle-compact" : ""} ${className}`.trim()}
      aria-label="Đổi giao diện"
      title="Đổi giao diện"
    >
      <span className="theme-toggle-track" aria-hidden>
        <span className="theme-toggle-thumb">
          <svg
            viewBox="0 0 24 24"
            className="theme-icon theme-icon-sun h-3.5 w-3.5"
            fill="currentColor"
          >
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          <svg
            viewBox="0 0 24 24"
            className="theme-icon theme-icon-moon h-3.5 w-3.5"
            fill="currentColor"
          >
            <path d="M21 14.5A8.5 8.5 0 019.5 3 7 7 0 1019 18.5a8.4 8.4 0 002-4z" />
          </svg>
        </span>
      </span>
      {!compact && (
        <span className="font-mono text-xs uppercase tracking-wider text-[var(--muted)]">
          <span className="theme-label-light">Light</span>
          <span className="theme-label-dark">Dark</span>
        </span>
      )}
    </button>
  );
}

/** Chỉ mount trên client — không SSR → không hydration mismatch. */
export function ThemeToggle(props: Props) {
  return (
    <ClientOnly fallback={<ThemeToggleFallback {...props} />}>
      <ThemeToggleInner {...props} />
    </ClientOnly>
  );
}
