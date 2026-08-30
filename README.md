# Takeshi Domains

`domain.takeshi.dev` là cổng đăng ký CNAME-only cho các subdomain dạng
`ten.takeshi.dev`.

## Cách hoạt động

1. Người dùng thêm custom domain ở dịch vụ host của họ.
2. Họ gửi tên subdomain, CNAME đích, GitHub và email.
3. Yêu cầu được lưu ở trạng thái `pending`.
4. Admin duyệt yêu cầu. Nếu DNS automation đã được cấu hình, app tạo CNAME
   DNS-only trong zone `takeshi.dev` và chuyển request thành `active`.

## Hạ tầng

- **Hosting:** Vercel, deploy tự động từ nhánh `main` trên GitHub.
- **Database:** Neon Serverless Postgres, được kết nối qua Vercel Marketplace.
- **Runtime:** Next.js App Router + route handlers.

## Biến môi trường

Vercel/Neon tự tạo `DATABASE_URL`. Các secret còn lại cần được tạo trong
Vercel Project Settings → Environment Variables:

```text
REGISTRY_ADMIN_KEY=<chuỗi ngẫu nhiên dài>
CLOUDFLARE_API_TOKEN=<Cloudflare API token, chỉ Zone / DNS / Edit>
CLOUDFLARE_ZONE_ID=<Zone ID của takeshi.dev>
TELEGRAM_BOT_TOKEN=<token từ BotFather>
TELEGRAM_ADMIN_CHAT_ID=<chat ID của admin, nếu dùng thông báo admin>
TELEGRAM_BOT_USERNAME=<username bot, không có @; tùy chọn>
TELEGRAM_WEBHOOK_SECRET=<random-secret-32-plus-chars>
REGISTRY_PUBLIC_URL=https://domain.takeshi.dev
```

`CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ZONE_ID` là tùy chọn: khi chưa có chúng,
nút duyệt DNS sẽ trả về thông báo rằng DNS provisioning chưa được cấu hình.
Không bao giờ commit secret vào Git.

## Telegram bot (tùy chọn nhưng khuyến nghị)

Bot được dùng cho hai loại thông báo độc lập:

- Admin nhận báo có request mới (cần `TELEGRAM_ADMIN_CHAT_ID`).
- Chủ subdomain có thể tự liên kết bot từ DNS Panel. Sau khi họ bấm Start,
  bot sẽ báo các thay đổi DNS; đồng thời mã Telegram sẽ được yêu cầu khi xóa
  subdomain chính hoặc khôi phục access key.

Sau khi deploy biến môi trường Telegram lên **Production** của Vercel, đăng
nhập `/admin` và bấm **Cài webhook bot** một lần. Nút này đăng ký an toàn
`https://domain.takeshi.dev/api/telegram/webhook` với Telegram. Sau đó dùng
**Test bot Telegram** để kiểm tra kênh thông báo admin.

`TELEGRAM_BOT_USERNAME` giúp tạo link nhanh hơn; nếu bỏ trống app sẽ gọi
Bot API `getMe` để lấy username bot. Không dùng BotFather `getUpdates` cùng
lúc với webhook đang hoạt động.

## Admin API

Admin API cần header `x-registry-admin-key`:

```text
GET   /api/admin/requests
PATCH /api/admin/requests
```

Ví dụ duyệt request:

```json
{ "id": "request-id", "action": "provision", "note": "Approved" }
```

Hoặc từ chối:

```json
{ "id": "request-id", "action": "reject", "note": "Reason" }
```
