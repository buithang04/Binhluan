import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/login" },
  callbacks: {
    authorized: ({ token, req }) => {
      if (!token) return false;
      if (token.error === "IdleTimeout" || token.error === "ApmAuthExpired" || token.error === "SessionSuperseded") return false;
      const path = req.nextUrl.pathname;
      if (path.startsWith("/admin") && token.role !== "ADMIN") return false;
      return Boolean(token.id || token.sub);
    },
  },
});

export const config = {
  // Khớp cả /admin đúng (không chỉ /admin/...)
  matcher: ["/admin", "/admin/:path*", "/app/:path*", "/projects", "/projects/:path*"],
};
