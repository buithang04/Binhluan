import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { internalToken } from "../config/require-secrets";

@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.headers["x-internal-token"];
    const expected = internalToken();
    if (!token || token !== expected) {
      throw new UnauthorizedException("Invalid internal token");
    }
    return true;
  }
}
