import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { GithubService, ImageMetadata, ImageRecord } from './github.service';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly githubService: GithubService,
  ) {}

  async commitMetadata(payload: unknown): Promise<{
    success: true;
    committed: number;
  }> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('items' in payload) ||
      !Array.isArray(payload.items)
    ) {
      throw new BadRequestException('Payload phải có dạng { items: [...] }.');
    }

    const items = payload.items.map((item, index) =>
      this.validateMetadataItem(item, index),
    );
    await this.githubService.appendRecords(items);
    return { success: true, committed: items.length };
  }

  private validateMetadataItem(item: unknown, index: number): ImageMetadata {
    const invalid = () =>
      new BadRequestException(
        `Metadata items[${index}] không hợp lệ hoặc thiếu trường bắt buộc.`,
      );
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid();
    }

    const value = item as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      !value.id.trim() ||
      typeof value.filename !== 'string' ||
      !value.filename.trim() ||
      typeof value.telegramFileId !== 'string' ||
      !value.telegramFileId.trim() ||
      typeof value.telegramFileUniqueId !== 'string' ||
      !value.telegramFileUniqueId.trim() ||
      typeof value.telegramMessageId !== 'number' ||
      !Number.isInteger(value.telegramMessageId) ||
      value.telegramMessageId < 0 ||
      typeof value.size !== 'number' ||
      !Number.isFinite(value.size) ||
      value.size < 0 ||
      typeof value.mimeType !== 'string' ||
      !value.mimeType.trim() ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.album !== undefined && typeof value.album !== 'string')
    ) {
      throw invalid();
    }

    return {
      id: value.id,
      filename: value.filename,
      telegramFileId: value.telegramFileId,
      telegramFileUniqueId: value.telegramFileUniqueId,
      telegramMessageId: value.telegramMessageId,
      size: value.size,
      mimeType: value.mimeType,
      createdAt: value.createdAt,
      ...(typeof value.album === 'string' ? { album: value.album } : {}),
    };
  }

  // --- CRUD helpers for compatibility with client GET, PATCH, DELETE ---

  async getAllRecords(): Promise<ImageRecord[]> {
    return this.githubService.readAllRecords();
  }

  async updateRecord(
    id: string,
    updates: Partial<ImageRecord>,
  ): Promise<ImageRecord | null> {
    return this.githubService.updateRecord(id, updates);
  }

  async deleteRecords(
    ids: string[],
  ): Promise<{ deletedCount: number; errors?: any[] }> {
    const allRecords = await this.githubService.readAllRecords();
    const recordsToDelete = allRecords.filter((r) => ids.includes(r.id));
    if (!recordsToDelete.length) {
      throw new HttpException(
        'Không tìm thấy ảnh cần xóa.',
        HttpStatus.NOT_FOUND,
      );
    }

    const errors: Array<{ id: string; error: string }> = [];
    let deletedCount = 0;

    for (const record of recordsToDelete) {
      if (record.telegramMessageId) {
        try {
          await this.telegramService.deleteMessage(record.telegramMessageId);
        } catch (e: any) {
          this.logger.warn(`Could not delete Telegram message: ${e.message}`);
        }
      }

      try {
        const ok = await this.githubService.removeRecord(record.id);
        if (ok) deletedCount++;
      } catch (err: any) {
        errors.push({ id: record.id, error: err.message });
      }
    }

    return {
      deletedCount,
      errors: errors.length ? errors : undefined,
    };
  }

  getGithubStatus() {
    return this.githubService.getConfigSummary();
  }
}
