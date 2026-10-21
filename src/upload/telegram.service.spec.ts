import { ConfigService } from '@nestjs/config';
import { TelegramDocumentMessage, TelegramService } from './telegram.service';

describe('TelegramService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('spaces Telegram uploads by at least 900 milliseconds', async () => {
    jest.useFakeTimers();
    const configService = {
      get: jest.fn((key: string) =>
        key === 'TELEGRAM_BOT_TOKEN' ? 'token' : 'chat',
      ),
    } as unknown as ConfigService;
    const service = new TelegramService(configService);
    const sendDocument = jest
      .spyOn(
        service as unknown as {
          sendDocument(
            file: Express.Multer.File,
          ): Promise<TelegramDocumentMessage>;
        },
        'sendDocument',
      )
      .mockResolvedValue({ message_id: 1 });
    const file = {} as Express.Multer.File;

    await service.uploadDocument(file);
    const secondUpload = service.uploadDocument(file);

    await jest.advanceTimersByTimeAsync(899);
    expect(sendDocument).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await secondUpload;
    expect(sendDocument).toHaveBeenCalledTimes(2);
  });
});
