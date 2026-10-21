import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
            isConfigured: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: GithubService,
          useValue: {
            appendRecords: jest.fn().mockResolvedValue(undefined),
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
      id: 'img_example',
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

  it('rejects malformed metadata without calling GitHub', async () => {
    await expect(
      service.commitMetadata({ items: [{ id: 'missing-required-fields' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(githubService.appendRecords).not.toHaveBeenCalled();
    expect(telegramService.deleteMessage).not.toHaveBeenCalled();
  });
});
