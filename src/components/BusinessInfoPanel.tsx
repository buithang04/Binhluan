"use client";

import { useState } from "react";

type Product = { id: string; name: string; description: string };

type Props = {
  website: string | null;
  googleMapsUrl: string;
  desiredRating: string | null;
  currentRating: string | null;
  reviewCount: string | null;
  ratingScannedAt?: string | null;
  reviewsToPost: string | null;
  startAt: string;
  endAt: string;
  packageLabel: string;
  brandDescription: string;
  targetAudience: string;
  targetMarket: string;
  writingNotes: string | null;
  products: Product[];
};

export function BusinessInfoPanel(props: Props) {
  const [open, setOpen] = useState(false);

  const summaryBits = [
    props.packageLabel,
    props.website || null,
    props.products.length ? `${props.products.length} SP` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <section className="panel grid gap-x-4 gap-y-3 p-4 sm:grid-cols-3 sm:p-5">
        <div className="min-w-0">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-[var(--muted)]">
            Google Maps
          </p>
          <a
            href={props.googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            title={props.googleMapsUrl}
            className="link-accent mt-0.5 block truncate text-sm"
          >
            {shortMapsLabel(props.googleMapsUrl)}
          </a>
        </div>
        <Item label="Số sao mong muốn" value={props.desiredRating || "—"} />
        <Item label="Số sao trung bình" value={props.currentRating || "—"} />
        <Item label="Lượt đánh giá" value={props.reviewCount || "—"} />
        <Item
          label="Quét/chốt sao lúc"
          value={
            props.ratingScannedAt
              ? (() => {
                  const d = new Date(props.ratingScannedAt);
                  if (Number.isNaN(d.getTime())) return "—";
                  const pad = (n: number) => String(n).padStart(2, "0");
                  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                })()
              : "—"
          }
        />
        <Item label="Số bài sẽ đăng" value={props.reviewsToPost || "—"} />
        <Item label="Thời gian" value={`${props.startAt} → ${props.endAt}`} />
      </section>

      <section className="panel overflow-hidden">
        <button
          type="button"
          className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left sm:px-6"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <div className="min-w-0">
            <p className="font-display text-base font-semibold tracking-tight text-[var(--ink)]">
              Thông tin doanh nghiệp
            </p>
            {!open && (
              <p className="mt-1 truncate text-sm text-[var(--muted)]">
                {summaryBits.join(" · ")}
              </p>
            )}
          </div>
          <span
            className={`mt-1 shrink-0 text-[var(--muted)] transition-transform ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden
          >
            ▾
          </span>
        </button>

        {open && (
          <div className="grid gap-4 border-t border-[var(--line)] px-5 pb-5 sm:grid-cols-2 sm:px-6 sm:pb-6">
            <Item label="Website" value={props.website || "—"} />
            <Item label="Gói" value={props.packageLabel} />
            <div className="sm:col-span-2">
              <Item label="Brand Description" value={props.brandDescription} wrap />
            </div>
            <Item label="Target Audience" value={props.targetAudience} wrap />
            <Item label="Target Market" value={props.targetMarket} wrap />
            <div className="sm:col-span-2">
              <Item label="Lưu ý khi viết" value={props.writingNotes || "—"} wrap />
            </div>
            <div className="sm:col-span-2 border-t border-[var(--line)] pt-4">
              <p className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
                Sản phẩm ({props.products.length})
              </p>
              <ul className="space-y-3">
                {props.products.map((p) => (
                  <li key={p.id} className="border-b border-[var(--line)] pb-3 last:border-0">
                    <p className="font-medium text-[var(--ink)]">{p.name}</p>
                    <p className="text-sm text-[var(--muted)]">{p.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function shortMapsLabel(url: string) {
  try {
    const u = new URL(url);
    const place = u.pathname.match(/\/place\/([^/]+)/)?.[1];
    if (place) {
      const name = decodeURIComponent(place.replace(/\+/g, " "));
      return name.length > 56 ? `${name.slice(0, 56)}…` : name;
    }
    return u.host;
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

function Item({
  label,
  value,
  wrap,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm text-[var(--ink-soft)] ${
          wrap ? "whitespace-pre-wrap" : "truncate"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
