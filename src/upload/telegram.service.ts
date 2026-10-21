import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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
