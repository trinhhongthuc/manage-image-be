import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { TelegramService } from './telegram.service';
import { GithubService, ImageMetadata, ImageRecord } from './github.service';

interface UploadJobFile {
  file: Express.Multer.File;
  attempts: number;
  status: 'pending' | 'uploading' | 'success' | 'failed';
  error?: string;
  record?: ImageMetadata;
}

interface UploadJob {
  id: string;
  album?: string;
  files: UploadJobFile[];
  status: 'processing' | 'completed';
}

const DEFAULT_UPLOAD_ALBUM = 'Bi/SX';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly uploadJobs = new Map<string, UploadJob>();

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
    const committed = await this.githubService.appendRecords(items);
    return { success: true, committed };
  }

  async uploadFile(
    file: Express.Multer.File,
    album?: string,
  ): Promise<{ success: true; item: ImageRecord }> {
    if (!file?.path || !file.originalname) {
      throw new BadRequestException('Cần gửi một file hợp lệ.');
    }

    let telegramMessage: Awaited<ReturnType<TelegramService['uploadDocument']>>;
    try {
      if (album !== undefined && typeof album !== 'string') {
        throw new BadRequestException('Album phải là chuỗi.');
      }
      if (!this.telegramService.isConfigured()) {
        throw new ServiceUnavailableException(
          'Telegram chưa được cấu hình để upload ảnh.',
        );
      }
      if (!this.githubService.getConfigSummary().configured) {
        throw new ServiceUnavailableException(
          'GitHub chưa được cấu hình để lưu metadata.',
        );
      }

      telegramMessage = await this.telegramService.uploadDocument(file);
    } finally {
      try {
        await unlink(file.path);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )) {
          throw error;
        }
      }
    }

    const { message_id, document } = telegramMessage;
    if (
      !Number.isInteger(message_id) ||
      !document?.file_id ||
      !document.file_unique_id
    ) {
      throw new Error('Telegram response is missing document metadata.');
    }

    const rawMime = document.mime_type || file.mimetype;
    const record: ImageMetadata = {
      id: `img_${randomUUID()}`,
      filename: file.originalname,
      telegramFileId: document.file_id,
      telegramFileUniqueId: document.file_unique_id,
      telegramMessageId: message_id,
      size: document.file_size ?? file.size,
      mimeType: this.resolveMimeType(file.originalname, rawMime),
      createdAt: new Date().toISOString(),
      album: album?.trim() || DEFAULT_UPLOAD_ALBUM,
    };

    await this.githubService.appendRecords([record]);
    return { success: true, item: record };
  }

  startUploadJob(
    files: Express.Multer.File[],
    album?: string,
  ): { jobId: string; status: UploadJob['status']; total: number } {
    if (!files.length) {
      throw new BadRequestException('Cần chọn ít nhất một file.');
    }
    if (album !== undefined && typeof album !== 'string') {
      throw new BadRequestException('Album phải là chuỗi.');
    }

    const job: UploadJob = {
      id: randomUUID(),
      album: album?.trim() || DEFAULT_UPLOAD_ALBUM,
      files: files.map((file) => ({
        file,
        attempts: 0,
        status: 'pending',
      })),
      status: 'processing',
    };
    this.uploadJobs.set(job.id, job);

    void this.processUploadJob(job);
    return { jobId: job.id, status: job.status, total: files.length };
  }

  getUploadJob(jobId: string) {
    const job = this.uploadJobs.get(jobId);
    if (!job) {
      throw new HttpException(
        'Không tìm thấy upload job.',
        HttpStatus.NOT_FOUND,
      );
    }

    const succeeded = job.files.filter(
      (item) => item.status === 'success',
    ).length;
    const failed = job.files.filter((item) => item.status === 'failed').length;
    return {
      jobId: job.id,
      status: job.status,
      total: job.files.length,
      succeeded,
      failed,
      files: job.files.map(({ file, attempts, status, error }) => ({
        filename: file.originalname,
        attempts,
        status,
        ...(error ? { error } : {}),
      })),
    };
  }

  private async processUploadJob(job: UploadJob): Promise<void> {
    for (const item of job.files) {
      await this.processUploadJobFile(job, item);
    }

    for (let retry = 0; retry < 3; retry += 1) {
      const failedItems = job.files.filter((item) => item.status === 'failed');
      if (!failedItems.length) break;

      for (const item of failedItems) {
        await this.processUploadJobFile(job, item);
      }
    }

    for (const item of job.files) {
      await this.removeTemporaryFile(item.file.path);
    }
    job.status = 'completed';

    const summary = this.getUploadJob(job.id);
    if (summary.failed === 0) {
      this.logger.log(
        `Upload job ${job.id} completed successfully (${summary.succeeded} file(s)).`,
      );
    } else {
      this.logger.error(
        `Upload job ${job.id} completed with ${summary.failed} failed file(s): ${JSON.stringify(summary.files.filter((file) => file.status === 'failed'))}`,
      );
    }
  }

  private async processUploadJobFile(
    job: UploadJob,
    item: UploadJobFile,
  ): Promise<void> {
    item.attempts += 1;
    item.status = 'uploading';
    item.error = undefined;

    try {
      if (!this.telegramService.isConfigured()) {
        throw new ServiceUnavailableException(
          'Telegram chưa được cấu hình để upload ảnh.',
        );
      }
      if (!this.githubService.getConfigSummary().configured) {
        throw new ServiceUnavailableException(
          'GitHub chưa được cấu hình để lưu metadata.',
        );
      }

      if (!item.record) {
        const { message_id, document } =
          await this.telegramService.uploadDocument(item.file);
        if (
          !Number.isInteger(message_id) ||
          !document?.file_id ||
          !document.file_unique_id
        ) {
          throw new Error('Telegram response is missing document metadata.');
        }

        const rawMime = document.mime_type || item.file.mimetype;
        item.record = {
          id: `img_${randomUUID()}`,
          filename: item.file.originalname,
          telegramFileId: document.file_id,
          telegramFileUniqueId: document.file_unique_id,
          telegramMessageId: message_id,
          size: document.file_size ?? item.file.size,
          mimeType: this.resolveMimeType(item.file.originalname, rawMime),
          createdAt: new Date().toISOString(),
          ...(job.album ? { album: job.album } : {}),
        };
      }

      await this.githubService.appendRecords([item.record]);
      item.status = 'success';
    } catch (error) {
      item.status = 'failed';
      item.error =
        error instanceof Error ? error.message : 'Unknown upload error.';
      this.logger.warn(
        `Upload job ${job.id}: ${item.file.originalname} attempt ${item.attempts} failed: ${item.error}`,
      );
    }
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      this.logger.error(
        `Could not remove temporary upload file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      !/[0-9a-f]{2}$/i.test(value.id) ||
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

  private resolveMimeType(filename: string, fallback?: string): string {
    if (fallback && fallback !== 'application/octet-stream') {
      return fallback;
    }

    const extension = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
    };

    return mimeTypes[extension ?? ''] ?? fallback ?? 'application/octet-stream';
  }
}
