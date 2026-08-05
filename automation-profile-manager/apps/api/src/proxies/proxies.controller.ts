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

  @Get("import/config")
  @Roles("ADMIN")
  getImportConfig() {
    return this.proxies.getImportConfig();
  }

  @Put("import/config")
  @Roles("ADMIN")
  setImportConfig(
    @Body()
    body: {
      curl?: string;
      config?: Record<string, unknown>;
      preset?: "homeproxy" | "webshare";
      url?: string;
      authorization?: string;
      merchantId?: string;
    },
  ) {
    return this.proxies.setImportConfig(body as never);
  }

  @Post("import/config/run")
  @Roles("ADMIN")
  runImportConfig(@Body() body: { disableOthers?: boolean }) {
    return this.proxies.importFromConfig(body);
  }

  /** Cooldown proxy sau mỗi bài Maps — cấu hình chung (Admin → Proxy). */
  @Get("settings/maps-cooldown")
  @Roles("ADMIN")
  getMapsCooldown() {
    return this.proxies.getMapsCooldownMinutes();
  }

  @Put("settings/maps-cooldown")
  @Roles("ADMIN")
  setMapsCooldown(@Body() body: { cooldownMinutes?: number }) {
    return this.proxies.setMapsCooldownMinutes(body?.cooldownMinutes ?? 60);
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

  @Post("import/homeproxy")
  @Roles("ADMIN")
  importHomeProxy(
    @Body()
    body: {
      apiToken?: string;
      merchantId?: string;
      maxProfiles?: number;
      onlyStatic?: boolean;
      disableOthers?: boolean;
    },
  ) {
    return this.proxies.importFromHomeProxy(body);
  }

  @Post("test")
  @Roles("ADMIN")
  testRaw(
    @Body()
    body: {
      host?: string;
      port?: number;
      username?: string | null;
      password?: string | null;
      protocol?: string;
      deep?: boolean;
    },
  ) {
    return this.proxies.testConnection(body);
  }

  @Post("test-many")
  @Roles("ADMIN")
  testMany(@Body() body: { ids?: string[]; deep?: boolean }) {
    return this.proxies.testMany(body?.ids, body?.deep !== false);
  }

  @Post(":id/test")
  @Roles("ADMIN")
  testOne(
    @Param("id") id: string,
    @Body() body: { deep?: boolean },
  ) {
    return this.proxies.testConnection({ id, deep: body?.deep !== false });
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
