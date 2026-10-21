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

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly metadataPath = 'data/records.json';

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

  /**
   * Read all image records from metadata file on GitHub
   */
  async readAllRecords(): Promise<ImageRecord[]> {
    if (!this.isConfigured()) return [];

    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.metadataPath}?ref=${this.branch}`;
    try {
      const res = await axios.get(url, {
        headers: this.getHeaders(),
        timeout: 15000,
      });
      const rawBase64 = res.data?.content || '';
      const jsonStr = Buffer.from(rawBase64, 'base64').toString('utf8');
      return JSON.parse(jsonStr) as ImageRecord[];
    } catch (err: any) {
      if (err.response?.status === 404) {
        return [];
      }
      this.logger.warn(`Could not read records from GitHub: ${err.message}`);
      return [];
    }
  }

  /**
   * Append new image records to metadata file on GitHub
   */
  async appendRecords(newRecords: ImageRecord[]): Promise<void> {
    if (!newRecords.length) return;
    if (!this.isConfigured()) {
      throw new Error(
        'GitHub credentials missing. Please set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO in .env.',
      );
    }

    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.metadataPath}`;

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        let existingRecords: ImageRecord[] = [];
        let existingSha: string | undefined;
        try {
          const getRes = await axios.get(`${url}?ref=${this.branch}`, {
            headers: this.getHeaders(),
            timeout: 15000,
          });
          existingSha = getRes.data?.sha;
          const rawBase64 = getRes.data?.content || '';
          existingRecords = JSON.parse(
            Buffer.from(rawBase64, 'base64').toString('utf8'),
          ) as ImageRecord[];
        } catch (err: any) {
          if (err.response?.status !== 404) throw err;
        }

        const existingIds = new Set(existingRecords.map((record) => record.id));
        const combined = [
          ...existingRecords,
          ...newRecords.filter((record) => !existingIds.has(record.id)),
        ];
        const updatedContent = Buffer.from(
          JSON.stringify(combined, null, 2),
          'utf8',
        ).toString('base64');

        await axios.put(
          url,
          {
            message: `Update image records (${combined.length} items)`,
            content: updatedContent,
            sha: existingSha,
            branch: this.branch,
          },
          { headers: this.getHeaders(), timeout: 30000 },
        );
        this.logger.log(
          `Saved ${newRecords.length} records to GitHub metadata (${this.metadataPath}).`,
        );
        return;
      } catch (putErr: any) {
        if (attempt === 4) throw putErr;
        const delay = Math.floor(1000 + Math.random() * 4000);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  /**
   * Update an image record by ID
   */
  async updateRecord(
    id: string,
    updates: Partial<ImageRecord>,
  ): Promise<ImageRecord | null> {
    if (!this.isConfigured()) return null;
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.metadataPath}`;

    const getRes = await axios.get(`${url}?ref=${this.branch}`, {
      headers: this.getHeaders(),
      timeout: 15000,
    });
    const existingSha = getRes.data?.sha;
    const rawBase64 = getRes.data?.content || '';
    const records: ImageRecord[] = JSON.parse(
      Buffer.from(rawBase64, 'base64').toString('utf8'),
    );

    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    records[idx] = { ...records[idx], ...updates };
    const updatedContent = Buffer.from(
      JSON.stringify(records, null, 2),
      'utf8',
    ).toString('base64');

    await axios.put(
      url,
      {
        message: `Update image record ${id}`,
        content: updatedContent,
        sha: existingSha,
        branch: this.branch,
      },
      { headers: this.getHeaders(), timeout: 30000 },
    );

    return records[idx];
  }

  /** Remove an image record by ID. */
  async removeRecord(id: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.metadataPath}`;

    const getRes = await axios.get(`${url}?ref=${this.branch}`, {
      headers: this.getHeaders(),
      timeout: 15000,
    });
    const existingSha = getRes.data?.sha;
    const rawBase64 = getRes.data?.content || '';
    const records: ImageRecord[] = JSON.parse(
      Buffer.from(rawBase64, 'base64').toString('utf8'),
    );

    const filtered = records.filter((r) => r.id !== id);
    if (filtered.length === records.length) return false;

    const updatedContent = Buffer.from(
      JSON.stringify(filtered, null, 2),
      'utf8',
    ).toString('base64');

    await axios.put(
      url,
      {
        message: `Remove image record ${id}`,
        content: updatedContent,
        sha: existingSha,
        branch: this.branch,
      },
      { headers: this.getHeaders(), timeout: 30000 },
    );

    return true;
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
