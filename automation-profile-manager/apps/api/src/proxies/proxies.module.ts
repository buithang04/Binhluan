import { Module } from "@nestjs/common";
import { ProxiesController } from "./proxies.controller";
import { ProxiesService } from "./proxies.service";
import { ProxiesSyncService } from "./proxies-sync.service";

@Module({
  controllers: [ProxiesController],
  providers: [ProxiesService, ProxiesSyncService],
  exports: [ProxiesService, ProxiesSyncService],
})
export class ProxiesModule {}
