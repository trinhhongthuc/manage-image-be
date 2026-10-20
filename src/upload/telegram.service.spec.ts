import { ConfigService } from '@nestjs/config';
import { TelegramFileResult, TelegramService } from './telegram.service';

describe('TelegramService', () => {
  it('retries failed files three times with waits between attempts', async () => {
    const config = {
      get: (key: string) =>
        key === 'TELEGRAM_BOT_TOKEN' ? 'bot-token' : 'chat-id',
    } as unknown as ConfigService;
    const service = new TelegramService(config);
    const internals = service as unknown as {
      sendChunk: (
        files: Express.Multer.File[],
        caption?: string,
      ) => Promise<TelegramFileResult[]>;
      waitBeforeRetry: (attempt: number) => Promise<void>;
    };
    const sendChunk = jest
      .spyOn(internals, 'sendChunk')
      .mockResolvedValueOnce([
        {
          filename: 'photo.jpg',
          originalName: 'photo.jpg',
          success: false,
          error: 'temporary',
        },
      ])
      .mockResolvedValueOnce([
        {
          filename: 'photo.jpg',
          originalName: 'photo.jpg',
          success: false,
          error: 'temporary',
        },
      ])
      .mockResolvedValueOnce([
        {
          filename: 'photo.jpg',
          originalName: 'photo.jpg',
          success: false,
          error: 'temporary',
        },
      ])
      .mockResolvedValueOnce([
        {
          filename: 'photo.jpg',
          originalName: 'photo.jpg',
          success: true,
          fileId: 'file-id',
          messageId: 42,
        },
      ]);
    const waitBeforeRetry = jest
      .spyOn(internals, 'waitBeforeRetry')
      .mockResolvedValue(undefined);

    const result = await service.sendImagesInAlbums([
      {
        filename: 'photo.jpg',
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
      } as Express.Multer.File,
    ]);

    expect(result[0].success).toBe(true);
    expect(sendChunk).toHaveBeenCalledTimes(4);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(3);
  });
});
