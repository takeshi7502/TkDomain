# Rà soát hiệu năng, an toàn và logic Takeshi Domains

Ngày: 03/10/2026. Code được rà: commit `c205d71`.

## Kết luận

Giữ Vercel + Neon là phù hợp với dịch vụ cho bạn bè/người thân. Có các điểm trong code cần sửa trước khi cân nhắc nâng gói hoặc đổi host. Đáng chú ý nhất: khởi tạo schema trong request, tải admin quá nhiều dữ liệu, thiếu hạn mức ghi DNS, và thiếu phối hợp giữa thay đổi Cloudflare và database.

Đây là báo cáo chẩn đoán, chưa triển khai bản vá. Không thử spam, gửi đăng ký, email, Telegram, thay DNS hoặc sửa dữ liệu production. Những tình huống đồng thời và lỗi dịch vụ bên ngoài được phân tích từ code, chưa tái hiện trên production.

Ưu tiên:

- **P1:** nên xử lý trước khi mở rộng người dùng; nguy cơ lạm dụng tài nguyên, lệch DNS hoặc ảnh hưởng xác thực.
- **P2:** cần sửa để ổn định, đúng logic và không tăng dữ liệu vô hạn.
- **P3:** tối ưu/bảo vệ bổ sung, hoặc cần kiểm chứng cấu hình thực tế.

## 1. Vì sao admin mở lần đầu chậm?

### P1 — Request đầu của mỗi instance chạy lại 76 lệnh SQL tuần tự

Nguồn: `db/index.ts:9`, `db/index.ts:19`.

`ensureRegistrySchema()` chỉ nhớ kết quả trong bộ nhớ của một process. Mỗi instance server mới chạy `createRegistrySchema()`, trong đó có **76 lần `await sql.query(...)` nối tiếp** qua Neon HTTP: tạo bảng, ALTER, tạo/drop index, UPDATE/backfill và seed dữ liệu. Dù bảng đã tồn tại vẫn phải gửi lệnh, chờ mạng và kiểm tra database. Một số lệnh DDL còn có thể gây chờ khóa. Khi nhiều instance mới xuất hiện, công việc này lặp lại.

**Sửa:** đưa schema/backfill thành migration có phiên bản, chạy một lần trong quy trình triển khai. Request chỉ kết nối và truy vấn dữ liệu. Tách quyền DDL của migration khỏi tài khoản database dùng bởi web.

**Cảnh báo quan trọng:** không xóa ngay `ensureRegistrySchema()`. Bộ migration hiện chưa thay thế đầy đủ chức năng runtime: migration `drizzle/0000_sticky_dormammu.sql` còn cú pháp SQLite; các bảng Telegram hiện được tạo trong runtime nhưng chưa có migration tương ứng. Một số unique index cũng chưa được khai báo đầy đủ trong Drizzle schema dù đã có ở SQL migration/runtime. Cần đối chiếu schema thực tế, làm migration baseline PostgreSQL và thử trên branch cô lập trước khi chuyển production.

### P2 — Admin tải tất cả tab và toàn bộ record dù chưa mở chi tiết

Nguồn: `app/api/admin/requests/route.ts:35`, `app/api/admin/requests/route.ts:94`, `app/admin/page.tsx:273`, `app/admin/page.tsx:290`.

- Lần mở đầu gọi API session, đợi xong mới gọi dashboard.
- Dashboard thực hiện sáu truy vấn song song, sau đó thêm một truy vấn lấy toàn bộ record của mọi subdomain đang active.
- Payload gồm 500 request mới nhất, 300 sự kiện DNS, toàn bộ subdomain active và dữ liệu Domains, bất kể đang xem tab nào.
- Cứ 15 giây lại tải nguyên dashboard. Khi có record, riêng dashboard có khoảng 28 truy vấn/phút/tab đang mở, chưa tính các request khác. Code đã dừng polling khi tab ẩn và chặn polling chồng nhau — nên giữ hai bảo vệ này.

