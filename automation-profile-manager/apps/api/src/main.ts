import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { requireSecrets } from "./config/require-secrets";
import { resolveCorsOrigins } from "./config/origins";

loadEnv({ path: resolve(__dirname, "../.env") });
requireSecrets();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
