import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { ImagesController } from './images.controller';
import { UploadService } from './upload.service';
import { TelegramService } from './telegram.service';
import { GithubService } from './github.service';

@Module({
  imports: [ConfigModule],
  controllers: [UploadController, ImagesController],
  providers: [UploadService, TelegramService, GithubService],
  exports: [UploadService, TelegramService, GithubService],
})
export class UploadModule {}
