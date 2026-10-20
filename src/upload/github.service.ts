import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';

export interface ImageRecord {
  id: string;
  filename: string;
  storedFilename?: string;
  mimeType: string;
  size: number;
  url: string;
  githubUrl?: string;
  rawUrl?: string;
  telegramMessageId?: number;
  telegramFileId?: string;
  album?: string;
  tags?: string[];
  createdAt: string;
  sha?: string;
  path?: string;
}

export interface GithubUploadResult {
  filename: string;
  originalName: string;
  path: string;
  success: boolean;
  htmlUrl?: string;
  rawUrl?: string;
  downloadUrl?: string;
  sha?: string;
  error?: string;
}

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly defaultTargetFolder: string;
  private readonly metadataPath = 'data/records.json';

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.get<string>('GITHUB_TOKEN') || '';
    this.owner = this.configService.get<string>('GITHUB_OWNER') || '';
    this.repo = this.configService.get<string>('GITHUB_REPO') || '';
    this.branch = this.configService.get<string>('GITHUB_BRANCH') || 'main';
    this.defaultTargetFolder =
      this.configService.get<string>('GITHUB_TARGET_PATH') || 'images';
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.owner && this.repo);
  }

  getConfigSummary() {
    return {
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      targetFolder: this.defaultTargetFolder,
      configured: this.isConfigured(),
    };
  }

  /**
   * Upload multiple files to GitHub sequentially to avoid branch head update race conditions.
   */
  async uploadFiles(
    files: Express.Multer.File[],
    targetFolder?: string,
  ): Promise<GithubUploadResult[]> {
    if (!this.isConfigured()) {
      throw new Error(
        'GitHub credentials missing. Please set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO in .env.',
      );
    }

    const results: GithubUploadResult[] = [];
    const folder = (targetFolder || this.defaultTargetFolder).replace(
      /^\/+|\/+$/g,
      '',
    );

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.logger.log(
        `Uploading file [${i + 1}/${files.length}]: ${file.originalname} to GitHub...`,
      );

      const result = await this.uploadSingleFileWithRetry(file, folder);
      results.push(result);

      if (i < files.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return results;
  }

  private async uploadSingleFileWithRetry(
    file: Express.Multer.File,
    folder: string,
    maxAttempts = 4,
  ): Promise<GithubUploadResult> {
    const gitPath = folder ? `${folder}/${file.filename}` : file.filename;
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${gitPath}`;

    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const fileBuffer = await fs.promises.readFile(file.path);
        const base64Content = fileBuffer.toString('base64');

        const payload: any = {
          message: `Upload media: ${file.originalname}`,
          content: base64Content,
          branch: this.branch,
        };

        const response = await axios.put(url, payload, {
          headers: this.getHeaders(),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 60000,
        });

        const content = response.data?.content;
        const commit = response.data?.commit;
        const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${gitPath}`;

        this.logger.log(
          `Successfully uploaded ${file.originalname} to GitHub (commit: ${commit?.sha?.substring(0, 7)}).`,
        );

        return {
          filename: file.filename,
          originalName: file.originalname,
          path: gitPath,
          success: true,
          htmlUrl: content?.html_url,
          rawUrl,
          downloadUrl: content?.download_url || rawUrl,
          sha: content?.sha,
        };
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        const msg = error.response?.data?.message || error.message;

        this.logger.warn(
          `Attempt ${attempt}/${maxAttempts} failed for ${file.originalname} (status ${status}): ${msg}`,
        );

        if (attempt < maxAttempts) {
          const delay = Math.floor(1000 + Math.random() * 4000);
          await new Promise((res) => setTimeout(res, delay));
        }
      }
    }

    const finalMsg =
      lastError?.response?.data?.message ||
      lastError?.message ||
      'Unknown GitHub API error';
    return {
      filename: file.filename,
      originalName: file.originalname,
      path: gitPath,
      success: false,
      error: finalMsg,
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
    if (!this.isConfigured() || !newRecords.length) return;

    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.metadataPath}`;
    let existingRecords: ImageRecord[] = [];
    let existingSha: string | undefined;

    try {
      const getRes = await axios.get(`${url}?ref=${this.branch}`, {
        headers: this.getHeaders(),
        timeout: 15000,
      });
      existingSha = getRes.data?.sha;
      const rawBase64 = getRes.data?.content || '';
      const jsonStr = Buffer.from(rawBase64, 'base64').toString('utf8');
      existingRecords = JSON.parse(jsonStr);
    } catch (err: any) {
      if (err.response?.status !== 404) {
        this.logger.warn(`Failed to fetch existing records: ${err.message}`);
      }
    }

    const combined = [...existingRecords, ...newRecords];
    const updatedContent = Buffer.from(
      JSON.stringify(combined, null, 2),
      'utf8',
    ).toString('base64');

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
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
          `Appended ${newRecords.length} records to GitHub metadata (${this.metadataPath}).`,
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

  /**
   * Remove an image record by ID
   */
  /**
   * Delete an image file from GitHub repository
   */
  async deleteFile(filePath: string, sha?: string): Promise<boolean> {
    if (!this.isConfigured() || !filePath) return false;

    const cleanPath = filePath.replace(/^\/+/, '');
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${cleanPath}`;

    let targetSha = sha;
    if (!targetSha) {
      try {
        const getRes = await axios.get(`${url}?ref=${this.branch}`, {
          headers: this.getHeaders(),
          timeout: 10000,
        });
        targetSha = getRes.data?.sha;
      } catch (err: any) {
        if (err.response?.status === 404) return true; // File already deleted
        this.logger.warn(
          `Could not find SHA for file ${cleanPath}: ${err.message}`,
        );
        return false;
      }
    }

    if (!targetSha) return false;

    try {
      await axios.delete(url, {
        headers: this.getHeaders(),
        data: {
          message: `Delete media file: ${cleanPath}`,
          sha: targetSha,
          branch: this.branch,
        },
        timeout: 15000,
      });
      this.logger.log(`Deleted file ${cleanPath} from GitHub.`);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Failed to delete file ${cleanPath} from GitHub: ${err.message}`,
      );
      return false;
    }
  }

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
