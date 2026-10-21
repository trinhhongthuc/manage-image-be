import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Body,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UploadService } from './upload.service';

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

  /** POST /api/images - Commit metadata JSON to GitHub. */
  @Post()
  @HttpCode(HttpStatus.OK)
  async upload(@Body() payload: unknown) {
    return this.uploadService.commitMetadata(payload);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async uploadBatch(@Body() payload: unknown) {
    return this.uploadService.commitMetadata(payload);
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
