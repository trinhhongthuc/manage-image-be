import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface ImageRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  telegramMessageId?: number;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  album?: string;
  tags?: string[];
  createdAt: string;
}

export interface ImageMetadata extends ImageRecord {
  telegramMessageId: number;
  telegramFileId: string;
  telegramFileUniqueId: string;
}

interface Shard {
  items: ImageRecord[];
  sha?: string;
}

interface GitHubContentResponse {
  content?: string;
  sha?: string;
  commit?: { sha?: string };
}

const SHARD_COUNT = 16;
const MAX_WRITE_ATTEMPTS = 3;

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly apiUrl = 'https://api.github.com';
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.get<string>('GITHUB_TOKEN') || '';
    this.owner = this.configService.get<string>('GITHUB_OWNER') || '';
    this.repo = this.configService.get<string>('GITHUB_REPO') || '';
    this.branch = this.configService.get<string>('GITHUB_BRANCH') || 'main';
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.owner && this.repo);
  }

  getConfigSummary() {
    return {
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      configured: this.isConfigured(),
    };
  }

  async readAllRecords(): Promise<ImageRecord[]> {
    this.ensureConfigured();
    const shards = await Promise.all(
      Array.from({ length: SHARD_COUNT }, (_, index) => this.readShard(index)),
    );
    return shards.flatMap((shard) => shard.items);
  }

  async appendRecords(newRecords: ImageRecord[]): Promise<number> {
    if (!newRecords.length) return 0;
    this.ensureConfigured();

    const byShard = new Map<number, ImageRecord[]>();
    for (const record of newRecords) {
      const shard = this.shardFor(record.id);
      const records = byShard.get(shard) ?? [];
      records.push(record);
      byShard.set(shard, records);
    }

    let savedCount = 0;
    for (const [shardIndex, records] of byShard) {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        const current = await this.readShard(shardIndex);
        const existingIds = new Set(current.items.map((record) => record.id));
        const additions: ImageRecord[] = [];
        for (const record of records) {
          if (!existingIds.has(record.id)) {
            additions.push(record);
            existingIds.add(record.id);
          }
        }

        if (!additions.length) break;

        try {
          const result = await this.writeShard(
            shardIndex,
            [...current.items, ...additions],
            current.sha,
            `chore(images): add ${additions.length} record(s) to shard ${this.shardName(shardIndex)}`,
          );
          savedCount += additions.length;
          this.logSavedRecords(shardIndex, additions.length, result.commitSha);
          break;
        } catch (error) {
          if (!this.isShaConflict(error) || attempt === MAX_WRITE_ATTEMPTS) {
            throw error;
          }
        }
      }
    }

    return savedCount;
  }

  async updateRecord(
    id: string,
    updates: Partial<ImageRecord>,
  ): Promise<ImageRecord | null> {
    this.ensureConfigured();
    const shardIndex = this.shardFor(id);

    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.readShard(shardIndex);
      const index = current.items.findIndex((record) => record.id === id);
      if (index === -1) return null;

      const updatedRecord = { ...current.items[index], ...updates };
      const nextItems = [...current.items];
      nextItems[index] = updatedRecord;

      try {
        await this.writeShard(
          shardIndex,
          nextItems,
          current.sha,
          `chore(images): update record ${id}`,
        );
        return updatedRecord;
      } catch (error) {
        if (!this.isShaConflict(error) || attempt === MAX_WRITE_ATTEMPTS) {
          throw error;
        }
      }
    }

    return null;
  }

  async removeRecord(id: string): Promise<boolean> {
    this.ensureConfigured();
    const shardIndex = this.shardFor(id);

    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.readShard(shardIndex);
      const nextItems = current.items.filter((record) => record.id !== id);
      if (nextItems.length === current.items.length) return false;

      try {
        await this.writeShard(
          shardIndex,
          nextItems,
          current.sha,
          `chore(images): remove record ${id}`,
        );
        return true;
      } catch (error) {
        if (!this.isShaConflict(error) || attempt === MAX_WRITE_ATTEMPTS) {
          throw error;
        }
      }
    }

    return false;
  }

  private async readShard(index: number): Promise<Shard> {
    const path = this.shardPath(index);
    const url = `${this.apiUrl}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`;

    let response;
    try {
      response = await axios.get<GitHubContentResponse>(url, {
        headers: this.getHeaders(),
        timeout: 15000,
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { items: [] };
      }
      throw error;
    }

    const content = response.data.content?.replace(/\s/g, '') ?? '';
    if (!content) {
      return { items: [], sha: response.data.sha };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`Metadata ${path} is not valid JSON${reason}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Metadata ${path} must contain a JSON array.`);
    }

    return { items: parsed as ImageRecord[], sha: response.data.sha };
  }

  private async writeShard(
    index: number,
    items: ImageRecord[],
    sha: string | undefined,
    message: string,
  ): Promise<{ commitSha?: string }> {
    const path = this.shardPath(index);
    const url = `${this.apiUrl}/repos/${this.owner}/${this.repo}/contents/${path}`;

    try {
      const response = await axios.put<GitHubContentResponse>(
        url,
        {
          message,
          content: Buffer.from(`${JSON.stringify(items, null, 2)}\n`).toString(
            'base64',
          ),
          branch: this.branch,
          ...(sha ? { sha } : {}),
        },
        { headers: this.getHeaders(), timeout: 30000 },
      );
      return { commitSha: response.data.commit?.sha };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status;
        if (status === 409 || status === 422) {
          const conflict = new Error(
            `GitHub rejected a stale SHA while writing ${path} (${status}).`,
          );
          Object.assign(conflict, { status });
          throw conflict;
        }
      }
      throw error;
    }
  }

  private shardFor(id: string): number {
    const suffix = id.slice(-2);
    if (!/^[0-9a-f]{2}$/i.test(suffix)) {
      throw new Error(
        `Image id "${id}" must end with two hexadecimal characters.`,
      );
    }
    return Number.parseInt(suffix, 16) % SHARD_COUNT;
  }

  private shardName(index: number): string {
    return index.toString(16).padStart(2, '0');
  }

  private shardPath(index: number): string {
    return `metadata/images-${this.shardName(index)}.json`;
  }

  private isShaConflict(error: unknown): boolean {
    return (
      error instanceof Error &&
      'status' in error &&
      (error.status === 409 || error.status === 422)
    );
  }

  private logSavedRecords(index: number, count: number, commitSha?: string) {
    const commit = commitSha ? ` (commit ${commitSha})` : '';
    this.logger.log(
      `Saved ${count} records to GitHub metadata (${this.shardPath(index)} on ${this.branch})${commit}.`,
    );
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'GitHub credentials missing. Please set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO in .env.',
      );
    }
  }

  private getHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NestJS-Image-Upload-Server',
    };
  }
}
