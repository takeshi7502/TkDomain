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
```

`CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ZONE_ID` là tùy chọn: khi chưa có chúng,
nút duyệt DNS sẽ trả về thông báo rằng DNS provisioning chưa được cấu hình.
Không bao giờ commit secret vào Git.

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
