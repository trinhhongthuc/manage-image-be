import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubService } from './github.service';
import { TelegramService } from './telegram.service';
import { UploadService } from './upload.service';

describe('UploadService', () => {
  let service: UploadService;
  let telegramService: TelegramService;
  let githubService: GithubService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        {
          provide: TelegramService,
          useValue: {
            deleteMessage: jest.fn(),
            uploadDocument: jest.fn(),
            isConfigured: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: GithubService,
          useValue: {
            appendRecords: jest.fn().mockResolvedValue(1),
            getConfigSummary: jest.fn().mockReturnValue({ configured: true }),
          },
        },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
    telegramService = module.get<TelegramService>(TelegramService);
    githubService = module.get<GithubService>(GithubService);
  });

  it('commits only the provided metadata items to GitHub', async () => {
    const item = {
      id: 'img_00000000000000000000000000000001',
      filename: 'photo.jpg',
      telegramFileId: 'telegram-file-id',
      telegramFileUniqueId: 'telegram-file-unique-id',
      telegramMessageId: 123,
      size: 1024,
      mimeType: 'image/jpeg',
      createdAt: '2026-10-21T08:00:00.000Z',
      album: 'optional-folder',
      ignoredExtraField: 'not committed',
    };

    const result = await service.commitMetadata({ items: [item] });

    expect(result).toEqual({
      success: true,
      committed: 1,
    });
    expect(githubService.appendRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        id: item.id,
        filename: item.filename,
        telegramFileId: item.telegramFileId,
        telegramFileUniqueId: item.telegramFileUniqueId,
        telegramMessageId: item.telegramMessageId,
        size: item.size,
        mimeType: item.mimeType,
        createdAt: item.createdAt,
        album: item.album,
      }),
    ]);
    expect(telegramService.deleteMessage).not.toHaveBeenCalled();
  });

  it('uploads a file to Telegram and commits mapped metadata with its album', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manage-image-test-'));
    const filePath = join(directory, 'upload');
    await writeFile(filePath, 'image');
    const file = {
      path: filePath,
      originalname: 'photo.jpg',
      mimetype: 'application/octet-stream',
      size: 5,
    } as Express.Multer.File;
    jest.spyOn(telegramService, 'uploadDocument').mockResolvedValue({
      message_id: 456,
      document: {
        file_id: 'telegram-file-id',
        file_unique_id: 'telegram-file-unique-id',
        file_size: 10,
        mime_type: 'application/octet-stream',
      },
    });

    const result = await service.uploadFile(file, 'vacation');

    expect(result).toMatchObject({
      success: true,
      item: {
        id: expect.stringMatching(/^img_[0-9a-f-]{36}$/),
        filename: 'photo.jpg',
        telegramFileId: 'telegram-file-id',
        telegramFileUniqueId: 'telegram-file-unique-id',
        telegramMessageId: 456,
        size: 10,
        mimeType: 'image/jpeg',
        album: 'vacation',
      },
    });
    expect(githubService.appendRecords).toHaveBeenCalledWith([result.item]);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true });
  });

  it('retries failed job files three times and removes their temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manage-image-job-test-'));
    const filePath = join(directory, 'upload');
    await writeFile(filePath, 'image');
    const file = {
      path: filePath,
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 5,
    } as Express.Multer.File;
    jest
      .spyOn(telegramService, 'uploadDocument')
      .mockRejectedValue(new Error('Telegram unavailable'));

    const { jobId } = service.startUploadJob([file], 'vacation');
    let status = service.getUploadJob(jobId);
    for (
      let attempt = 0;
      attempt < 20 && status.status !== 'completed';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      status = service.getUploadJob(jobId);
    }

    expect(status).toMatchObject({
      status: 'completed',
      total: 1,
      succeeded: 0,
      failed: 1,
      files: [{ filename: 'photo.jpg', attempts: 4, status: 'failed' }],
    });
    expect(telegramService.uploadDocument).toHaveBeenCalledTimes(4);
    expect(githubService.appendRecords).not.toHaveBeenCalled();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true });
  });

  it('rejects malformed metadata without calling GitHub', async () => {
    await expect(
      service.commitMetadata({ items: [{ id: 'missing-required-fields' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(githubService.appendRecords).not.toHaveBeenCalled();
    expect(telegramService.deleteMessage).not.toHaveBeenCalled();
  });

  it('rejects IDs that cannot be assigned to a metadata shard', async () => {
    await expect(
      service.commitMetadata({
        items: [
          {
            id: 'img_example',
            filename: 'photo.jpg',
            telegramFileId: 'telegram-file-id',
            telegramFileUniqueId: 'telegram-file-unique-id',
            telegramMessageId: 123,
            size: 1024,
            mimeType: 'image/jpeg',
            createdAt: '2026-10-21T08:00:00.000Z',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(githubService.appendRecords).not.toHaveBeenCalled();
  });
});
