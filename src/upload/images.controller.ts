import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Body,
  UploadedFiles,
  UseInterceptors,
  Req,
  Param,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';
import { multerOptions } from './multer.config';
import type { Request } from 'express';
import { randomUUID } from 'crypto';

@Controller('api/images')
export class ImagesController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * GET /api/images - Danh sách, tìm kiếm, lọc và phân trang ảnh (khớp 100% code client)
   */
  @Get()
  async getImages(@Query() query: any) {
    const isExport = query.export === 'true';
    let items = await this.uploadService.getAllRecords();

    if (isExport) {
      return {
        vault: 'manage-image',
        exportedAt: new Date().toISOString(),
        total: items.length,
        items,
      };
    }

    const page = Math.max(1, Number(query.page ?? '1'));
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? '50')));
    const q = (query.q ?? '').trim().toLowerCase();
    const type = (query.type ?? '').toLowerCase();
    const tag = (query.tag ?? '').trim().toLowerCase();
    const album = (query.folder ?? '').trim();
    const dateFrom = query.from;
    const dateTo = query.to;

    if (q)
      items = items.filter((item) => item.filename.toLowerCase().includes(q));
    if (type)
      items = items.filter((item) =>
        item.mimeType?.toLowerCase().includes(type),
      );
    if (tag)
      items = items.filter((item) =>
        (item.tags ?? []).some((t) => t.toLowerCase() === tag),
      );
    if (album) {
      items = items.filter((item) => item.album === album);
    } else if (query.folder !== undefined) {
      items = items.filter((item) => !item.album?.trim());
    }
    if (dateFrom)
      items = items.filter((item) => item.createdAt?.slice(0, 10) >= dateFrom);
    if (dateTo)
      items = items.filter((item) => item.createdAt?.slice(0, 10) <= dateTo);

    items = this.sortRecords(items, query.sort ?? 'newest');
    const start = (page - 1) * limit;

    return {
      items: items.slice(start, start + limit),
      page,
      limit,
      total: items.length,
      hasNextPage: start + limit < items.length,
    };
  }

  /**
   * POST /api/images - Hỗ trợ cả 2 dạng:
   * 1. multipart/form-data: form chứa files, album, fast (tải lượng lớn ảnh)
   *    - Multipart: luôn lưu staging và trả về ngay (Client có thể đóng tab).
   * 2. application/json: { url, filename, album } (tải từ URL)
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async upload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('album') album?: string,
    @Body('caption') caption?: string,
    @Body('fast') fast?: string,
    @Body('sessionId') bodySessionId?: string,
    @Query('sessionId') querySessionId?: string,
    @Req() req?: Request,
  ) {
    if (req?.headers['content-type']?.includes('application/json')) {
      return this.uploadService.processUrlUpload(req.body);
    }

    const sessionId =
      querySessionId ||
      bodySessionId ||
      (req?.headers['x-session-id'] as string) ||
      `sess_${randomUUID()}`;
    const manifest = await this.uploadService.enqueueStagingBatch(
      sessionId,
      files,
      {
        album,
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
   * Alias: POST /api/images/batch - Dành riêng cho client tải theo lô bất đồng bộ
   */
  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(AnyFilesInterceptor(multerOptions))
  async uploadBatch(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('album') album?: string,
    @Body('caption') caption?: string,
    @Body('fast') fast?: string,
    @Body('sessionId') bodySessionId?: string,
    @Query('sessionId') querySessionId?: string,
    @Req() req?: Request,
  ) {
    const sessionId =
      querySessionId ||
      bodySessionId ||
      (req?.headers['x-session-id'] as string) ||
      `sess_${randomUUID()}`;

    const manifest = await this.uploadService.enqueueStagingBatch(
      sessionId,
      files,
      {
        album,
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
   * GET /api/images/session/:sessionId - Kiểm tra tiến độ xử lý ngầm của session
   */
  @Get('session/:sessionId')
  async getSessionStatus(@Param('sessionId') sessionId: string) {
    if (!sessionId) {
      throw new HttpException('Thiếu sessionId.', HttpStatus.BAD_REQUEST);
    }

    const status = await this.uploadService.getSessionStatus(sessionId);
    if (!status) {
      throw new HttpException(
        'Không tìm thấy phiên upload.',
        HttpStatus.NOT_FOUND,
      );
    }

    return status;
  }

  /**
   * PATCH /api/images - Cập nhật tags hoặc album cho ảnh
   */
  @Patch()
  async update(@Body() body: { id?: string; tags?: string[]; album?: string }) {
    if (!body.id) {
      throw new HttpException('Thiếu id ảnh.', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.uploadService.updateRecord(body.id, {
      ...(Array.isArray(body.tags) ? { tags: body.tags } : {}),
      ...(typeof body.album === 'string' ? { album: body.album } : {}),
    });

    if (!updated) {
      throw new HttpException('Không tìm thấy ảnh.', HttpStatus.NOT_FOUND);
    }

    return { ok: true, item: updated };
  }

  /**
   * DELETE /api/images - Xoá ảnh khỏi Telegram & GitHub metadata
   */
  @Delete()
  async delete(@Body() body: { id?: unknown; ids?: unknown }) {
    const ids: string[] = Array.isArray(body.ids)
      ? body.ids.filter((item): item is string => typeof item === 'string')
      : typeof body.id === 'string'
        ? [body.id]
        : [];

    if (!ids.length) {
      throw new HttpException(
        'Thiếu id hoặc danh sách ids cần xóa.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.uploadService.deleteRecords(ids);
    return {
      ok: true,
      deletedCount: result.deletedCount,
      errors: result.errors,
    };
  }

  private sortRecords(items: any[], sort: string) {
    return [...items].sort((a, b) => {
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      if (sort === 'name') return a.filename.localeCompare(b.filename);
      if (sort === 'size') return b.size - a.size;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
}
