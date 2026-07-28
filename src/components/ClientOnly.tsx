"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Chỉ render `children` sau khi mount trên client.
 * SSR + lần hydrate đầu dùng `fallback` giống nhau → hết mismatch.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}
