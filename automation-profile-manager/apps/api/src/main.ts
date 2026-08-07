import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { requireSecrets } from "./config/require-secrets";
import { resolveCorsOrigins } from "./config/origins";

loadEnv({ path: resolve(__dirname, "../.env") });
requireSecrets();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Avatar upload dùng JSON base64; 8MB file thành khoảng 10.7MB payload.
  app.useBodyParser("json", { limit: "12mb" });
  const origins = resolveCorsOrigins();
  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.setGlobalPrefix("api");
  const port = Number(process.env.API_PORT || 4000);
  await app.listen(port);
  console.log(`API listening on http://127.0.0.1:${port} · CORS: ${origins.join(", ")}`);
}

bootstrap();
