import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'node:fs';

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
}

export interface TelegramDocumentMessage {
  message_id: number;
  document?: TelegramDocument;
}

const TELEGRAM_UPLOAD_INTERVAL_MS = 900;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  private uploadQueue: Promise<void> = Promise.resolve();
  private lastUploadStartedAt?: number;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
  }

  isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  uploadDocument(file: Express.Multer.File): Promise<TelegramDocumentMessage> {
    const upload = this.uploadQueue.then(async () => {
      if (this.lastUploadStartedAt !== undefined) {
        const elapsed = Date.now() - this.lastUploadStartedAt;
        const remaining = TELEGRAM_UPLOAD_INTERVAL_MS - elapsed;
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }

      this.lastUploadStartedAt = Date.now();
      return this.sendDocument(file);
    });
    this.uploadQueue = upload.then(
      () => undefined,
      () => undefined,
    );
    return upload;
  }

  private async sendDocument(
    file: Express.Multer.File,
  ): Promise<TelegramDocumentMessage> {
    if (!this.isConfigured()) {
      throw new Error('Telegram is not configured.');
    }

    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('document', createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype,
      knownLength: file.size,
    });

    const response = await axios.post<{
      ok: boolean;
      result?: TelegramDocumentMessage;
      description?: string;
    }>(`https://api.telegram.org/bot${this.botToken}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 60000,
    });

    if (!response.data.ok || !response.data.result) {
      throw new Error(
        `Telegram upload failed: ${response.data.description ?? 'invalid response'}`,
      );
    }

    return response.data.result;
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    if (!this.isConfigured() || !messageId) return false;
    const url = `https://api.telegram.org/bot${this.botToken}/deleteMessage`;

    try {
      const response = await axios.post(
        url,
        {
          chat_id: this.chatId,
          message_id: messageId,
        },
        { timeout: 10000 },
      );
      return response.data?.result === true;
    } catch (error: any) {
      this.logger.warn(
        `Failed to delete Telegram message #${messageId}: ${error.message}`,
      );
      return false;
    }
  }
}
