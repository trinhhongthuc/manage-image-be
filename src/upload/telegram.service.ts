import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';

export interface TelegramFileResult {
  filename: string;
  originalName: string;
  success: boolean;
  messageId?: number;
  fileId?: string;
  error?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
  }

  isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  /**
   * Send images/videos in Telegram albums (batches of 2-10 items) or single messages.
   * Returns per-file Telegram upload status (including messageId and fileId).
   */
  async sendImagesInAlbums(
    files: Express.Multer.File[],
    baseCaption?: string,
    isFast = false,
  ): Promise<TelegramFileResult[]> {
    if (!this.isConfigured()) {
      throw new Error(
        'Telegram bot token or chat ID is missing. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.',
      );
    }

    const results: TelegramFileResult[] = [];
    const chunks = this.chunkFiles(files, 10);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const batchLabel = `Album batch ${i + 1}/${chunks.length} (${chunk.length} items)`;
      this.logger.log(`Sending ${batchLabel} to Telegram...`);
      const caption =
        chunks.length > 1
          ? `${baseCaption ? baseCaption + ' ' : ''}[${i + 1}/${chunks.length}]`
          : baseCaption;
      let pendingFiles = chunk;
      const chunkResults = new Map<string, TelegramFileResult>();

      for (
        let attempt = 1;
        attempt <= 4 && pendingFiles.length > 0;
        attempt++
      ) {
        let attemptResults: TelegramFileResult[];
        try {
          attemptResults = await this.sendChunk(pendingFiles, caption);
        } catch (error: any) {
          const errorMsg =
            error.response?.data?.description ||
            error.message ||
            'Unknown Telegram API error';
          this.logger.warn(
            `${batchLabel} failed (attempt ${attempt}/4): ${errorMsg}`,
          );
          attemptResults = pendingFiles.map((file) => ({
            filename: file.filename,
            originalName: file.originalname,
            success: false,
            error: errorMsg,
          }));
        }

        for (const result of attemptResults) {
          const previous = chunkResults.get(result.filename);
          if (result.success || !previous?.success) {
            chunkResults.set(result.filename, result);
          }
        }
        pendingFiles = pendingFiles.filter(
          (file) => !chunkResults.get(file.filename)?.success,
        );
        if (pendingFiles.length > 0 && attempt < 4) {
          await this.waitBeforeRetry(attempt);
        }
      }

      results.push(...chunk.map((file) => chunkResults.get(file.filename)!));
      this.logger.log(
        `Finished ${batchLabel} with ${chunk.length - pendingFiles.length}/${chunk.length} successful.`,
      );

      // Respect Telegram rate limits unless fast upload requested
      if (!isFast && i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    }

    return results;
  }

  private async sendChunk(
    files: Express.Multer.File[],
    caption?: string,
  ): Promise<TelegramFileResult[]> {
    if (files.length === 1) {
      const file = files[0];
      const response = await this.sendSingleMedia(file, caption);
      const fileId =
        (response?.photo && response.photo.length > 0
          ? response.photo[response.photo.length - 1]?.file_id
          : null) ||
        response?.video?.file_id ||
        response?.document?.file_id ||
        '';
      const messageId = Number(response?.message_id);
      const success = Boolean(fileId && Number.isInteger(messageId));
      return [
        {
          filename: file.filename,
          originalName: file.originalname,
          success,
          messageId,
          fileId,
          ...(!success
            ? {
                error:
                  'Telegram response did not include a file ID and message ID.',
              }
            : {}),
        },
      ];
    }

    const messages = await this.sendMediaGroup(files, caption);
    return files.map((file, index) => {
      const message = Array.isArray(messages) ? messages[index] : messages;
      const fileId =
        (message?.photo && message.photo.length > 0
          ? message.photo[message.photo.length - 1]?.file_id
          : null) ||
        message?.video?.file_id ||
        message?.document?.file_id ||
        '';
      const messageId = Number(message?.message_id);
      const success = Boolean(fileId && Number.isInteger(messageId));
      return {
        filename: file.filename,
        originalName: file.originalname,
        success,
        messageId,
        fileId,
        ...(!success
          ? {
              error:
                'Telegram response did not include a file ID and message ID.',
            }
          : {}),
      };
    });
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delay = Math.floor(1000 * attempt + Math.random() * 2000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Delete a message on Telegram
   */
  async deleteMessage(messageId: number): Promise<boolean> {
    if (!this.isConfigured() || !messageId) return false;
    const url = `https://api.telegram.org/bot${this.botToken}/deleteMessage`;

    try {
      const res = await axios.post(
        url,
        {
          chat_id: this.chatId,
          message_id: messageId,
        },
        { timeout: 10000 },
      );
      return res.data?.result === true;
    } catch (error: any) {
      this.logger.warn(
        `Failed to delete Telegram message #${messageId}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Send single photo or video
   */
  private async sendSingleMedia(
    file: Express.Multer.File,
    caption?: string,
  ): Promise<any> {
    const isVideo = file.mimetype.startsWith('video/');
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const fieldName = isVideo ? 'video' : 'photo';
    const url = `https://api.telegram.org/bot${this.botToken}/${endpoint}`;
    const form = new FormData();

    form.append('chat_id', this.chatId);
    if (caption) {
      form.append('caption', caption);
    }
    form.append(fieldName, fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    const response = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });

    return response.data.result;
  }

  /**
   * Send group of photos/videos using sendMediaGroup (2 to 10 items)
   */
  private async sendMediaGroup(
    files: Express.Multer.File[],
    caption?: string,
  ): Promise<any> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMediaGroup`;
    const form = new FormData();

    form.append('chat_id', this.chatId);

    const mediaList = files.map((file, index) => {
      const attachName = `media_${index}`;
      const isVideo = file.mimetype.startsWith('video/');
      return {
        type: isVideo ? 'video' : 'photo',
        media: `attach://${attachName}`,
        caption: index === 0 && caption ? caption : undefined,
      };
    });

    form.append('media', JSON.stringify(mediaList));

    files.forEach((file, index) => {
      const attachName = `media_${index}`;
      form.append(attachName, fs.createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype,
      });
    });

    const response = await axios.post(url, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
    });

    return response.data.result;
  }

  private chunkFiles(
    files: Express.Multer.File[],
    size: number,
  ): Express.Multer.File[][] {
    const chunks: Express.Multer.File[][] = [];
    for (let i = 0; i < files.length; i += size) {
      chunks.push(files.slice(i, i + size));
    }
    return chunks;
  }
}
