import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Role } from "@prisma/client";
import { jwtSecret } from "../config/require-secrets";
import { PrismaService } from "../prisma/prisma.service";

export type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  /** ADMIN session version — invalidates tokens from other devices after re-login. */
  sv?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.role === Role.ADMIN) {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { sessionVersion: true, isActive: true },
      });
      if (!user?.isActive) {
        throw new UnauthorizedException("Account disabled");
      }
      if (payload.sv == null || payload.sv !== user.sessionVersion) {
        throw new UnauthorizedException("Session superseded");
      }
    }
    return payload;
  }
}
