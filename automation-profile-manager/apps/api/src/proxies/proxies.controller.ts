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
import { ProxiesService } from "./proxies.service";
import { ProxiesSyncService } from "./proxies-sync.service";

@Controller("proxies")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProxiesController {
  constructor(
    private readonly proxies: ProxiesService,
    private readonly sync: ProxiesSyncService,
  ) {}

  @Get()
  @Roles("ADMIN")
  list() {
    return this.proxies.list();
  }

  @Get("sync/status")
  @Roles("ADMIN")
  syncStatus() {
    return this.sync.getStatus();
  }

  @Post("import/webshare")
  @Roles("ADMIN")
  importWebshare(
    @Body()
    body: {
      apiToken?: string;
      mode?: "direct" | "backbone";
      maxProfiles?: number;
      onlyValid?: boolean;
    },
  ) {
    return this.proxies.importFromWebshare(body);
  }

  @Get(":id")
  @Roles("ADMIN")
  get(@Param("id") id: string) {
    return this.proxies.get(id);
  }

  @Get(":id/capacity")
  @Roles("ADMIN")
  capacity(@Param("id") id: string) {
    return this.proxies.capacity(id);
  }

  @Post()
  @Roles("ADMIN")
  create(@Body() body: unknown) {
    return this.proxies.create(body as never);
  }

  @Put(":id")
  @Roles("ADMIN")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.proxies.update(id, body as never);
  }

  @Delete(":id")
  @Roles("ADMIN")
  remove(@Param("id") id: string) {
    return this.proxies.remove(id);
  }
}
