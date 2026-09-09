type ApprovalMessage = { hostname: string; language: string };
type RequestReceivedMessage = ApprovalMessage & { requestId: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function buildRequestReceivedEmail({ hostname, language, requestId }: RequestReceivedMessage) {
  const en = language === 'en';
  const panelUrl = 'https://domain.takeshi.dev/manage';
  const shortRequestId = requestId.slice(0, 8);
  const title = en ? 'Registration request received' : 'Đã nhận yêu cầu đăng ký';
  const description = en
    ? `We received your request for ${hostname}. It is now waiting for manual review.`
    : `Hệ thống đã nhận yêu cầu cho ${hostname}. Yêu cầu đang chờ admin duyệt thủ công.`;
  const instructions = en
    ? 'You will receive another email after the subdomain is approved and its primary DNS record is created. You can also use DNS Panel to check the current status.'
    : 'Bạn sẽ nhận thêm một email sau khi subdomain được duyệt và DNS record chính được tạo. Bạn cũng có thể mở DNS Panel để kiểm tra trạng thái.';
  const note = en
    ? `Request ID: ${shortRequestId}. Keep the access key you chose private; it is not included in this email.`
    : `Mã request: ${shortRequestId}. Hãy giữ riêng access key bạn đã đặt; key không được đưa vào email này.`;
  const footer = en
    ? 'This address was entered in a Takeshi Domains registration. If it was not you, you can ignore this email.'
    : 'Địa chỉ này đã được điền trong một yêu cầu đăng ký Takeshi Domains. Nếu không phải bạn đăng ký, bạn có thể bỏ qua thư.';
  return {
    subject: en ? `${hostname} — request received` : `${hostname} — đã nhận yêu cầu đăng ký`,
    text: [title, description, instructions, panelUrl, note, footer].join('\n\n'),
    html: `<html lang="${en ? 'en' : 'vi'}"><body style="margin:0;background:#10140e;color:#e7eddb;font-family:Arial,sans-serif"><div style="max-width:540px;margin:24px auto;padding:28px;border:1px solid #52613b;background:#192014"><p style="color:#b7d967;font-size:12px;letter-spacing:2px">TAKESHI DOMAINS</p><h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${escapeHtml(description)}</p><p style="line-height:1.6">${instructions}</p><p style="margin:26px 0"><a href="${panelUrl}" style="display:inline-block;padding:12px 18px;background:#b7d967;color:#15200c;font-weight:bold;text-decoration:none">${en ? 'Check status' : 'Kiểm tra trạng thái'}</a></p><p style="font-size:13px;line-height:1.6;color:#c0caae">${note}</p><p style="font-size:11px;line-height:1.5;color:#a7b396;border-top:1px solid #52613b;padding-top:16px">${footer}</p></div></body></html>`,
  };
}

export function buildApprovalEmail({ hostname, language }: ApprovalMessage) {
  const en = language === 'en';
  // Stable contents make retries with the same idempotency key safe. Never add
  // a timestamp, access key, recipient input, or mutable DNS content here.
  const panelUrl = 'https://domain.takeshi.dev/manage';
  const title = en ? 'Your subdomain is approved' : 'Subdomain của bạn đã được duyệt';
  const description = en
    ? `${hostname} is now active. Its primary DNS record has been created.`
    : `${hostname} đã được kích hoạt và tạo DNS record chính.`;
  const instructions = en
    ? 'Open DNS Panel and sign in with the access key you chose during registration to manage your records.'
    : 'Mở DNS Panel và đăng nhập bằng access key bạn đã đặt khi đăng ký để quản lý các DNS record.';
  const note = en
    ? 'DNS changes may take a little time to appear. Keep your access key private. This email does not grant access to your panel.'
    : 'DNS có thể cần một chút thời gian để cập nhật. Giữ access key riêng tư. Email này không cấp quyền truy cập panel.';
  const footer = en
    ? 'You received this one-time notification because this address was entered in a Takeshi Domains registration. If it was not you, you can ignore this email.'
    : 'Bạn nhận thông báo một lần này vì địa chỉ email đã được điền trong yêu cầu đăng ký Takeshi Domains. Nếu không phải bạn đăng ký, bạn có thể bỏ qua thư.';
  return {
    subject: en ? `${hostname} — registration approved` : `${hostname} — đăng ký đã được duyệt`,
    text: [title, description, instructions, panelUrl, note, footer].join('\n\n'),
    html: `<html lang="${en ? 'en' : 'vi'}"><body style="margin:0;background:#10140e;color:#e7eddb;font-family:Arial,sans-serif"><div style="max-width:540px;margin:24px auto;padding:28px;border:1px solid #52613b;background:#192014"><p style="color:#b7d967;font-size:12px;letter-spacing:2px">TAKESHI DOMAINS</p><h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${escapeHtml(description)}</p><p style="line-height:1.6">${instructions}</p><p style="margin:26px 0"><a href="${panelUrl}" style="display:inline-block;padding:12px 18px;background:#b7d967;color:#15200c;font-weight:bold;text-decoration:none">${en ? 'Open DNS Panel' : 'Mở DNS Panel'}</a></p><p style="font-size:13px;line-height:1.6;color:#c0caae">${note}</p><p style="font-size:11px;line-height:1.5;color:#a7b396;border-top:1px solid #52613b;padding-top:16px">${footer}</p></div></body></html>`,
  };
}

export type EmailTransportResult = { accepted: true } | { accepted: false; error: string };

async function sendResendEmail(input: {
  email: string; apiKey: string; from: string; idempotencyKey: string;
  message: ReturnType<typeof buildApprovalEmail>;
}): Promise<EmailTransportResult> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({ from: input.from, to: [input.email], ...input.message }),
      signal: AbortSignal.timeout(10_000),
    });
    // Do not expose provider errors: they can contain addresses or credentials.
    if (!response.ok) return { accepted: false, error: `provider_${response.status}` };
    const payload: unknown = await response.json();
    return payload && typeof payload === 'object' && 'id' in payload && typeof payload.id === 'string' && payload.id
      ? { accepted: true }
      : { accepted: false, error: 'delivery_unknown' };
  } catch {
    return { accepted: false, error: 'delivery_unknown' };
  }
}

export function sendRequestReceivedEmail(input: {
  requestId: string; email: string; hostname: string; language: string;
  apiKey: string; from: string;
}) {
  return sendResendEmail({
    email: input.email,
    apiKey: input.apiKey,
    from: input.from,
    idempotencyKey: `request-received-v1/${input.requestId}`,
    message: buildRequestReceivedEmail(input),
  });
}

export async function sendApprovalEmail(input: {
  requestId: string; email: string; hostname: string; language: string;
  apiKey: string; from: string;
}): Promise<EmailTransportResult> {
  return sendResendEmail({
    email: input.email,
    apiKey: input.apiKey,
    from: input.from,
    idempotencyKey: `approval-v1/${input.requestId}`,
    message: buildApprovalEmail(input),
  });
}
