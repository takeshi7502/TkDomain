# Takeshi Domains

`domain.takeshi.dev` là cổng đăng ký CNAME-only cho các subdomain dạng `ten.takeshi.dev`.

## Luồng hoạt động

1. Người dùng thêm custom domain ở host của họ (Cloudflare Pages, Vercel, Netlify, GitHub Pages...).
2. Họ gửi tên subdomain, CNAME destination, GitHub handle và email.
3. Request được lưu ở trạng thái `pending`.
4. Admin duyệt request qua protected API. Khi provision, app tạo CNAME DNS-only trong zone `takeshi.dev` bằng Cloudflare API và chuyển trạng thái thành `active`.

## Bảo mật trước khi mở public

Tạo ba runtime secret (không commit vào Git):

```text
REGISTRY_ADMIN_KEY=<một chuỗi ngẫu nhiên dài>
CLOUDFLARE_API_TOKEN=<Cloudflare API token>
CLOUDFLARE_ZONE_ID=<Zone ID của takeshi.dev>
```

Token Cloudflare chỉ cần quyền `Zone / DNS / Edit` và phải giới hạn đúng zone `takeshi.dev`. Đừng dùng Global API Key.

Admin API yêu cầu header `x-registry-admin-key`:

```text
GET   /api/admin/requests
PATCH /api/admin/requests
```

Body cho `PATCH`:

```json
{ "id": "request-id", "action": "provision", "note": "Approved" }
```

Hoặc từ chối:

```json
{ "id": "request-id", "action": "reject", "note": "Reason" }
```

Giai đoạn tiếp theo nên đặt Cloudflare Access trước admin API và bổ sung Turnstile cho form public.
