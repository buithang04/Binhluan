import { create } from "zustand";
import { persist } from "zustand/middleware";

type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
  role: string | null;
  darkMode: boolean;
  setAuth: (payload: {
    accessToken: string;
    refreshToken: string;
    email: string;
    role: string;
  }) => void;
  clearAuth: () => void;
  toggleDark: () => void;
};

export const useUiStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      email: null,
      role: null,
      darkMode: true,
      setAuth: (payload) => set(payload),
      clearAuth: () =>
        set({ accessToken: null, refreshToken: null, email: null, role: null }),
      toggleDark: () => set((s) => ({ darkMode: !s.darkMode })),
    }),
    { name: "apm-ui" },
  ),
);
