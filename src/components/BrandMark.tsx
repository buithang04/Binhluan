import Link from "next/link";

type Props = {
  href?: string;
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  inverted?: boolean;
};

export function BrandMark({
  href,
  size = "md",
  showWordmark = true,
  inverted = false,
}: Props) {
  const box =
    size === "lg" ? "h-11 w-11" : size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const word =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";

  const inner = (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={`relative ${box} overflow-hidden rounded-xl ${
          inverted ? "bg-white/12 ring-1 ring-white/20" : "bg-ink shadow-sm"
        }`}
        style={{ background: inverted ? undefined : "linear-gradient(145deg,#0c1222,#163048)" }}
        aria-hidden
      >
        <span className="absolute inset-[3px] rounded-[9px] border border-white/10" />
        <span className="absolute left-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#12b886]" />
        <span className="absolute bottom-1.5 left-1.5 right-1.5 h-0.5 rounded-full bg-[#0e9aa7]/80" />
        <span className="absolute bottom-2.5 left-1.5 right-2.5 h-0.5 rounded-full bg-white/25" />
      </span>
      {showWordmark && (
        <span
          className={`font-semibold tracking-tight ${word} ${
            inverted ? "text-white" : "text-[var(--ink)]"
          }`}
        >
          Binhluan
        </span>
      )}
    </span>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 rounded-lg">
      {inner}
    </Link>
  );
}
