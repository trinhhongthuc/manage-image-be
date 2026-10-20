import {
  Controller,
  Post,
  Get,
  UseInterceptors,
  UploadedFiles,
  Body,
  Query,
  Param,
  Header,
  HttpCode,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { multerOptions } from './multer.config';
import { randomUUID } from 'crypto';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * Endpoint: POST /upload
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async uploadImages(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('album') album?: string,
    @Body('caption') caption?: string,
    @Body('folder') folder?: string,
    @Body('fast') fast?: string,
    @Body('sessionId') bodySessionId?: string,
    @Query('sessionId') querySessionId?: string,
  ): Promise<any> {
    if (!files || files.length === 0) {
      throw new BadRequestException(
        'Vui lòng chọn ít nhất một file ảnh hoặc video.',
      );
    }

    const sessionId = querySessionId || bodySessionId || `sess_${randomUUID()}`;
    const manifest = await this.uploadService.enqueueStagingBatch(
      sessionId,
      files,
      {
        album: album || folder,
        caption,
        isFast: fast === 'true',
      },
    );
    return {
      success: true,
      async: true,
      sessionId,
      batchReceived: files.length,
      totalQueued: manifest.totalFiles,
      status: manifest.status,
      message: `Đã lưu ${files.length} ảnh trên server. Đang tải ngầm lên Telegram và GitHub; bạn có thể đóng tab.`,
    };
  }

  /**
   * Endpoint: POST /upload/batch - Upload theo lô bất đồng bộ
   */
  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async uploadBatch(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('album') album?: string,
    @Body('caption') caption?: string,
    @Body('folder') folder?: string,
    @Body('fast') fast?: string,
    @Body('sessionId') bodySessionId?: string,
    @Query('sessionId') querySessionId?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException(
        'Vui lòng chọn ít nhất một file ảnh hoặc video.',
      );
    }

    const sessionId = querySessionId || bodySessionId || `sess_${randomUUID()}`;
    const manifest = await this.uploadService.enqueueStagingBatch(
      sessionId,
      files,
      {
        album: album || folder,
        caption,
        isFast: fast === 'true',
      },
    );

    return {
      success: true,
      async: true,
      sessionId,
      batchReceived: files.length,
      totalQueued: manifest.totalFiles,
      status: manifest.status,
      message: `Đã lưu an toàn ${files.length} ảnh vào server. Đang tiến hành tải ngầm lên Telegram & GitHub.`,
    };
  }

  /**
   * Endpoint: GET /upload/session/:sessionId - Lấy tiến độ xử lý ngầm
   */
  @Get('session/:sessionId')
  async getSessionStatus(@Param('sessionId') sessionId: string) {
    const status = await this.uploadService.getSessionStatus(sessionId);
    if (!status) {
      throw new HttpException(
        'Không tìm thấy session upload.',
        HttpStatus.NOT_FOUND,
      );
    }
    return status;
  }

  /**
   * Endpoint: POST /upload/images
   */
  @Post('images')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async uploadImagesAlias(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('album') album?: string,
    @Body('caption') caption?: string,
    @Body('folder') folder?: string,
    @Body('fast') fast?: string,
  ): Promise<any> {
    return this.uploadImages(files, album, caption, folder, fast);
  }

  /**
   * Trạng thái cấu hình Telegram & GitHub
   */
  @Get('status')
  getStatus() {
    return this.uploadService.getServiceStatus();
  }

  /**
   * Giao diện Web Test trực quan kéo thả ảnh và upload theo lô
   */
  @Get('ui')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getTestUI(): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bulk Image Upload - Telegram Album & GitHub Sync (Background Queue)</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f1f5f9; margin: 0; padding: 2rem; display: flex; justify-content: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 2rem; width: 100%; max-width: 780px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h1 { margin-top: 0; font-size: 1.5rem; color: #38bdf8; display: flex; align-items: center; gap: 0.5rem; }
    p.desc { color: #94a3b8; font-size: 0.95rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .dropzone { border: 2px dashed #475569; border-radius: 8px; padding: 2.5rem; text-align: center; cursor: pointer; transition: 0.2s; background: #0f172a80; }
    .dropzone:hover, .dropzone.dragover { border-color: #38bdf8; background: #1e293b; }
    .form-group { margin-top: 1rem; }
    label { display: block; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 0.4rem; font-weight: 500; }
    input[type="text"], select { width: 100%; padding: 0.7rem; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 0.9rem; }
    input[type="file"] { display: none; }
    .preview-info { margin-top: 1rem; font-size: 0.9rem; color: #38bdf8; font-weight: 500; }
    button { width: 100%; margin-top: 1.5rem; padding: 0.85rem; border: none; border-radius: 6px; background: #0284c7; color: white; font-weight: 600; font-size: 1rem; cursor: pointer; transition: 0.2s; }
    button:hover:not(:disabled) { background: #0369a1; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; margin-right: 0.5rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-warn { background: #854d0e; color: #fde047; }
    .progress-bar-container { width: 100%; background: #334155; border-radius: 6px; height: 16px; overflow: hidden; margin-top: 0.75rem; display: none; }
    .progress-bar { width: 0%; height: 100%; background: #38bdf8; transition: width 0.3s; }
    pre { background: #090d16; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; color: #a5f3fc; border: 1px solid #1e293b; max-height: 380px; }
    .info-box { background: #0284c715; border: 1px solid #0284c740; border-radius: 8px; padding: 1rem; margin-top: 1rem; font-size: 0.88rem; line-height: 1.5; color: #bae6fd; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Image Upload Hub (Background Staging Queue)</h1>
    <p class="desc">
      Hỗ trợ tải lên cùng lúc hàng ngàn ảnh (1.000–2.000+). Client chia nhỏ thành từng lô (batch) đẩy lên server ➔ Server lưu đệm tại ổ đĩa ➔ Trả về ngay để người dùng có thể đóng tab ➔ Background Worker tự động gửi album lên Telegram và GitHub trong nền.
    </p>

    <div id="config-status" style="margin-bottom: 1rem;">Đang tải trạng thái cấu hình...</div>

    <div class="dropzone" id="dropzone" onclick="document.getElementById('fileInput').click()">
      <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">📁</div>
      <div style="font-weight: 500;">Kéo thả hàng loạt ảnh/video vào đây</div>
      <div style="color: #64748b; font-size: 0.85rem; margin-top: 0.25rem;">Hỗ trợ hàng ngàn ảnh cùng lúc mà không sợ tràn RAM hay crash server</div>
      <input type="file" id="fileInput" multiple accept="image/*,video/*">
    </div>

    <div class="preview-info" id="fileCountText"></div>

    <div class="form-group">
      <label>Album / Thư mục:</label>
      <input type="text" id="albumInput" placeholder="Ví dụ: summer_trip_2026">
    </div>

    <div class="form-group">
      <label>Kích thước lô gửi lên server (Batch size):</label>
      <select id="batchSizeSelect">
        <option value="20" selected>20 ảnh / lô (Khuyên dùng cho lượng lớn)</option>
        <option value="10">10 ảnh / lô</option>
        <option value="50">50 ảnh / lô (Dành cho mạng nhanh)</option>
      </select>
    </div>

    <button id="uploadBtn" disabled onclick="handleBatchUpload()">Bắt đầu Upload theo lô (Batch Upload)</button>

    <div class="progress-bar-container" id="progressBarContainer">
      <div class="progress-bar" id="progressBar"></div>
    </div>
    <div id="progressText" style="margin-top: 0.5rem; font-size: 0.85rem; color: #94a3b8; display: none;"></div>

    <div class="info-box" id="safeNotice" style="display: none;">
      🛡️ <b>An toàn:</b> Tất cả các ảnh đã được lưu vào đĩa server. Bạn có thể <b>ĐÓNG TAB TRÌNH DUYỆT</b> bất kỳ lúc nào, tiến trình ngầm sẽ tự động hoàn tất việc tải lên Telegram và GitHub!
    </div>

    <div id="resultSection" style="display: none; margin-top: 1.5rem;">
      <h3 style="font-size: 1.1rem; margin-bottom: 0.5rem;">Trạng thái chi tiết (Live Status):</h3>
      <pre id="jsonResult"></pre>
    </div>
  </div>

  <script>
    let selectedFiles = [];

    fetch('/upload/status')
      .then(res => res.json())
      .then(data => {
        const teleOk = data.telegram.configured;
        const ghOk = data.github.configured;
        document.getElementById('config-status').innerHTML = \`
          <span class="status-badge \${teleOk ? 'badge-ok' : 'badge-warn'}">Telegram: \${teleOk ? 'Đã kết nối' : 'Chưa cấu hình .env'}</span>
          <span class="status-badge \${ghOk ? 'badge-ok' : 'badge-warn'}">GitHub: \${ghOk ? 'Đã kết nối (' + data.github.owner + '/' + data.github.repo + ')' : 'Chưa cấu hình .env'}</span>
        \`;
      });

    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const fileCountText = document.getElementById('fileCountText');
    const uploadBtn = document.getElementById('uploadBtn');
    const progressBarContainer = document.getElementById('progressBarContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const safeNotice = document.getElementById('safeNotice');

    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }, false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }, false);
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt.files && dt.files.length) setFiles(dt.files);
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) setFiles(e.target.files);
    });

    function setFiles(files) {
      selectedFiles = Array.from(files);
      const totalMB = (selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024)).toFixed(2);
      fileCountText.textContent = \`Đã chọn \${selectedFiles.length} file (\${totalMB} MB)\`;
      uploadBtn.disabled = selectedFiles.length === 0;
    }

    async function handleBatchUpload() {
      if (selectedFiles.length === 0) return;

      const batchSize = parseInt(document.getElementById('batchSizeSelect').value) || 20;
      const album = document.getElementById('albumInput').value.trim();
      const sessionId = 'bulk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

      uploadBtn.disabled = true;
      progressBarContainer.style.display = 'block';
      progressText.style.display = 'block';
      document.getElementById('resultSection').style.display = 'block';
      safeNotice.style.display = 'none';

      const totalFiles = selectedFiles.length;
      let uploadedToStaging = 0;

      // 1. Gửi lần lượt từng lô lên Server Staging
      for (let i = 0; i < totalFiles; i += batchSize) {
        const chunk = selectedFiles.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(totalFiles / batchSize);

        progressText.textContent = \`Đang chuyển lô \${batchNum}/\${totalBatches} (\${chunk.length} ảnh) lên server...\`;
        uploadBtn.textContent = \`Đang đẩy lô \${batchNum}/\${totalBatches} lên server...\`;

        const formData = new FormData();
        formData.append('sessionId', sessionId);
        if (album) formData.append('album', album);
        for (const file of chunk) {
          formData.append('files', file);
        }

        try {
          const res = await fetch('/upload/batch?sessionId=' + sessionId, {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          uploadedToStaging += chunk.length;

          const percentStaged = Math.round((uploadedToStaging / totalFiles) * 100);
          progressBar.style.width = percentStaged + '%';
          document.getElementById('jsonResult').textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          progressText.textContent = 'Lỗi đẩy lô ' + batchNum + ': ' + err.message;
          uploadBtn.disabled = false;
          return;
        }
      }

      // 2. Tất cả ảnh đã lên server an toàn!
      safeNotice.style.display = 'block';
      uploadBtn.textContent = '✅ Đã lưu toàn bộ ảnh trên server! Đang xử lý ngầm...';
      progressText.textContent = 'Server đang tải ngầm album lên Telegram & GitHub... (Bạn có thể đóng tab)';

      // 3. Polling kiểm tra tiến độ ngầm
      pollSessionProgress(sessionId);
    }

    async function pollSessionProgress(sessionId) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch('/upload/session/' + sessionId);
          if (!res.ok) return;
          const status = await res.json();

          progressBar.style.width = status.percent + '%';
          progressText.textContent = \`Tiến độ ngầm: \${status.doneCount}/\${status.totalFiles} ảnh hoàn tất (\${status.percent}%)\`;
          document.getElementById('jsonResult').textContent = JSON.stringify(status, null, 2);

          if (status.status === 'completed' || status.doneCount + status.failedCount >= status.totalFiles) {
            clearInterval(interval);
            uploadBtn.textContent = '🎉 Hoàn tất toàn bộ!';
            progressText.textContent = \`Đã hoàn thành toàn bộ \${status.totalFiles} ảnh (Thành công: \${status.doneCount}, Lỗi: \${status.failedCount})\`;
            uploadBtn.disabled = false;
          }
        } catch (e) {}
      }, 2000);
    }
  </script>
</body>
</html>`;
  }
}