**Sửa:** tải danh sách tab hiện tại theo trang 30–50 dòng; mỗi tab có API/filter/cursor riêng. Chỉ tải DNS record khi mở một subdomain. Tách endpoint tổng số/phiên bản cập nhật rất nhỏ để polling; dữ liệu đầy đủ chỉ tải khi cần. Có thể dùng kết quả dashboard 401 để xác định chưa đăng nhập, tránh vòng chờ session riêng. Không cache công khai dữ liệu admin/user.

Các truy vấn log toàn hệ thống sắp xếp theo `created_at` cũng cần kiểm tra bằng EXPLAIN trên dữ liệu thực tế; index hiện có theo subdomain/status không mặc nhiên tối ưu được truy vấn toàn hệ thống. Không thêm hàng loạt index khi chưa đo.

### P3 — Các yếu tố cần đo/cấu hình thêm

- Root metadata gọi `headers()` theo User-Agent (`app/layout.tsx:10`), làm cả route admin phụ thuộc request. Nên giới hạn metadata riêng Telegram ở trang công khai để admin có shell tĩnh nếu phù hợp.
- Danh sách domain công khai đang `no-store`; có thể cache ngắn 30–60 giây và làm mới khi admin thay domain.
- Đặt Vercel Function gần region database. Chưa xác minh region đang dùng hoặc connection string có pooler. Kiểm tra giới hạn pool/kết nối tổng khi scale nhiều instance.
- Neon có thể đánh thức compute sau thời gian không dùng; đây là phần trễ bình thường, không phải bằng chứng host lỗi. Ưu tiên bỏ 76 vòng SQL trước, không cần dùng request giữ nóng liên tục.

