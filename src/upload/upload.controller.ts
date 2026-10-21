import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async uploadMetadata(@Body() payload: unknown) {
    return this.uploadService.commitMetadata(payload);
  }

  @Post('images')
  @HttpCode(HttpStatus.OK)
  async uploadImagesMetadata(@Body() payload: unknown) {
    return this.uploadService.commitMetadata(payload);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async uploadBatchMetadata(@Body() payload: unknown) {
    return this.uploadService.commitMetadata(payload);
  }

  @Get('status')
  getStatus() {
    return { github: this.uploadService.getGithubStatus() };
  }

  @Get('ui')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getMetadataUI(): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commit image metadata</title>
  <style>
    body { background: #0f172a; color: #f1f5f9; font: 16px system-ui, sans-serif; margin: 0; padding: 2rem; }
    main { margin: auto; max-width: 800px; }
    textarea { background: #1e293b; border: 1px solid #475569; border-radius: 8px; box-sizing: border-box; color: #f1f5f9; min-height: 360px; padding: 1rem; width: 100%; }
    button { background: #0284c7; border: 0; border-radius: 6px; color: white; cursor: pointer; font-size: 1rem; margin: 1rem 0; padding: .75rem 1.25rem; }
    pre { background: #020617; border-radius: 8px; overflow: auto; padding: 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Lưu metadata ảnh</h1>
    <p>Nhập JSON có dạng <code>{ "items": [...] }</code>. Server chỉ commit metadata lên GitHub, không nhận hoặc xử lý file ảnh.</p>
    <textarea id="payload" spellcheck="false">{
  "items": [
    {
      "id": "img_example",
      "filename": "photo.jpg",
      "telegramFileId": "telegram-file-id",
      "telegramFileUniqueId": "telegram-file-unique-id",
      "telegramMessageId": 123,
      "size": 1024,
      "mimeType": "image/jpeg",
      "createdAt": "2026-10-21T08:00:00.000Z",
      "album": "optional-folder"
    }
  ]
}</textarea>
    <button id="submit">Commit metadata</button>
    <pre id="result"></pre>
  </main>
  <script>
    document.getElementById('submit').addEventListener('click', async () => {
      const result = document.getElementById('result');
      try {
        const response = await fetch('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: document.getElementById('payload').value
        });
        const body = await response.json();
        result.textContent = JSON.stringify(body, null, 2);
      } catch (error) {
        result.textContent = String(error);
      }
    });
  </script>
</body>
</html>`;
  }
}
