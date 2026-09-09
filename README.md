# Takeshi Domains

`domain.takeshi.dev` là cổng đăng ký CNAME-only. Giao diện vẫn mang thương hiệu
Takeshi Domains, còn admin có thể mở thêm các parent domain (ví dụ
`ten.example.dev`) từ tab **Domains**.

## Cách hoạt động

1. Người dùng thêm custom domain ở dịch vụ host của họ.
2. Họ gửi tên subdomain, CNAME đích, Telegram, access key tự đặt và email nhận
   thông báo duyệt (email là tùy chọn).
3. Yêu cầu được lưu ở trạng thái `pending`.
4. Admin duyệt yêu cầu. Nếu DNS automation đã được cấu hình, app tạo CNAME
   DNS-only trong đúng Cloudflare zone mà người dùng đã chọn và chuyển request
   thành `active`.

## Hạ tầng

- **Hosting:** Vercel, deploy tự động từ nhánh `main` trên GitHub.
- **Database:** Neon Serverless Postgres, được kết nối qua Vercel Marketplace.
- **Runtime:** Next.js App Router + route handlers.

## Biến môi trường

Vercel/Neon tự tạo `DATABASE_URL`. Các secret còn lại cần được tạo trong
Vercel Project Settings → Environment Variables:

```text
REGISTRY_ADMIN_KEY=<chuỗi ngẫu nhiên dài>
CLOUDFLARE_API_TOKEN=<token có Zone / DNS / Edit + Zone / Zone / Read trên mọi zone registry quản lý>
CLOUDFLARE_ZONE_ID=<Zone ID takeshi.dev, chỉ dùng seed/fallback khi migrate>
TELEGRAM_BOT_TOKEN=<token từ BotFather>
TELEGRAM_ADMIN_CHAT_ID=<chat ID của admin, nếu dùng thông báo admin>
TELEGRAM_BOT_USERNAME=<username bot, không có @; tùy chọn>
TELEGRAM_WEBHOOK_SECRET=<random-secret-32-plus-chars>
REGISTRY_PUBLIC_URL=https://domain.takeshi.dev
RESEND_API_KEY=<Resend API key chỉ có quyền gửi email>
EMAIL_FROM=Takeshi Domains <notify@mail.takeshi.dev>
```

`CLOUDFLARE_API_TOKEN` là secret dùng chung cho các zone mà registry quản lý.
Tạo **API Token** (không dùng Global API Key) với hai quyền `Zone > DNS > Edit`
và `Zone > Zone > Read`; scope token tới tất cả các zone sẽ thêm vào registry.
`CLOUDFLARE_ZONE_ID` chỉ giúp tự seed `takeshi.dev` tương thích với dữ liệu cũ;
các domain thêm sau đó tự được tra Zone ID và lưu ID không bí mật trong database.
Không bao giờ commit secret vào Git.

## Email thông báo duyệt (Resend)

Email trong form đăng ký chỉ dùng để gửi một thông báo sau khi DNS đã được tạo và
request đã chuyển sang `active`. Email không được dùng để đăng nhập, tìm owner hoặc
khôi phục access key; access key cũng không bao giờ được đưa vào thư.

1. Trong Resend, thêm và xác minh sending domain `mail.takeshi.dev`.
2. Thêm chính xác các DNS record Resend cung cấp vào Cloudflare và để **DNS only**.
3. Tạo API key chỉ có quyền gửi thư.
4. Thêm `RESEND_API_KEY` và `EMAIL_FROM` vào Production Environment Variables của
   Vercel, rồi redeploy production.

Việc gửi thư chạy sau transaction duyệt DNS. Nếu Resend chưa được cấu hình hoặc gửi
lỗi, subdomain vẫn active; admin sẽ thấy trạng thái lỗi trong **Nhật ký yêu cầu** và
có nút hình phong bì để thử lại. Hệ thống khóa lần gửi song song, giới hạn số lần gửi
theo người nhận và dùng idempotency key để tránh gửi trùng khi retry.

## Nhiều domain

Đăng nhập `/admin`, mở tab **Domains**, nhập apex domain (ví dụ `example.dev`)
rồi bấm thêm. Server tự kiểm tra chính xác zone active bằng Cloudflare trước khi
lưu; người dùng chỉ nhìn thấy những domain đang `active` trong dropdown đăng ký.

Nút gỡ chỉ **archive** domain khỏi registry, không hề xóa Cloudflare zone. Vì
vậy nó bị chặn nếu domain còn subdomain active hoặc request pending; hãy xử lý
những mục đó trước để không làm mất quyền quản lý DNS hay audit log.

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
GET   /api/admin/domains
POST  /api/admin/domains
DELETE /api/admin/domains?id=<domain-id>
```

Ví dụ duyệt request:

```json
{ "id": "request-id", "action": "provision", "note": "Approved" }
```

Hoặc từ chối:

```json
{ "id": "request-id", "action": "reject", "note": "Reason" }
```
