import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { AccountsModule } from "./accounts/accounts.module";
import { ProxiesModule } from "./proxies/proxies.module";
import { ProfilesModule } from "./profiles/profiles.module";
import { JobsModule } from "./jobs/jobs.module";
import { WorkersModule } from "./workers/workers.module";
import { StatsModule } from "./stats/stats.module";
import { InternalModule } from "./internal/internal.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { EventsModule } from "./events/events.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    QueueModule,
    EventsModule,
    AuthModule,
    AccountsModule,
    ProxiesModule,
    ProfilesModule,
    JobsModule,
    WorkersModule,
    StatsModule,
    InternalModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
