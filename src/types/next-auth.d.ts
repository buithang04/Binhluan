import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      role?: string;
    };
    apmAccessToken?: string;
    error?: "IdleTimeout" | "ApmAuthExpired" | "SessionSuperseded";
  }

  interface User {
    role?: string;
    apmAccessToken?: string;
    apmRefreshToken?: string;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    apmAccessToken?: string;
    apmRefreshToken?: string;
    sessionVersion?: number;
    lastActivityAt?: number;
    lastSessionCheckAt?: number;
    error?: "IdleTimeout" | "ApmAuthExpired" | "SessionSuperseded";
  }
}
