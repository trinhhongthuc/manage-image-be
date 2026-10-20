import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TelegramService, TelegramFileResult } from './telegram.service';
import {
  GithubService,
  GithubUploadResult,
  ImageRecord,
} from './github.service';
import { STAGING_DIRECTORY, UPLOAD_DIRECTORY } from './multer.config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface FileJobItem {
  id: string;
  originalName: string;
  filename: string;
  filePath: string;
  size: number;
  mimeType: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  telegramMessageId?: number;
  telegramFileId?: string;
  url?: string;
  githubUrl?: string;
  rawUrl?: string;
  sha?: string;
  error?: string;
}

export interface SessionManifest {
  sessionId: string;
  album?: string;
  caption?: string;
  isFast?: boolean;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalFiles: number;
  processedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  files: FileJobItem[];
}

@Injectable()
export class StagingQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StagingQueueService.name);
  private readonly activeWorkers = new Set<string>();

  constructor(
    private readonly telegramService: TelegramService,
    private readonly githubService: GithubService,
  ) {}

  /**
   * Tự động phục hồi các batch chưa hoàn thành khi Server khởi động lại
   */
  async onApplicationBootstrap() {
    this.logger.log(
      'Kiểm tra và phục hồi các session upload dang dở trên ổ đĩa...',
    );
    await this.recoverUnfinishedSessions();
  }

  /**
   * Đăng ký một lô ảnh (batch) vào session hàng đợi
   */
  async enqueueBatch(
    sessionId: string,
    files: Express.Multer.File[],
    options: { album?: string; caption?: string; isFast?: boolean } = {},
  ): Promise<SessionManifest> {
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = path.join(STAGING_DIRECTORY, cleanSessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const manifest = await this.loadOrCreateManifest(
      cleanSessionId,
      sessionDir,
      options,
    );

    // Thêm các file mới vào danh sách manifest
    for (const file of files) {
      manifest.files.push({
        id: `img_${randomUUID()}`,
        originalName: file.originalname,
        filename: file.filename,
        filePath: file.path,
        size: file.size,
        mimeType: file.mimetype,
        status: 'pending',
      });
    }

    manifest.totalFiles = manifest.files.length;
    manifest.updatedAt = new Date().toISOString();
    manifest.status = 'queued';

    await this.saveManifest(sessionDir, manifest);
    this.logger.log(
      `[Session ${cleanSessionId}] Đã nhận lô ${files.length} ảnh. Tổng ảnh trong hàng đợi: ${manifest.totalFiles}`,
    );

    // Kích hoạt worker xử lý ngầm (chạy độc lập, không block request của client)
    this.triggerWorker(cleanSessionId, sessionDir);

    return manifest;
  }

  /**
   * Lấy trạng thái tiến độ của một session
   */
  async getSessionStatus(sessionId: string) {
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = path.join(STAGING_DIRECTORY, cleanSessionId);
    const manifestPath = path.join(sessionDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    const raw = await fs.promises.readFile(manifestPath, 'utf8');
    const manifest: SessionManifest = JSON.parse(raw);
    const doneCount = manifest.files.filter((f) => f.status === 'done').length;
    const failedCount = manifest.files.filter(
      (f) => f.status === 'failed',
    ).length;
    const pendingCount = manifest.files.filter(
      (f) => f.status === 'pending' || f.status === 'processing',
    ).length;

    const percent =
      manifest.totalFiles > 0
        ? Math.round(((doneCount + failedCount) / manifest.totalFiles) * 100)
        : 0;

    return {
      sessionId: manifest.sessionId,
      album: manifest.album,
      status: manifest.status,
      totalFiles: manifest.totalFiles,
      doneCount,
      failedCount,
      pendingCount,
      percent,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      files: manifest.files.map(({ id, originalName, status, error }) => ({
        id,
        filename: originalName,
        status,
        ...(error ? { error } : {}),
      })),
    };
  }

  /**
   * Tiến trình Worker chạy ngầm xử lý từng batch ảnh trong session
   */
  private async triggerWorker(sessionId: string, sessionDir: string) {
    if (this.activeWorkers.has(sessionId)) {
      // Worker cho session này đang chạy, nó sẽ tự động lặp để lấy các file mới vừa enqueue
      return;
    }

    this.activeWorkers.add(sessionId);

    // Chạy ngầm trong microtask
    setImmediate(async () => {
      try {
        await this.runWorkerLoop(sessionId, sessionDir);
      } catch (err: any) {
        this.logger.error(
          `Lỗi worker trong session ${sessionId}: ${err.message}`,
        );
      } finally {
        this.activeWorkers.delete(sessionId);
        try {
          const latestManifest = await this.loadManifest(sessionDir);
          if (latestManifest?.files.some((file) => file.status === 'pending')) {
            this.triggerWorker(sessionId, sessionDir);
          }
        } catch (err: any) {
          this.logger.error(
            `Không thể kiểm tra lại session ${sessionId}: ${err.message}`,
          );
        }
      }
    });
  }

  private async runWorkerLoop(sessionId: string, sessionDir: string) {
    this.logger.log(
      `[Worker ${sessionId}] Bắt đầu chu trình xử lý ảnh ngầm...`,
    );

    while (true) {
      const manifest = await this.loadManifest(sessionDir);
      if (!manifest) break;

      // Lấy các file đang ở trạng thái pending
      const pendingItems = manifest.files.filter((f) => f.status === 'pending');
      if (pendingItems.length === 0) {
        const allCompleted = manifest.files.every(
          (f) => f.status === 'done' || f.status === 'failed',
        );
        if (allCompleted) {
          manifest.status = manifest.files.some((f) => f.status === 'failed')
            ? 'failed'
            : 'completed';
          manifest.updatedAt = new Date().toISOString();
          await this.saveManifest(sessionDir, manifest);
          await this.cleanupSessionFiles(sessionDir, manifest.files);
          this.logger.log(
            `[Worker ${sessionId}] Hoàn tất session ${sessionId} với trạng thái ${manifest.status}.`,
          );
        }
        break;
      }

      // Gom tối đa 10 ảnh cho 1 album Telegram
      const chunkItems = pendingItems.slice(0, 10);

      // Đánh dấu processing
      for (const item of chunkItems) {
        item.status = 'processing';
      }
      manifest.status = 'processing';
      await this.saveManifest(sessionDir, manifest);

      // Tạo Multer File giả lập từ file đã lưu trên ổ đĩa
      const multerFiles: Express.Multer.File[] = chunkItems
        .filter((item) => fs.existsSync(item.filePath))
        .map((item) => ({
          fieldname: 'files',
          originalname: item.originalName,
          encoding: '7bit',
          mimetype: item.mimeType,
          size: item.size,
          destination: sessionDir,
          filename: item.filename,
          path: item.filePath,
          buffer: Buffer.alloc(0),
          stream: fs.createReadStream(item.filePath),
        }));

      if (multerFiles.length === 0) {
        for (const item of chunkItems) {
          item.status = 'failed';
          item.error = 'File không tồn tại trên ổ đĩa';
        }
        await this.saveManifest(sessionDir, manifest);
        continue;
      }

      this.logger.log(
        `[Worker ${sessionId}] Đang tải album ${multerFiles.length} ảnh lên Telegram...`,
      );

      // 1. Gửi Telegram Album (2-10 ảnh)
      let telegramResults: TelegramFileResult[] = [];
      try {
        telegramResults = await this.telegramService.sendImagesInAlbums(
          multerFiles,
          manifest.caption || manifest.album,
          manifest.isFast,
        );
      } catch (err: any) {
        this.logger.error(`[Worker ${sessionId}] Lỗi Telegram: ${err.message}`);
        telegramResults = multerFiles.map((f) => ({
          filename: f.filename,
          originalName: f.originalname,
          success: false,
          error: err.message,
        }));
      }

      const telegramMap = new Map<string, TelegramFileResult>();
      telegramResults.forEach((r) => telegramMap.set(r.filename, r));

      // 2. Commit lên GitHub
      let githubResults: GithubUploadResult[] = [];
      try {
        githubResults = await this.githubService.uploadFiles(
          multerFiles,
          manifest.album,
        );
      } catch (err: any) {
        this.logger.error(`[Worker ${sessionId}] Lỗi GitHub: ${err.message}`);
        githubResults = multerFiles.map((f) => ({
          filename: f.filename,
          originalName: f.originalname,
          path: f.filename,
          success: false,
          error: err.message,
        }));
      }

      const githubMap = new Map<string, GithubUploadResult>();
      githubResults.forEach((r) => githubMap.set(r.filename, r));

      // 3. Xoá file ổ đĩa và cập nhật trạng thái
      const newDoneRecords: ImageRecord[] = [];

      for (const item of chunkItems) {
        const teleRes = telegramMap.get(item.filename);
        const ghRes = githubMap.get(item.filename);

        const teleOk = teleRes?.success ?? false;
        const ghOk = ghRes?.success ?? false;

        if (teleOk && ghOk) {
          item.status = 'done';
          item.telegramMessageId = teleRes?.messageId;
          item.telegramFileId = teleRes?.fileId;
          item.url = ghRes?.rawUrl || ghRes?.htmlUrl || '';
          item.githubUrl = ghRes?.htmlUrl;
          item.rawUrl = ghRes?.rawUrl;
          item.sha = ghRes?.sha;

          newDoneRecords.push({
            id: item.id,
            filename: item.originalName,
            storedFilename: item.filename,
            mimeType: item.mimeType,
            size: item.size,
            url: item.url,
            githubUrl: item.githubUrl,
            rawUrl: item.rawUrl,
            telegramMessageId: item.telegramMessageId,
            telegramFileId: item.telegramFileId,
            album: manifest.album,
            createdAt: new Date().toISOString(),
            sha: item.sha,
          });
        } else {
          item.status = 'failed';
          item.error = [
            !teleOk ? `Telegram: ${teleRes?.error || 'lỗi'}` : null,
            !ghOk ? `GitHub: ${ghRes?.error || 'lỗi'}` : null,
          ]
            .filter(Boolean)
            .join(', ');
        }
      }

      manifest.processedCount = manifest.files.filter(
        (f) => f.status === 'done',
      ).length;
      manifest.failedCount = manifest.files.filter(
        (f) => f.status === 'failed',
      ).length;
      manifest.updatedAt = new Date().toISOString();

      // Cập nhật metadata chung lên GitHub
      if (newDoneRecords.length > 0) {
        let metadataSaved = false;
        try {
          await this.githubService.appendRecords(newDoneRecords);
          metadataSaved = true;
        } catch (metaErr: any) {
          this.logger.error(
            `Không thể cập nhật metadata records: ${metaErr.message}`,
          );
          for (const record of newDoneRecords) {
            const item = chunkItems.find(
              (candidate) => candidate.id === record.id,
            );
            if (item) {
              item.status = 'failed';
              item.error = `GitHub metadata: ${metaErr.message}`;
            }
          }
        }

        if (metadataSaved) {
          for (const record of newDoneRecords) {
            const item = chunkItems.find(
              (candidate) => candidate.id === record.id,
            );
            if (!item || !fs.existsSync(item.filePath)) continue;
            try {
              await fs.promises.unlink(item.filePath);
              this.logger.log(
                `[Worker ${sessionId}] Đã xoá file tạm: ${item.filename}`,
              );
            } catch (unlinkErr: any) {
              this.logger.warn(
                `Không thể xoá file ${item.filePath}: ${unlinkErr.message}`,
              );
            }
          }
        }
      }

      await this.cleanupFiles(chunkItems);

      manifest.processedCount = manifest.files.filter(
        (f) => f.status === 'done',
      ).length;
      manifest.failedCount = manifest.files.filter(
        (f) => f.status === 'failed',
      ).length;
      manifest.updatedAt = new Date().toISOString();
      await this.saveManifest(sessionDir, manifest);

      // Nghỉ ngắn để không nghẽn tài nguyên
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async cleanupSessionFiles(
    sessionDir: string,
    files: FileJobItem[],
  ): Promise<void> {
    await this.cleanupFiles(files);

    const filePaths = new Set(files.map((file) => path.resolve(file.filePath)));
    const entries = await fs.promises.readdir(sessionDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.name === 'manifest.json') continue;
      if (!entry.isFile()) {
        this.logger.warn(
          `Bỏ qua mục staging không phải file khi dọn session: ${path.join(sessionDir, entry.name)}`,
        );
        continue;
      }

      const filePath = path.join(sessionDir, entry.name);
      if (filePaths.has(path.resolve(filePath))) continue;
      try {
        await fs.promises.unlink(filePath);
      } catch (err: any) {
        this.logger.error(
          `Không thể xóa file staging ${filePath}: ${err.message}`,
        );
      }
    }
  }

  private async cleanupFiles(files: FileJobItem[]): Promise<void> {
    const uploadRoot = path.resolve(UPLOAD_DIRECTORY);
    const filePaths = new Set<string>();
    for (const file of files) {
      filePaths.add(path.resolve(file.filePath));

      const filename = path.basename(file.filePath);
      if (filename && filename !== '.' && filename !== path.sep) {
        filePaths.add(path.join(uploadRoot, filename));
      }
    }

    for (const filePath of filePaths) {
      const relativePath = path.relative(uploadRoot, filePath);
      if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        this.logger.error(
          `Bỏ qua đường dẫn file staging ngoài uploads: ${filePath}`,
        );
        continue;
      }

      let deleted = false;
      for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile()) {
            this.logger.warn(`Bỏ qua mục staging không phải file: ${filePath}`);
            deleted = true;
            break;
          }
          await fs.promises.unlink(filePath);
          deleted = true;
          this.logger.log(`Đã xóa file staging: ${filePath}`);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            deleted = true;
            break;
          }
          if (attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, 200 + Math.floor(Math.random() * 300)),
            );
          } else {
            this.logger.error(
              `Không thể xóa file staging ${filePath} sau ${attempt} lần thử: ${err.message}`,
            );
          }
        }
      }
    }
  }

  /**
   * Quét và phục hồi các session còn dang dở khi server restart
   */
  private async recoverUnfinishedSessions() {
    if (!fs.existsSync(STAGING_DIRECTORY)) return;

    try {
      const dirs = await fs.promises.readdir(STAGING_DIRECTORY);
      for (const dirName of dirs) {
        const sessionDir = path.join(STAGING_DIRECTORY, dirName);
        const stat = await fs.promises.stat(sessionDir);
        if (!stat.isDirectory()) continue;

        const manifest = await this.loadManifest(sessionDir);
        if (
          manifest &&
          (manifest.status === 'queued' || manifest.status === 'processing')
        ) {
          this.logger.log(
            `Phát hiện session dang dở: ${manifest.sessionId}. Đang phục hồi...`,
          );

          // Reset các file bị ngắt lúc đang processing về pending
          for (const file of manifest.files) {
            if (file.status === 'processing') {
              file.status = 'pending';
            }
          }
          await this.saveManifest(sessionDir, manifest);
          this.triggerWorker(manifest.sessionId, sessionDir);
        } else if (
          manifest &&
          (manifest.status === 'completed' || manifest.status === 'failed')
        ) {
          await this.cleanupSessionFiles(sessionDir, manifest.files);
        }
      }
    } catch (err: any) {
      this.logger.error(`Lỗi khi quét session phục hồi: ${err.message}`);
    }
  }

  private async loadOrCreateManifest(
    sessionId: string,
    sessionDir: string,
    options: { album?: string; caption?: string; isFast?: boolean },
  ): Promise<SessionManifest> {
    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        return JSON.parse(raw);
      } catch (err: any) {
        this.logger.error(
          `Không thể đọc manifest của session ${sessionId}: ${err.message}`,
        );
        throw err;
      }
    }

    return {
      sessionId,
      album: options.album,
      caption: options.caption,
      isFast: options.isFast,
      status: 'queued',
      totalFiles: 0,
      processedCount: 0,
      failedCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: [],
    };
  }

  private async loadManifest(
    sessionDir: string,
  ): Promise<SessionManifest | null> {
    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf8');
      return JSON.parse(raw);
    } catch (err: any) {
      this.logger.error(
        `Không thể đọc manifest tại ${manifestPath}: ${err.message}`,
      );
      throw err;
    }
  }

  private async saveManifest(sessionDir: string, manifest: SessionManifest) {
    const manifestPath = path.join(sessionDir, 'manifest.json');
    const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await fs.promises.rename(temporaryPath, manifestPath);
  }
}
