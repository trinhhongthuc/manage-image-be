import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { TelegramService } from './telegram.service';
import { GithubService } from './github.service';
import { StagingQueueService } from './staging-queue.service';
import * as fs from 'fs';

jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    existsSync: jest.fn(),
    promises: {
      ...original.promises,
      unlink: jest.fn(),
    },
  };
});

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
            sendImagesInAlbums: jest.fn().mockResolvedValue([
              {
                filename: 'stored_test1.jpg',
                originalName: 'test1.jpg',
                success: true,
                messageId: 100,
                fileId: 'tele_123',
              },
            ]),
            isConfigured: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: GithubService,
          useValue: {
            uploadFiles: jest.fn().mockResolvedValue([
              {
                filename: 'stored_test1.jpg',
                originalName: 'test1.jpg',
                path: 'uploads/stored_test1.jpg',
                success: true,
                htmlUrl: 'https://github.com/test',
                rawUrl: 'https://raw.githubusercontent.com/test',
              },
            ]),
            appendRecords: jest.fn().mockResolvedValue(undefined),
            isConfigured: jest.fn().mockReturnValue(true),
            getConfigSummary: jest.fn().mockReturnValue({}),
          },
        },
        {
          provide: StagingQueueService,
          useValue: {
            enqueueBatch: jest.fn(),
            getSessionStatus: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
    telegramService = module.get<TelegramService>(TelegramService);
    githubService = module.get<GithubService>(GithubService);
  });

  it('should process images, upload to Telegram & GitHub, and delete local files', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);

    const mockFiles = [
      {
        fieldname: 'files',
        originalname: 'test1.jpg',
        filename: 'stored_test1.jpg',
        path: './uploads/stored_test1.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      } as Express.Multer.File,
    ];

    const result = await service.processImages(mockFiles, { caption: 'Test' });

    expect(result.items.length).toBe(1);
    expect(result.items[0].filename).toBe('test1.jpg');
    expect(result.errors.length).toBe(0);
    expect(fs.promises.unlink).toHaveBeenCalledWith('./uploads/stored_test1.jpg');
    expect(telegramService.sendImagesInAlbums).toHaveBeenCalledWith(mockFiles, 'Test', false);
    expect(githubService.uploadFiles).toHaveBeenCalledWith(mockFiles, undefined);
  });
});
