import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "../auth/guards";
import { ProfilesService } from "./profiles.service";

@Controller("profiles")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  @Roles("ADMIN")
  list() {
    return this.profiles.list();
  }

  @Post("auto-assign")
  @Roles("ADMIN")
  autoAssign(
    @Body()
    body: {
      accountId?: string;
      allUnassigned?: boolean;
      cooldownMinutes?: number;
      openLogin?: boolean;
    },
  ) {
    const openLogin = body?.openLogin !== false;
    if (body?.allUnassigned || !body?.accountId) {
      return this.profiles.autoAssignUnassigned(body?.cooldownMinutes ?? 60, openLogin);
    }
    return this.profiles.autoAssign(body.accountId, body.cooldownMinutes ?? 60, {
      openLogin,
    });
  }

  @Post("stop-jobs")
  @Roles("ADMIN")
  stopJobs(@Body() body: { profileIds?: string[]; all?: boolean }) {
    return this.profiles.stopJobs(body);
  }

  @Post("verify-all-sessions")
  @Roles("ADMIN")
  verifyAllSessions() {
    return this.profiles.verifyAllSessions();
  }

  @Get(":id")
  @Roles("ADMIN")
  get(@Param("id") id: string) {
    return this.profiles.get(id);
  }

  @Post()
  @Roles("ADMIN")
  create(@Body() body: unknown) {
    return this.profiles.create(body as never);
  }

  @Put(":id")
  @Roles("ADMIN")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.profiles.update(id, body as never);
  }

  @Delete(":id")
  @Roles("ADMIN")
  remove(@Param("id") id: string) {
    return this.profiles.remove(id);
  }

  @Post(":id/open-browser")
  @Roles("ADMIN")
  openBrowser(@Param("id") id: string) {
    return this.profiles.openBrowser(id);
  }

  @Post(":id/focus-browser")
  @Roles("ADMIN")
  focusBrowser(@Param("id") id: string) {
    return this.profiles.focusBrowser(id);
  }

  @Post(":id/run")
  @Roles("ADMIN")
  run(@Param("id") id: string, @Body() body: unknown) {
    return this.profiles.enqueue(id, body);
  }

  @Post(":id/release-lease")
  @Roles("ADMIN")
  release(@Param("id") id: string) {
    return this.profiles.releaseLease(id);
  }
}
