import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  BadRequestException,
  Param,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { diskStorage } from 'multer';
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

  @Post('file')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_request, _file, callback) => callback(null, tmpdir()),
        filename: (_request, _file, callback) => callback(null, randomUUID()),
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('album') album?: string,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Gửi file bằng multipart/form-data với field "file".',
      );
    }
    return this.uploadService.uploadFile(file, album);
  }

  @Post('files')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      storage: diskStorage({
        destination: (_request, _file, callback) => callback(null, tmpdir()),
        filename: (_request, _file, callback) => callback(null, randomUUID()),
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async stageUploadFiles(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body('album') album?: string,
  ) {
    if (!files?.length) {
      throw new BadRequestException(
        'Chọn file bằng multipart/form-data với field "files".',
      );
    }
    return this.uploadService.startUploadJob(files, album);
  }

  @Get('jobs/:jobId')
  getUploadJob(@Param('jobId') jobId: string) {
    return this.uploadService.getUploadJob(jobId);
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
  <title>Upload ảnh lên Telegram</title>
  <style>
    body { background: #0f172a; color: #f1f5f9; font: 16px system-ui, sans-serif; margin: 0; padding: 2rem; }
    main { margin: auto; max-width: 800px; }
    section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; margin: 1.5rem 0; padding: 1.5rem; }
    label { display: block; font-weight: 600; margin: 1rem 0 .5rem; }
    input, textarea { background: #0f172a; border: 1px solid #475569; border-radius: 8px; box-sizing: border-box; color: #f1f5f9; padding: .75rem; width: 100%; }
    textarea { min-height: 300px; }
    button { background: #0284c7; border: 0; border-radius: 6px; color: white; cursor: pointer; font-size: 1rem; margin: 1rem 0; padding: .75rem 1.25rem; }
    button:disabled { cursor: wait; opacity: .6; }
    pre { background: #020617; border-radius: 8px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    .hint { color: #cbd5e1; font-size: .9rem; }
    .file-list { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); margin-top: 1rem; }
    .file-card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; min-width: 0; overflow: hidden; }
    .file-card img { aspect-ratio: 4 / 3; background: #020617; display: block; object-fit: contain; width: 100%; }
    .file-info { padding: .75rem; }
    .file-name { overflow-wrap: anywhere; }
    .file-meta { color: #cbd5e1; font-size: .85rem; margin-top: .35rem; }
    .file-card button { background: #b91c1c; font-size: .9rem; margin: .5rem 0 0; padding: .5rem .75rem; }
  </style>
</head>
<body>
  <main>
    <h1>Upload ảnh từ server</h1>
    <section>
      <h2>Upload file lên Telegram và lưu metadata</h2>
      <p>Chọn tùy ý số lượng file. Server xử lý từng đợt tối đa 10 file; chỉ sau khi xử lý xong và dọn file tạm của đợt hiện tại, UI mới gửi đợt tiếp theo. Ảnh được upload lên Telegram, metadata được commit lên GitHub và file lỗi được thử lại tối đa 3 lần.</p>
      <form id="file-upload-form">
        <label for="files">Files (50 MB mỗi file, xử lý theo đợt 10 file)</label>
        <input id="files" name="files" type="file" multiple required>
        <div id="file-list" class="file-list" aria-live="polite"></div>
        <label for="album">Album</label>
        <input id="album" name="album" type="text" value="Bi/SX" placeholder="Tên album">
        <button id="upload-button" type="submit">Upload file đã chọn</button>
      </form>
      <pre id="upload-result" aria-live="polite"></pre>
    </section>
    <section>
      <h2>Lưu metadata có sẵn</h2>
      <p>Luồng JSON riêng: chỉ commit metadata đã có, không upload file lên Telegram.</p>
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
      <button id="submit" type="button">Commit metadata JSON</button>
      <pre id="result" aria-live="polite"></pre>
    </section>
  </main>
  <script>
    const fileInput = document.getElementById('files');
    const fileList = document.getElementById('file-list');
    const uploadForm = document.getElementById('file-upload-form');
    let selectedFiles = [];
    let previewUrls = [];

    function formatFileSize(size) {
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      return (size / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderFileList() {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls = [];
      fileList.replaceChildren();

      selectedFiles.forEach((file, index) => {
        const card = document.createElement('article');
        card.className = 'file-card';
        if (file.type.startsWith('image/')) {
          const image = document.createElement('img');
          const url = URL.createObjectURL(file);
          previewUrls.push(url);
          image.src = url;
          image.alt = file.name;
          card.appendChild(image);
        }

        const info = document.createElement('div');
        info.className = 'file-info';
        const name = document.createElement('div');
        name.className = 'file-name';
        name.textContent = file.name;
        const meta = document.createElement('div');
        meta.className = 'file-meta';
        meta.textContent = (file.type || 'Không xác định loại file') + ' · ' + formatFileSize(file.size);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Xóa file';
        remove.setAttribute('aria-label', 'Xóa ' + file.name);
        remove.addEventListener('click', () => {
          selectedFiles.splice(index, 1);
          renderFileList();
        });
        info.append(name, meta, remove);
        card.appendChild(info);
        fileList.appendChild(card);
      });
    }

    function syncFileInput() {
      const transfer = new DataTransfer();
      selectedFiles.forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
    }

    fileInput.addEventListener('change', () => {
      selectedFiles = Array.from(fileInput.files || []);
      renderFileList();
    });

    window.addEventListener('beforeunload', () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    });

    uploadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const files = [...selectedFiles];
      const album = document.getElementById('album').value;
      const button = document.getElementById('upload-button');
      const result = document.getElementById('upload-result');

      if (!files.length) {
        result.textContent = 'Vui lòng chọn ít nhất một file.';
        return;
      }
      const oversized = files.filter((file) => file.size > 50 * 1024 * 1024);
      if (oversized.length) {
        result.textContent = 'File vượt quá giới hạn 50 MB: ' + oversized.map((file) => file.name).join(', ');
        return;
      }

      button.disabled = true;
      let succeededCount = 0;
      let failedCount = 0;
      let completedBatches = 0;
      let processingStartedAt;

      function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return 'đang ước tính';
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.ceil(seconds % 60);
        if (minutes === 0) return remainingSeconds + ' giây';
        return minutes + ' phút ' + remainingSeconds + ' giây';
      }

      function renderProgress(currentStatus, stageMessage) {
        const active = currentStatus
          ? currentStatus.files.filter((file) => file.status === 'uploading').length
          : 0;
        const done = succeededCount + failedCount +
          (currentStatus ? currentStatus.succeeded : 0) +
          (currentStatus && currentStatus.status === 'completed' ? currentStatus.failed : 0);
        const remaining = Math.max(0, files.length - done - active);
        const elapsedSeconds = processingStartedAt
          ? (Date.now() - processingStartedAt) / 1000
          : 0;
        const averageSeconds = done > 0 ? elapsedSeconds / done : undefined;
        const eta = averageSeconds === undefined
          ? 'đang ước tính'
          : formatDuration(averageSeconds * remaining);
        result.textContent =
          (stageMessage ? stageMessage + '\\n' : '') +
          'Đã xử lý: ' + done + '/' + files.length +
          ' | Đang tải: ' + active +
          ' | Còn lại: ' + remaining +
          ' | Ước tính còn: ' + eta;
      }

      try {
        while (selectedFiles.length) {
          const batch = selectedFiles.slice(0, 10);
          renderProgress(undefined, 'Đang lưu tạm đợt ' + (completedBatches + 1) + ' (' + batch.length + ' file)...');
          const form = new FormData();
          batch.forEach((file) => form.append('files', file, file.name));
          form.append('album', album);
          const response = await fetch('/upload/files', {
            method: 'POST',
            body: form
          });
          const text = await response.text();
          let job;
          try { job = JSON.parse(text); } catch { job = { message: text }; }
          if (!response.ok) {
            throw new Error(job.message || JSON.stringify(job));
          }

          selectedFiles.splice(0, batch.length);
          if (!processingStartedAt) processingStartedAt = Date.now();
          syncFileInput();
          renderFileList();
          renderProgress(undefined, 'Đã lưu tạm đợt ' + (completedBatches + 1) + '. Đang xử lý đợt này.');

          let status;
          do {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const statusResponse = await fetch('/upload/jobs/' + encodeURIComponent(job.jobId));
            status = await statusResponse.json();
            if (!statusResponse.ok) {
              throw new Error(status.message || 'Không lấy được trạng thái upload.');
            }
            renderProgress(status, 'Đang xử lý đợt ' + (completedBatches + 1) + '.');
          } while (status.status !== 'completed');

          completedBatches += 1;
          succeededCount += status.succeeded;
          failedCount += status.failed;
          renderProgress(undefined, 'Đã xử lý xong đợt. Đang tiếp tục các file còn lại.');
        }

        uploadForm.reset();
        selectedFiles = [];
        renderFileList();
        renderProgress(undefined, failedCount
          ? 'Upload hoàn tất, có ' + failedCount + ' file lỗi sau các lần thử lại.'
          : 'Upload hoàn tất thành công.');
      } catch (error) {
        result.textContent = 'Không thể theo dõi upload: ' + String(error);
      } finally {
        button.disabled = false;
      }
    });

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
