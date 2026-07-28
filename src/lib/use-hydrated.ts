"use client";

import { useEffect, useState } from "react";

/** true sau lần mount client — tránh SSR/client render khác nhau. */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
