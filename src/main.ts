import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import express from 'express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable CORS for external client applications
  app.enableCors();

  // Increase payload limits for large bulk uploads
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`Server is running at: http://localhost:${port}`);
  logger.log(`Test Web UI available at: http://localhost:${port}/upload/ui`);
  logger.log(`Upload API endpoint: POST http://localhost:${port}/upload`);
}
bootstrap();
