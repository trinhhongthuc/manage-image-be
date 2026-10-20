import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { GithubService } from './github.service';
import { STAGING_DIRECTORY, UPLOAD_DIRECTORY } from './multer.config';
import { StagingQueueService } from './staging-queue.service';
import { TelegramService } from './telegram.service';

describe('StagingQueueService', () => {
  it.each([true, false])(
    'cleans staged files after background upload completes (success: %s)',
    async (uploadSucceeds) => {
      const sessionId = `test_${randomUUID()}`;
      const sessionDir = path.join(STAGING_DIRECTORY, sessionId);
      await fs.promises.mkdir(sessionDir, { recursive: true });
      const relativeFilePath = path.join(
        UPLOAD_DIRECTORY,
        `${sessionId}_photo.jpg`,
      );
      const filePath = path.resolve(relativeFilePath);
      await fs.promises.writeFile(filePath, 'photo');

      const telegramService = {
        sendImagesInAlbums: jest.fn(async (files: Express.Multer.File[]) => {
          await Promise.all(
            files.map(
              ({ stream }) =>
                new Promise<void>((resolve) => {
                  stream.once('close', resolve);
                  stream.destroy();
                }),
            ),
          );
          return [
            {
              filename: 'photo.jpg',
              originalName: 'photo.jpg',
              success: uploadSucceeds,
              ...(uploadSucceeds ? {} : { error: 'Telegram unavailable' }),
            },
          ];
        }),
      } as unknown as TelegramService;
      const githubService = {
        uploadFiles: jest.fn().mockResolvedValue([
          {
            filename: 'photo.jpg',
            originalName: 'photo.jpg',
            path: 'photo.jpg',
            success: true,
            rawUrl: 'https://example.test/photo.jpg',
          },
        ]),
        appendRecords: jest.fn(),
      } as unknown as GithubService;

      try {
        const queue = new StagingQueueService(telegramService, githubService);
        await queue.enqueueBatch(sessionId, [
          {
            originalname: 'photo.jpg',
            filename: 'photo.jpg',
            path: relativeFilePath,
            size: 5,
            mimetype: 'image/jpeg',
          } as Express.Multer.File,
        ]);

        let status: Awaited<ReturnType<typeof queue.getSessionStatus>> = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          status = await queue.getSessionStatus(sessionId);
          if (status?.status === (uploadSucceeds ? 'completed' : 'failed'))
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(status?.status).toBe(uploadSucceeds ? 'completed' : 'failed');
        expect(status?.files).toEqual([
          {
            id: expect.any(String),
            filename: 'photo.jpg',
            status: uploadSucceeds ? 'done' : 'failed',
            ...(uploadSucceeds
              ? {}
              : { error: 'Telegram: Telegram unavailable' }),
          },
        ]);
        await expect(fs.promises.access(filePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(
          fs.promises.access(path.join(sessionDir, 'manifest.json')),
        ).resolves.toBeUndefined();
      } finally {
        await fs.promises.rm(sessionDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );
});
