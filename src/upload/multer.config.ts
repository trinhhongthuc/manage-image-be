import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';

export const UPLOAD_DIRECTORY = './uploads';
export const STAGING_DIRECTORY = join(UPLOAD_DIRECTORY, 'staging');

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIRECTORY)) {
  fs.mkdirSync(UPLOAD_DIRECTORY, { recursive: true });
}
if (!fs.existsSync(STAGING_DIRECTORY)) {
  fs.mkdirSync(STAGING_DIRECTORY, { recursive: true });
}

export const multerStorage = diskStorage({
  destination: (req, file, cb) => {
    const rawSessionId =
      (req.query?.sessionId as string) ||
      (req.headers['x-session-id'] as string) ||
      req.body?.sessionId ||
      (req as any)._sessionId;

    if (rawSessionId) {
      const cleanSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const targetDir = join(STAGING_DIRECTORY, cleanSessionId);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      return cb(null, targetDir);
    }

    if (!fs.existsSync(UPLOAD_DIRECTORY)) {
      fs.mkdirSync(UPLOAD_DIRECTORY, { recursive: true });
    }
    cb(null, UPLOAD_DIRECTORY);
  },
  filename: (req, file, cb) => {
    const ext = extname(file.originalname);
    const safeBaseName = file.originalname
      .replace(ext, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const uniqueId = randomUUID().slice(0, 8);
    const finalFilename = `${Date.now()}_${uniqueId}_${safeBaseName}${ext}`;
    cb(null, finalFilename);
  },
});

export const multerOptions = {
  storage: multerStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 200, // up to 200 files in a single batch
  },
  fileFilter: (req: any, file: Express.Multer.File, cb: any) => {
    // Accept image and video types matching client requirements
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException(
          `Chỉ chấp nhận file ảnh hoặc video. Định dạng nhận được: ${file.mimetype} (${file.originalname})`,
        ),
        false,
      );
    }
  },
};
