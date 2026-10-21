# Manage Image Backend

Backend nhận metadata ảnh từ FE và commit vào `data/records.json` trong GitHub repository. FE chịu trách nhiệm upload ảnh lên Telegram và gửi các Telegram IDs cùng metadata tới backend. Backend không nhận, lưu hoặc xử lý file ảnh.

## Cấu hình

Tạo `.env` từ `.env.example`:

```env
PORT=3000
GITHUB_TOKEN=ghp_YourPersonalAccessTokenHere
GITHUB_OWNER=your-username-or-org
GITHUB_REPO=your-metadata-repo
GITHUB_BRANCH=main
```

GitHub token cần quyền đọc/ghi nội dung repository.

`TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` là tùy chọn, chỉ được dùng bởi API xóa metadata nếu muốn xóa luôn Telegram message. Chức năng nhận metadata không gọi Telegram.

## Chạy ứng dụng

```bash
npm install
npm run start:dev
```

Mặc định server chạy tại `http://localhost:3000`.

## Gửi metadata

Các endpoint sau nhận cùng payload JSON và commit metadata lên GitHub:

- `POST /api/images`
- `POST /api/images/batch`
- `POST /upload`
- `POST /upload/images`
- `POST /upload/batch`

```json
{
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
}
```

Backend kiểm tra các trường metadata bắt buộc rồi append items vào `data/records.json`, sau đó commit file JSON lên nhánh cấu hình trong `.env`. Không cần gửi `multipart/form-data`; file ảnh hoặc video không được đọc hay ghi xuống server.

Ví dụ:

```bash
curl -X POST http://localhost:3000/api/images \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"id\":\"img_example\",\"filename\":\"photo.jpg\",\"telegramFileId\":\"telegram-file-id\",\"telegramFileUniqueId\":\"telegram-file-unique-id\",\"telegramMessageId\":123,\"size\":1024,\"mimeType\":\"image/jpeg\",\"createdAt\":\"2026-10-21T08:00:00.000Z\",\"album\":\"optional-folder\"}]}"
```

Phản hồi:

```json
{
  "success": true,
  "committed": 1
}
```

Nếu metadata sai định dạng, API trả `400`. Nếu GitHub không được cấu hình hoặc commit thất bại, request trả lỗi thay vì báo thành công.

## API metadata hiện có

- `GET /api/images`: đọc, tìm kiếm và phân trang metadata.
- `GET /api/images?export=true`: xuất toàn bộ metadata.
- `PATCH /api/images`: cập nhật tags hoặc album.
- `DELETE /api/images`: xóa metadata và thử xóa message Telegram nếu Telegram được cấu hình.
- `GET /upload/status`: kiểm tra cấu hình GitHub.
- `GET /upload/ui`: trang thử nghiệm nhập và gửi payload JSON metadata.
