# Manage Image Backend

Backend hỗ trợ hai luồng: nhận metadata ảnh FE đã upload lên Telegram, hoặc nhận file để tự upload lên Telegram. Cả hai luồng đều lưu metadata vào một trong 16 file shard `metadata/images-00.json` đến `metadata/images-0f.json` trong GitHub repository. Shard được chọn từ hai ký tự hexadecimal cuối của `id`, giống logic lưu trữ của frontend.

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

`TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` cần được cấu hình để dùng API upload file mới; API xóa metadata cũng dùng chúng nếu muốn xóa luôn Telegram message. API nhận JSON metadata hiện có không gọi Telegram.

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

UI `/upload/ui` nhận không giới hạn tổng số file (50 MB mỗi file), nhưng chỉ gửi một đợt tối đa 10 file tại một thời điểm. Album mặc định là `Bi/SX` và được gắn vào metadata nếu không nhập giá trị khác. Sau khi BE xác nhận staging, UI gỡ đợt đó khỏi danh sách và chờ job xử lý xong (bao gồm retry và xóa file tạm) mới gửi đợt kế tiếp. Mỗi job xử lý lần lượt: upload từng file bằng Telegram `sendDocument` và commit metadata lên GitHub ngay. File lỗi được thử lại tối đa 3 lần sau lượt xử lý ban đầu. UI chỉ hiển thị số đã xử lý, số đang tải, số còn lại và thời gian hoàn tất ước tính; không hiển thị metadata trong phần tiến độ. Trạng thái từng file xem tại `GET /upload/jobs/:jobId`. Cần giữ browser mở để các đợt chưa gửi còn ở phía trình duyệt; job của đợt đã được BE nhận vẫn chạy khi browser đóng, miễn là process BE còn chạy.

Để backend upload một file đồng bộ, vẫn có thể gọi `POST /upload/file` bằng `multipart/form-data` với field `file` và album tùy chọn. Giới hạn là 50 MB. BE stream file tạm lên Telegram rồi xóa file tạm trước khi lưu metadata lên GitHub:

```bash
curl -X POST http://localhost:3000/upload/file \
  -F "file=@photo.jpg" \
  -F "album=vacation"
```

Response gồm `success` và `item` chứa metadata; `album` chỉ là nhãn do người dùng nhập, không phải Telegram media group. Nếu upload Telegram thành công nhưng ghi GitHub thất bại, file Telegram vẫn tồn tại và cần xử lý/xóa thủ công. Upload nền giữ trạng thái trong bộ nhớ BE; nếu BE khởi động lại giữa job, job đang chạy và trạng thái của nó sẽ không được khôi phục.

```json
{
  "items": [
    {
      "id": "img_00000000000000000000000000000001",
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

Với API JSON metadata, backend kiểm tra các trường bắt buộc, đọc shard và SHA hiện tại từ GitHub, rồi append các record mới vào shard tương ứng. Nếu SHA xung đột, backend đọc lại shard mới nhất và thử ghi lại tối đa ba lần. GitHub token chỉ được đọc từ biến môi trường phía server; không gửi token xuống frontend. API JSON không nhận hoặc xử lý file; để backend upload file, dùng riêng `POST /upload/file` như ví dụ ở trên.

Ví dụ:

```bash
curl -X POST http://localhost:3000/api/images \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"id\":\"img_00000000000000000000000000000001\",\"filename\":\"photo.jpg\",\"telegramFileId\":\"telegram-file-id\",\"telegramFileUniqueId\":\"telegram-file-unique-id\",\"telegramMessageId\":123,\"size\":1024,\"mimeType\":\"image/jpeg\",\"createdAt\":\"2026-10-21T08:00:00.000Z\",\"album\":\"optional-folder\"}]}"
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
