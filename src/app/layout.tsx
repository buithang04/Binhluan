import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import Script from "next/script";
import { Providers } from "@/components/Providers";
import { themeInitScript } from "@/lib/theme-script";
import "./globals.css";

/** Một font duy nhất toàn hệ thống */
const sans = DM_Sans({
  variable: "--font-app",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Binhluan — Automation Console",
  description: "Nền tảng tự động hóa profile, nội dung & vận hành Google Maps",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Không await getSession ở đây — soft-nav sidebar không bị chặn ~1s+/lần
  // Session lấy client-side; DashboardShell giữ chrome khi đang load
  return (
    <html
      lang="vi"
      data-theme="light"
      style={{ colorScheme: "light" }}
      suppressHydrationWarning
    >
      <body className={`${sans.variable} antialiased`} suppressHydrationWarning>
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