Đọc tham khảo: [Vercel Function regions](https://vercel.com/docs/functions/configuring-functions/region), [Neon scale-to-zero](https://github.com/neondatabase/website/blob/main/content/docs/introduction/scale-to-zero.md).

## 2. Các rủi ro nên sửa trước

### P1 — DNS API chưa giới hạn tốc độ và số record

Nguồn: `app/api/manage/records/route.ts:96`, `:144`, `:207`.

POST/PATCH/DELETE có kiểm tra đăng nhập và owner, nhưng không có quota record, rate limit ghi hoặc cơ chế chặn request trùng. Một user đã được duyệt có thể gọi API liên tục: tạo nhiều record tên khác nhau, sửa đi sửa lại, tăng log, gọi Cloudflare và phát thông báo Telegram. UI không phải hàng rào bảo vệ vì người dùng có thể gọi API trực tiếp. Admin còn tải toàn bộ các record nên chịu ảnh hưởng theo.

**Sửa đề xuất cho quy mô hiện tại:** mặc định 50 record/subdomain; khoảng 10 lần thay đổi/phút/owner, cộng giới hạn IP và ngân sách chung cho provider. Các số này là cấu hình khởi điểm, điều chỉnh theo nhu cầu, không phải giới hạn của Cloudflare. Kiểm tra quota phải atomic trong transaction/khóa phù hợp để nhiều POST đồng thời không vượt quota. PATCH không đổi gì thì không gọi provider, không ghi log/thông báo mới. Thêm idempotency cho retry và phân trang đọc record.

### P1 — Database và Cloudflare có thể lệch nhau

Nguồn: `app/api/manage/records/route.ts:108`, `:121`, `:164`, `:224`; `lib/cloudflare.ts:58`.

Luồng record hiện là đổi DNS ở Cloudflare → ghi database → ghi audit riêng. Nếu một bước sau thất bại, DNS có thể đã đổi nhưng database vẫn cũ; POST có thể để lại record không có trong database. PATCH/DELETE đồng thời trên cùng record cũng chưa được serialize. Cloudflare fetch chưa có timeout riêng.

**Sửa:** ghi trạng thái operation/idempotency, phối hợp thao tác theo record/subdomain, transaction cho thay đổi database + audit, timeout giới hạn, và cơ chế đối soát/khôi phục khi provider đã thành công nhưng database chưa lưu. Không giữ transaction database lâu chỉ để chờ network. Một transaction PostgreSQL không thể tự rollback DNS đã đổi ở Cloudflare.

Luồng admin duyệt đã có review lease, transaction và thử xóa record mới nếu lưu thất bại. Đây là bảo vệ tốt cần giữ; cần mở rộng nguyên tắc này sang panel và bổ sung recovery cho trường hợp process chết giữa chừng.

### P1 — Xóa subdomain có thể chạy đồng thời với thêm record

Nguồn: `app/api/manage/subdomains/route.ts:117`.

Luồng xóa chụp danh sách record, xóa từng record ở Cloudflare, rồi mới xóa subdomain trong transaction. Trong thời gian đó subdomain vẫn active, nên request tạo record mới có thể đi qua kiểm tra quyền. Record phát sinh sau ảnh chụp có thể bị bỏ sót ở Cloudflare dù tên được trả lại kho đăng ký. Nếu Cloudflare lỗi giữa chừng thì một phần DNS đã mất; mã Telegram cũng đã được tiêu thụ.

**Sửa:** có trạng thái `deleting`/operation lock, mọi mutation phải kiểm tra và phối hợp với trạng thái này. Xóa theo tiến độ có thể tiếp tục/retry an toàn; không trả tên về available trước khi đã xử lý hết DNS. Khi một phần thất bại phải báo đang xử lý/xóa chưa hoàn tất, không giả vờ mọi thứ chưa thay đổi. Định nghĩa rõ việc xác minh Telegram cho operation có thời hạn và chống replay.

### P1 — Chặn spam đăng ký đang đặt quá muộn

Nguồn: `app/api/requests/route.ts:51`, `:78`, `:112`; `lib/rate-limit.ts:30`.

Quota IP chỉ tính request hợp lệ sau khi đã đọc domain, validate, đếm Telegram và kiểm tra tên trùng. Cách này giúp người dùng không bị khóa vì typo nhưng để request sai/trùng tên gọi database không bị giới hạn ở lớp này. Telegram username là chuỗi chưa xác minh, có thể đổi tùy ý; kiểm tra số request trước insert cũng không atomic. Giới hạn email theo địa chỉ không chặn được người spam luân phiên nhiều địa chỉ. Limiter lưu PostgreSQL vẫn cần một lần ghi database cho mỗi lần bị chặn.

**Sửa:** tách hai lớp: giới hạn số lần gọi rộng ngay đầu request, và quota gửi hợp lệ chặt hơn giữ nguyên ý nghĩa hiện tại. Có limiter/challenge ở lớp trước database cho lưu lượng lớn. Với dịch vụ chỉ cho bạn bè, invite code là phương án đơn giản; Turnstile là lựa chọn bổ sung nếu mở đăng ký công khai. Thêm giới hạn tổng email/Telegram, không coi username tự khai là identity đã xác minh. Nếu cần chống mail bombing mạnh hơn, xác minh email trước khi tạo yêu cầu chờ duyệt.

Pending request chưa có thời hạn hết hạn tự động, nên có thể giữ tên vô thời hạn. Có thể đặt 7 ngày, thêm trạng thái expired và giữ lịch sử theo đúng yêu cầu của admin, không xóa mất log.

### P1 — Chưa bảo vệ cookie mutation đầy đủ trước subdomain cùng gốc

Nguồn: `app/api/manage/records/route.ts:96`, `app/api/manage/session/route.ts:125`, `app/api/admin/telegram/route.ts:7`, `lib/admin-auth.ts:5`.

Cookie đang HttpOnly, Secure production, host-only và SameSite=Lax — tốt, nhưng `foo.takeshi.dev` và `domain.takeshi.dev` vẫn là cùng site. Một số API mutation thiếu kiểm tra Origin/Content-Type. Simple POST từ một subdomain do user kiểm soát có thể mang cookie mà CORS chỉ chặn đọc response, không nhất thiết chặn mutation. Luồng tạo record còn cần biết subdomain ID; đây không phải kết luận có thể sửa mọi DNS của admin. PATCH/DELETE thông thường chịu kiểm tra preflight, nên không đánh đồng chúng với simple POST.

Cookie hiện không dùng prefix `__Host-`; subdomain con có thể đặt cookie Domain cho domain cha cùng tên, gây nhiễu/fixation session. Nó không đọc được cookie HttpOnly host-only của nạn nhân và không tự giả được chữ ký admin.

**Sửa:** middleware/helper chung kiểm tra Origin chính xác và JSON Content-Type cho mọi mutation dùng cookie, thêm CSRF/fetch-metadata theo nhu cầu, không allowlist `*.takeshi.dev`. Dùng cookie `__Host-...` với Secure + Path=/ + không Domain, có kế hoạch đổi tên cho phiên hiện tại. Thêm chống iframe (`frame-ancestors`) và no-store cho dữ liệu nhạy cảm. SameSite=Strict một mình không xử lý được sibling subdomain cùng site.

Một số route như domain admin, recovery và Telegram link đã kiểm tra Origin; cần chuẩn hóa thay vì viết rời rạc. Chưa làm thử nghiệm CSRF trên production.

Tham khảo: [MDN CSRF](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/CSRF), [MDN cookie scope/prefix](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies).

### P1 — Đổi admin key làm ảnh hưởng mọi user key

Nguồn: `lib/owner-auth.ts:15`, `:26`; `lib/telegram.ts:107`.

`REGISTRY_ADMIN_KEY` vừa là mật khẩu admin vừa là bí mật dùng hash user key/session, dẫn xuất key gửi email và bảo vệ token/mã Telegram. Đổi mật khẩu admin làm đổi hash của mọi access key, mất phiên và khiến xác định key request mới/legacy sai. Đã kiểm chứng cục bộ việc đổi secret làm thay đổi hash user key và key dẫn xuất cho cùng request ID.

**Sửa:** tách mật khẩu admin khỏi secret xác thực/dẫn xuất ổn định, dùng phiên bản secret. Cần migration tương thích hash/key cũ, có cơ chế rehash khi đăng nhập và xử lý request đang chờ duyệt; không chỉ đổi biến môi trường vì sẽ khóa user cũ. Chưa cần đổi secret vội nếu chưa có kế hoạch này.

## 3. Lỗi logic và độ ổn định khác

### P2 — Validation runtime chưa đầy đủ, có thể gây HTTP 500

Nguồn: `lib/dns.ts:56`; nhiều route ép kiểu `await request.json() as ...`.

TypeScript không validate JSON bên ngoài. `recordName` thiếu hoặc `content` là số làm `.trim()` ném lỗi thay vì trả 400; đã tái hiện cục bộ. JSON `null` cũng có thể lỗi khi đọc `body.action`/`body.accessKey`. `Boolean("false")` thành true, không đúng với kiểu boolean mong đợi.

**Sửa:** schema validation runtime cho từng endpoint; reject null/array/kiểu sai/enum sai; giới hạn body thực đọc, string và ID trước khi gọi database. Không chỉ tin Content-Length. Phản hồi 400 có cấu trúc, không lộ SQL/provider internals. Validator frontend/server cần đồng bộ; kiểm tra thêm full hostname, CAA flag 0–255, xung đột CNAME và các quy tắc record thực tế. Route admin đã kiểm tra action hợp lệ — giữ nguyên.

### P2 — Record chính có thể bị đổi tên thành record con

Nguồn: `app/api/manage/records/route.ts:163`; `app/manage/page.tsx:933`.

PATCH giữ `isPrimary=true` nhưng cho đổi `recordName` từ `@` sang `web`. UI vẫn gọi đó là primary của subdomain dù apex không còn record chính.

**Sửa:** record primary phải cố định tên `@` ở server; UI khóa ô tên khi sửa primary. Thêm invariant/index phù hợp bảo đảm không có nhiều primary trên một subdomain, đối chiếu dữ liệu cũ trước khi tạo constraint. Vẫn cho thêm record khác tại `@` nếu loại DNS cho phép — không cấm tất cả record cùng tên một cách máy móc.

### P2 — Chờ duyệt có thể mất khỏi giao diện sau 500 request mới hơn

Nguồn: `app/api/admin/requests/route.ts:44`, `app/admin/page.tsx:227`.

API lấy 500 request mới nhất mọi trạng thái, frontend mới lọc pending. Request pending cũ có thể không xuất hiện dù tổng pending trong database vẫn có. Log DNS chỉ hiển thị 300 dòng gần nhất, chưa có đường xem lịch sử cũ.

**Sửa:** query theo trạng thái ở server, phân trang và tổng số riêng; không dùng một trang all-status làm toàn bộ hàng đợi. Giữ log nhưng có cursor/filter theo domain, người thao tác và thời gian.

### P2 — API reset key admin chưa atomic

Nguồn: `app/api/admin/requests/route.ts:174`.

Update key → xóa session → ghi log là ba lần autocommit. Lỗi giữa chừng có thể làm key đã đổi nhưng admin không nhận được kết quả; reset đồng thời recovery/đổi key của user có thể trả key đã lỗi thời.

**Sửa:** lock owner và transaction cho key + session revoke + audit, thống nhất thứ tự lock với recovery. Admin cookie hiện stateless nên logout chỉ xóa bản trong trình duyệt; nếu cần thu hồi bản cookie đã bị sao chép thì dùng session DB/version/revoke riêng, không xoay bí mật chung của tất cả user.

### P2 — Telegram webhook thiếu rate limit và idempotency atomic

Nguồn: `app/api/telegram/webhook/route.ts:124`; `lib/telegram.ts:268`, `:307`, `:778`.

- Secret header đã chặn request HTTP giả trực tiếp, nhưng người dùng Telegram thật vẫn có thể gửi nhiều `/start` token sai: tạo truy vấn DB và bot reply liên tục.
- Kiểm tra update đã xử lý và đánh dấu sau khi xử lý là hai bước tách biệt. Telegram retry đồng thời có thể sinh reply success rồi expired cho cùng update. Kết quả gửi reply thất bại chưa ngăn đánh dấu processed.
- Tạo link khóa owner rồi thao tác token; consume link khóa token rồi owner. Thứ tự ngược nhau có thể deadlock khi tạo link mới và dùng link cũ đồng thời.

**Sửa:** limiter theo Telegram ID + tổng bot; giảm/cooldown reply token sai; atomic claim update với lease và lưu kết quả; retry notification riêng; thống nhất thứ tự lock và retry transaction có giới hạn. Không bỏ secret webhook hoặc bỏ xác minh chat private.

Username đã liên kết có thể cũ sau khi user đổi tên Telegram. Giữ Telegram ID làm identity chính, cập nhật profile từ update đã xác minh; không tự liên kết chỉ vì trùng username. Hiện mỗi đăng ký mới tạo owner riêng nhưng một Telegram ID chỉ liên kết được một owner, nên người đăng ký nhiều domain không thể liên kết cùng Telegram cho các owner đó. Cần quyết định luồng thêm domain vào owner đã đăng nhập/xác minh; tuyệt đối không tự gộp bằng email/username tự khai.

### P2 — Email/notification cần retry bền vững

Nguồn: `app/api/requests/route.ts:161`; `lib/approval-email.ts:13`; `lib/request-email.ts:12`.

Đăng ký đợi gửi receipt email + Telegram admin rồi mới trả response; Resend timeout 10 giây, Telegram 7 giây. Vì request đã được lưu, nếu trình duyệt mất kết nối trước response thì user có thể tưởng thất bại và gửi lại. Email duyệt hiện là kênh nhận key chính; có retry thủ công nhưng chưa có outbox/retry tự động. API accepted cũng chưa chứng minh thư tới inbox; chưa lưu trạng thái bounce/delivery từ provider.

**Sửa:** transaction lưu request + notification job, trả thành công khi đã lưu chắc chắn; worker xử lý outbox với idempotency/retry/backoff. Có thể dùng chính PostgreSQL, không cần thêm Redis cho quy mô này. `after()` hữu ích cho best-effort nhưng không thay hàng đợi bền vững của email chứa key. Job email cần key version, tránh gửi key cũ khi admin/user đã reset; không lưu access key thô vào log/job không mã hóa. Cho admin xem trạng thái giao thư và retry có kiểm soát.

### P2 — Trạng thái UI có thể bị kẹt hoặc nhận kết quả cũ

Nguồn: `app/manage/page.tsx:526`, `:544`, `:795`; `app/page.tsx:287`.

Một số handler DNS không có try/catch/finally; mất mạng hoặc response không phải JSON làm trạng thái `saving` không quay về idle. Check availability so sánh biến trong cùng closure cũ, nên response cho tên/domain cũ có thể cập nhật trạng thái input mới. Backend uniqueness vẫn chặn đăng ký trùng, nhưng UX báo sai.

**Sửa:** wrapper gọi API có timeout, xử lý response và finally; phân biệt lưu đã thành công với tải lại panel thất bại để không tạo duplicate. Check tên dùng request sequence + AbortController + ref cho tuple hiện tại. Poll Telegram link nên có visibility và in-flight guard giống admin.

### P2 — Dữ liệu tạm chưa có cơ chế dọn định kỳ

Nguồn: các bảng session, rate limit, Telegram token/challenge/grant/webhook trong `db/schema.ts`.

Không thấy job cleanup trong repository. Bản ghi hết hạn/đã dùng vẫn tích lũy dù auth không chấp nhận chúng nữa.

**Sửa:** cleanup theo batch định kỳ, index theo expiry/processed time; giữ thời gian đệm cho retry. Pending expiry là chuyển trạng thái, không xóa lịch sử. Audit/request log có chính sách giữ và phân trang riêng, không xóa toàn bộ để làm nhẹ trang.

### P2 — Dependency có cảnh báo cần vá, nhưng không đồng nghĩa đã bị khai thác

Nguồn: `package.json`, `package-lock.json`, kết quả `npm audit` tại thời điểm rà.

Audit production báo ba nhóm package có cảnh báo: Next.js, sharp và postcss (một critical, hai high). Audit đầy đủ báo 15 nhóm có cảnh báo, bao gồm dev dependency. Phiên bản Next đang là 16.2.6; công cụ đề xuất bản vá 16.3.8 tại thời điểm kiểm tra.

Không thể chỉ từ điểm critical kết luận website bị RCE. Ví dụ advisory `next/og` cần Node runtime và SVG đầu vào không tin cậy; route Telegram card của project dùng Edge và nội dung cố định, không thỏa điều kiện đó. Advisory Server Functions cần endpoint tương ứng; repository không có Server Actions được khai báo. Những cảnh báo image optimization cũng cần xét đường nhận ảnh thực tế.

**Sửa:** nâng các package cùng nhóm theo phiên bản tương thích đã vá, kiểm tra dependency trực tiếp `react-server-dom-webpack` có cần giữ không, chạy lại audit/lint/typecheck/build và test route sau nâng. Không chạy `npm audit fix --force` vì đề xuất tự động có thể downgrade hoặc phá tương thích.

Tham khảo: [Next.js next/og advisory và điều kiện ảnh hưởng](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j), [React Server Functions advisory](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g).

## 4. Những bảo vệ hiện có cần giữ

- API DNS kiểm tra owner qua join/filter; không thấy đường trực tiếp cho user A sửa record thuộc user B trong các route đã rà. Tên record được nối dưới subdomain đã sở hữu, không cho nhập tên ngang hàng tùy ý.
- Dùng truy vấn Drizzle/SQL tham số hóa; chưa thấy SQL ghép trực tiếp input user trong các query đã rà.
- Cookie HttpOnly/Secure, chữ ký admin và token ngẫu nhiên; access key lưu hash thay vì plaintext. Email template escape dữ liệu động, React render text bình thường, chưa thấy `dangerouslySetInnerHTML` nhận input user.
- Mã Telegram có expiry, giới hạn số lần thử, ràng buộc owner/purpose/subject và cơ chế một lần; xác minh ID/chat private trước liên kết.
- Unique constraint cho tên đang pending/active, review lease và transaction khi duyệt, giữ lịch sử cancelled/rejected/released.
- Gửi Telegram DNS đã đặt sau response và xử lý best-effort, không biến lỗi bot thành lỗi DNS giả.

Đây không phải chứng nhận website tuyệt đối an toàn hay kết luận chưa từng bị tấn công.

## 5. Kế hoạch sửa phù hợp quy mô hiện tại

1. **Hiệu năng/admin:** hoàn thiện migration baseline trên branch test; bỏ DDL/backfill khỏi request; tách dữ liệu theo tab, phân trang và lazy-load record. Đo thời gian schema/auth/query/payload bằng log và Server-Timing không chứa thông tin bí mật.
2. **Chống phá:** thêm quota DNS atomic, giới hạn mutation, early attempt limiter và ngân sách email/bot; bảo vệ Origin/cookie chung. Nâng dependency có kiểm thử song song với nhóm này.
3. **Nhất quán:** operation state/idempotency, serialize record/delete, timeout/reconciliation Cloudflare; transaction key reset và audit.
4. **Ổn định lâu dài:** migration tách secret tương thích user cũ, outbox email, webhook atomic, cleanup định kỳ, validation/runtime và sửa trạng thái UI.

Không cần viết lại web, thay database hoặc triển khai microservice. Dùng PostgreSQL hiện tại cho quota, operation và outbox là đủ cho mức sử dụng dự kiến. Giữ giao diện/chủ đề; thay đổi chủ yếu ở backend và cách lấy dữ liệu admin.

## 6. Kiểm tra đã thực hiện và giới hạn kết quả

- `npm run lint`: đạt.
- `npx tsc --noEmit`: đạt.
- `npm audit --omit=dev` và audit đầy đủ: có cảnh báo như trên.
- Tái hiện cục bộ lỗi `.trim()` khi JSON sai kiểu, validator cho phép primary đổi tên, và ảnh hưởng đổi admin secret; dùng dữ liệu giả, không sửa database.
- Ba GET production đọc-only: admin HTML TTFB khoảng 0,75 giây; API domain công khai khoảng 1,23 và 0,61 giây. Không biết mẫu nào là cold/warm, không có phiên admin để đo API dashboard đã xác thực. Các số này không phải benchmark hoặc cam kết sau sửa.
- Chưa có automated test suite trong repo. Chưa có quyền đọc cấu hình/log/SQL production trong phiên rà này; chưa đo region, query plan, dung lượng bảng, tỷ lệ lỗi hoặc quota thực dùng. Chưa chạy stress test hay PoC trên website thật.

Test cần thêm khi triển khai: cross-owner access; quota với nhiều POST đồng thời; tạo record đồng thời xóa subdomain; provider thành công nhưng DB lỗi; retry operation; CSRF từ sibling subdomain; JSON null/sai kiểu/body quá lớn; webhook duplicate đồng thời; OTP hết hạn/replay; xoay admin password vẫn đăng nhập key cũ; hơn 500 request vẫn thấy pending cũ; mạng lỗi UI không bị kẹt; email retry không gửi key đã bị thay.
