import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import { GithubService, ImageRecord } from './github.service';

jest.mock('axios');

const mockedAxios = jest.mocked(axios);

describe('GithubService', () => {
  let service: GithubService;

  beforeEach(async () => {
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockedAxios.isAxiosError.mockImplementation((error: unknown) =>
      Boolean(
        error &&
        typeof error === 'object' &&
        'isAxiosError' in error &&
        error.isAxiosError === true,
      ),
    );
    const config = {
      GITHUB_TOKEN: 'server-token',
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'metadata',
      GITHUB_BRANCH: 'main',
    };
    const module = await Test.createTestingModule({
      providers: [
        GithubService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => config[key as keyof typeof config]),
          },
        },
      ],
    }).compile();
    service = module.get<GithubService>(GithubService);
  });

  it('appends metadata to the ID shard using its current SHA', async () => {
    const record: ImageRecord = {
      id: 'img_00000000000000000000000000000011',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      createdAt: '2026-10-21T08:00:00.000Z',
    };
    mockedAxios.get.mockResolvedValue({
      data: {
        content: Buffer.from('[]').toString('base64'),
        sha: 'current-sha',
      },
    } as never);
    mockedAxios.put.mockResolvedValue({
      data: { commit: { sha: 'new-commit-sha' } },
    } as never);

    await expect(service.appendRecords([record])).resolves.toBe(1);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/metadata/contents/metadata/images-01.json?ref=main',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer server-token',
        }),
      }),
    );
    expect(mockedAxios.put).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/metadata/contents/metadata/images-01.json',
      expect.objectContaining({
        sha: 'current-sha',
        branch: 'main',
        content: Buffer.from(JSON.stringify([record], null, 2) + '\n').toString(
          'base64',
        ),
      }),
      expect.any(Object),
    );
  });

  it('rereads the shard and retries when the GitHub SHA conflicts', async () => {
    const existing: ImageRecord = {
      id: 'img_00000000000000000000000000000021',
      filename: 'existing.jpg',
      mimeType: 'image/jpeg',
      size: 100,
      createdAt: '2026-10-20T08:00:00.000Z',
    };
    const addition: ImageRecord = {
      ...existing,
      id: 'img_00000000000000000000000000000031',
      filename: 'new.jpg',
    };
    const encoded = (records: ImageRecord[]) =>
      Buffer.from(JSON.stringify(records)).toString('base64');
    mockedAxios.get
      .mockResolvedValueOnce({
        data: { content: encoded([existing]), sha: 'stale-sha' },
      } as never)
      .mockResolvedValueOnce({
        data: { content: encoded([existing]), sha: 'fresh-sha' },
      } as never);
    const conflict = Object.assign(new Error('SHA conflict'), {
      isAxiosError: true,
      response: { status: 409 },
    });
    mockedAxios.put.mockRejectedValueOnce(conflict).mockResolvedValueOnce({
      data: { commit: { sha: 'commit-sha' } },
    } as never);

    await expect(service.appendRecords([addition])).resolves.toBe(1);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.put).toHaveBeenCalledTimes(2);
    expect(mockedAxios.put).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ sha: 'fresh-sha' }),
      expect.any(Object),
    );
  });

  it('does not create a commit for records that already exist', async () => {
    const record: ImageRecord = {
      id: 'img_00000000000000000000000000000041',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      createdAt: '2026-10-21T08:00:00.000Z',
    };
    mockedAxios.get.mockResolvedValue({
      data: {
        content: Buffer.from(JSON.stringify([record])).toString('base64'),
        sha: 'current-sha',
      },
    } as never);

    await expect(service.appendRecords([record])).resolves.toBe(0);
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });
});
