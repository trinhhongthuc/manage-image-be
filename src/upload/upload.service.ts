import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { TelegramService, TelegramFileResult } from './telegram.service';
import {
  GithubService,
  GithubUploadResult,
  ImageRecord,
} from './github.service';
import { StagingQueueService, SessionManifest } from './staging-queue.service';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { STAGING_DIRECTORY } from './multer.config';

export interface ProcessUploadOptions {
  album?: string;
  caption?: string;
  isFast?: boolean;
}

export interface ClientUploadResponse {
  telegramFileId?: string;
  telegramMessageId?: number;
  url?: string;
  id?: string;
  filename?: string;
  storedFilename?: string;
  mimeType?: string;
  size?: number;
  album?: string;
  createdAt?: string;

  items: ImageRecord[];
  errors: Array<{ filename: string; error: string }>;
  error?: string;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly githubService: GithubService,
    private readonly stagingQueueService: StagingQueueService,
  ) {}

  /**
   * Đưa một batch ảnh vào hàng đợi lưu trữ và xử lý ngầm (Client không cần chờ)
   */
  async enqueueStagingBatch(
    sessionId: string,
    files: Express.Multer.File[],
    options: ProcessUploadOptions = {},
  ): Promise<SessionManifest> {
    if (!files || files.length === 0) {
      throw new BadRequestException('Không có file trong batch.');
    }

    return this.stagingQueueService.enqueueBatch(sessionId, files, {
      album: options.album,
      caption: options.caption,
      isFast: options.isFast,
    });
  }

  /**
   * Lấy tiến độ xử lý ngầm của một session
   */
  async getSessionStatus(sessionId: string) {
    return this.stagingQueueService.getSessionStatus(sessionId);
  }

  /**
   * Process multiple files uploaded via multipart/form-data.
   * Returns exact format expected by client: { items: ImageRecord[], errors: [] }
   */
  async processImages(
    files: Express.Multer.File[],
    options: ProcessUploadOptions = {},
  ): Promise<ClientUploadResponse> {
    if (!files || files.length === 0) {
      throw new BadRequestException('Không có file.');
    }

    const album = options.album?.trim() || '';
    const caption = options.caption?.trim() || album || undefined;
    const isFast = options.isFast || false;

    this.logger.log(
      `Bắt đầu xử lý ${files.length} files (lưu tạm tại file system). Album: "${album}"`,
    );

    // Bước 1: Gửi lên Telegram theo kiểu Album (gom nhóm 2 - 10 ảnh / album)
    let telegramResults: TelegramFileResult[] = [];
    try {
      telegramResults = await this.telegramService.sendImagesInAlbums(
        files,
        caption,
        isFast,
      );
    } catch (err: any) {
      this.logger.error(`Telegram upload error: ${err.message}`);
      telegramResults = files.map((f) => ({
        filename: f.filename,
        originalName: f.originalname,
        success: false,
        error: err.message,
      }));
    }

    // Map kết quả Telegram theo originalName / filename
    const telegramMap = new Map<string, TelegramFileResult>();
    telegramResults.forEach((res) => {
      telegramMap.set(res.filename, res);
    });

    // Bước 2: Lưu từng file lên GitHub
    let githubResults: GithubUploadResult[] = [];
    try {
      githubResults = await this.githubService.uploadFiles(
        files,
        album || undefined,
      );
    } catch (err: any) {
      this.logger.error(`GitHub upload error: ${err.message}`);
      githubResults = files.map((f) => ({
        filename: f.filename,
        originalName: f.originalname,
        path: f.filename,
        success: false,
        error: err.message,
      }));
    }

    const githubMap = new Map<string, GithubUploadResult>();
    githubResults.forEach((res) => {
      githubMap.set(res.filename, res);
    });

    // Bước 3: Kiểm tra, tạo record và xoá file local nếu tải lên thành công
    // "cái nào tải lên rồi thì xóa ở server đi"
    const records: ImageRecord[] = [];
    const errors: Array<{ filename: string; error: string }> = [];

    for (const file of files) {
      const teleRes = telegramMap.get(file.filename);
      const ghRes = githubMap.get(file.filename);

      const teleOk = teleRes?.success ?? false;
      const ghOk = ghRes?.success ?? false;

      if (teleOk && ghOk) {
        // Tải lên thành công cả Telegram và GitHub -> Xoá file ở server local
        try {
          if (fs.existsSync(file.path)) {
            await fs.promises.unlink(file.path);
            this.logger.log(`Đã xoá file tạm local: ${file.path}`);
          }
        } catch (unlinkErr: any) {
          this.logger.error(
            `Không thể xoá file tạm ${file.path}: ${unlinkErr.message}`,
          );
        }

        records.push({
          id: `img_${randomUUID()}`,
          filename: file.originalname,
          storedFilename: file.filename,
          mimeType: file.mimetype,
          size: file.size,
          url: ghRes?.rawUrl || ghRes?.htmlUrl || '',
          githubUrl: ghRes?.htmlUrl,
          rawUrl: ghRes?.rawUrl,
          telegramMessageId: teleRes?.messageId,
          telegramFileId: teleRes?.fileId,
          album: album || undefined,
          tags: [],
          createdAt: new Date().toISOString(),
          sha: ghRes?.sha,
          path: ghRes?.path,
        });
      } else {
        const errorDetails = [
          !teleOk ? `Telegram: ${teleRes?.error || 'thất bại'}` : null,
          !ghOk ? `GitHub: ${ghRes?.error || 'thất bại'}` : null,
        ]
          .filter(Boolean)
          .join(', ');

        errors.push({
          filename: file.originalname,
          error: errorDetails || 'Upload không hoàn tất.',
        });

        // Nếu thất bại vẫn dọn file sau khi ghi nhận lỗi nếu cần (hoặc giữ để debug)
        try {
          if (fs.existsSync(file.path)) {
            await fs.promises.unlink(file.path);
          }
        } catch {}
      }
    }

    // Bước 4: Lưu danh sách metadata records lên GitHub (để GET/DELETE hoạt động)
    if (records.length > 0) {
      try {
        await this.githubService.appendRecords(records);
      } catch (ghMetaErr: any) {
        this.logger.warn(
          `Không thể cập nhật metadata records trên GitHub: ${ghMetaErr.message}`,
        );
      }
    }

    const isCompleteFailure = errors.length > 0 && records.length === 0;

    if (isCompleteFailure) {
      throw new HttpException(
        {
          items: [],
          errors,
          error: errors[0]?.error || 'Upload thất bại.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const first = records[0] || ({} as Partial<ImageRecord>);

    return {
      telegramFileId: first.telegramFileId || '',
      telegramMessageId: Number(first.telegramMessageId || 0),
      url: first.url || '',
      id: first.id || '',
      filename: first.filename || '',
      storedFilename: first.storedFilename,
      mimeType: first.mimeType || '',
      size: first.size || 0,
      album: first.album,
      createdAt: first.createdAt || new Date().toISOString(),

      items: records,
      errors,
      error: undefined,
    };
  }

  /**
   * Process upload from an image URL (matching client application/json handler)
   */
  async processUrlUpload(body: {
    url?: string;
    filename?: string;
    album?: string;
  }): Promise<{
    success: boolean;
    async: true;
    sessionId: string;
    batchReceived: number;
    totalQueued: number;
    status: string;
  }> {
    if (!body.url || typeof body.url !== 'string') {
      throw new BadRequestException('Vui lòng cung cấp URL ảnh hợp lệ.');
    }

    // 1. Tải file từ URL về bộ đệm
    const response = await axios.get(body.url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 30000,
    });

    const mimeType = String(response.headers['content-type'] || 'image/jpeg');
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      throw new BadRequestException(
        `URL không phải là file ảnh hoặc video hợp lệ (${mimeType}).`,
      );
    }

    const buffer = Buffer.from(response.data);
    if (buffer.length > 50 * 1024 * 1024) {
      throw new HttpException(
        'Kích thước file vượt quá 50 MB.',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    let filename = body.filename?.trim();
    if (!filename) {
      try {
        const parsed = new URL(body.url);
        filename = parsed.pathname.split('/').pop()?.split('?')[0];
      } catch {
        filename = `url_media_${Date.now()}`;
      }
    }
    if (!filename || !filename.includes('.')) {
      const ext =
        mimeType.split('/')[1]?.replace('jpeg', 'jpg').split(';')[0] || 'jpg';
      filename = `${filename || `url_media_${Date.now()}`}.${ext}`;
    }

    // Save the downloaded file in staging before acknowledging the background job.
    const sessionId = `sess_${randomUUID()}`;
    const sessionDir = path.join(STAGING_DIRECTORY, sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const storedFilename = `${Date.now()}_${randomUUID().slice(0, 8)}_${filename}`;
    const filePath = path.join(sessionDir, storedFilename);
    await fs.promises.writeFile(filePath, buffer);

    const mockMulterFile: Express.Multer.File = {
      fieldname: 'files',
      originalname: filename,
      encoding: '7bit',
      mimetype: mimeType,
      size: buffer.length,
      destination: sessionDir,
      filename: storedFilename,
      path: filePath,
      buffer: buffer,
      stream: fs.createReadStream(filePath),
    };

    const manifest = await this.enqueueStagingBatch(
      sessionId,
      [mockMulterFile],
      {
        album: body.album,
      },
    );
    return {
      success: true,
      async: true,
      sessionId,
      batchReceived: 1,
      totalQueued: manifest.totalFiles,
      status: manifest.status,
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

      if (record.path) {
        try {
          await this.githubService.deleteFile(record.path, record.sha);
        } catch (e: any) {
          this.logger.warn(
            `Could not delete file ${record.path} on GitHub: ${e.message}`,
          );
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

  getServiceStatus() {
    return {
      telegram: {
        configured: this.telegramService.isConfigured(),
      },
      github: this.githubService.getConfigSummary(),
    };
  }
}
