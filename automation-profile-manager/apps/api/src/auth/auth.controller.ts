import { Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { loginSchema } from "@apm/shared";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Brute-force protection: 10 attempts / minute / IP */
  @Post("login")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async login(@Body() body: unknown) {
    const data = loginSchema.parse(body);
    return this.auth.login(data.email, data.password, {
      service: data.service === true,
    });
  }

  @Post("refresh")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post("logout")
  async logout(@Body() body: { refreshToken: string }) {
    return this.auth.logout(body.refreshToken);
  }
}
