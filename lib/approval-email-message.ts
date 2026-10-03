type ApprovalMessage = { hostname: string; language: string };
type RequestReceivedMessage = ApprovalMessage & { requestId: string };
type ApprovedMessage = ApprovalMessage & { accessKey: string | null };
type DeletedMessage = ApprovalMessage & { reason: string };

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
    ? 'You can check or cancel this pending request in DNS Panel on the browser where you registered. If approved, you will receive another email with your access key after the primary DNS record is created.'
    : 'Bạn có thể xem hoặc hủy yêu cầu đang chờ trong DNS Panel trên trình duyệt vừa đăng ký. Nếu được duyệt, bạn sẽ nhận email tiếp theo kèm access key sau khi DNS record chính được tạo.';
  const note = en
    ? `Request ID: ${shortRequestId}. No access key is included in this receipt.`
    : `Mã request: ${shortRequestId}. Email xác nhận này chưa chứa access key.`;
  const footer = en
    ? 'This address was entered in a Takeshi Domains registration. If it was not you, you can ignore this email.'
    : 'Địa chỉ này đã được điền trong một yêu cầu đăng ký Takeshi Domains. Nếu không phải bạn đăng ký, bạn có thể bỏ qua thư.';
  return {
    subject: en ? `${hostname} — request received` : `${hostname} — đã nhận yêu cầu đăng ký`,
    text: [title, description, instructions, panelUrl, note, footer].join('\n\n'),
    html: `<html lang="${en ? 'en' : 'vi'}"><body style="margin:0;background:#10140e;color:#e7eddb;font-family:Arial,sans-serif"><div style="max-width:540px;margin:24px auto;padding:28px;border:1px solid #52613b;background:#192014"><p style="color:#b7d967;font-size:12px;letter-spacing:2px">TAKESHI DOMAINS</p><h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${escapeHtml(description)}</p><p style="line-height:1.6">${instructions}</p><p style="margin:26px 0"><a href="${panelUrl}" style="display:inline-block;padding:12px 18px;background:#b7d967;color:#15200c;font-weight:bold;text-decoration:none">${en ? 'View request status' : 'Xem trạng thái yêu cầu'}</a></p><p style="font-size:13px;line-height:1.6;color:#c0caae">${note}</p><p style="font-size:11px;line-height:1.5;color:#a7b396;border-top:1px solid #52613b;padding-top:16px">${footer}</p></div></body></html>`,
  };
}

export function buildApprovalEmail({ hostname, language, accessKey }: ApprovedMessage) {
  const en = language === 'en';
  // The derived access key stays stable for retries with the same idempotency key.
  const panelUrl = 'https://domain.takeshi.dev/manage';
  const title = en ? 'Your subdomain is approved' : 'Subdomain của bạn đã được duyệt';
  const description = en
    ? `${hostname} is now active. Its primary DNS record has been created.`
    : `${hostname} đã được kích hoạt và tạo DNS record chính.`;
  const instructions = accessKey
    ? en ? 'Use the access key below to sign in to DNS Panel and manage your records.' : 'Dùng access key bên dưới để đăng nhập DNS Panel và quản lý các DNS record.'
    : en ? 'Open DNS Panel and sign in with the access key you chose during registration.' : 'Mở DNS Panel và đăng nhập bằng access key bạn đã đặt khi đăng ký.';
  const keyLabel = en ? 'Your access key' : 'Access key của bạn';
  const note = en
    ? 'DNS changes may take a little time to appear. Keep your access key private.'
    : 'DNS có thể cần một chút thời gian để cập nhật. Hãy giữ access key riêng tư.';
  const footer = en
    ? 'You received this one-time notification because this address was entered in a Takeshi Domains registration. If it was not you, you can ignore this email.'
    : 'Bạn nhận thông báo một lần này vì địa chỉ email đã được điền trong yêu cầu đăng ký Takeshi Domains. Nếu không phải bạn đăng ký, bạn có thể bỏ qua thư.';
  return {
    subject: en ? `${hostname} — registration approved` : `${hostname} — đăng ký đã được duyệt`,
    text: [title, description, instructions, accessKey ? `${keyLabel}: ${accessKey}` : null, panelUrl, note, footer].filter(Boolean).join('\n\n'),
    html: `<html lang="${en ? 'en' : 'vi'}"><body style="margin:0;background:#10140e;color:#e7eddb;font-family:Arial,sans-serif"><div style="max-width:540px;margin:24px auto;padding:28px;border:1px solid #52613b;background:#192014"><p style="color:#b7d967;font-size:12px;letter-spacing:2px">TAKESHI DOMAINS</p><h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${escapeHtml(description)}</p><p style="line-height:1.6">${instructions}</p>${accessKey ? `<p style="margin:20px 0;padding:14px;border:1px solid #789848;background:#10170c"><span style="display:block;margin-bottom:7px;color:#b7d967;font-size:12px">${keyLabel}</span><code style="color:#e7eddb;font-size:16px;word-break:break-all">${escapeHtml(accessKey)}</code></p>` : ''}<p style="margin:26px 0"><a href="${panelUrl}" style="display:inline-block;padding:12px 18px;background:#b7d967;color:#15200c;font-weight:bold;text-decoration:none">${en ? 'Open DNS Panel' : 'Mở DNS Panel'}</a></p><p style="font-size:13px;line-height:1.6;color:#c0caae">${note}</p><p style="font-size:11px;line-height:1.5;color:#a7b396;border-top:1px solid #52613b;padding-top:16px">${footer}</p></div></body></html>`,
  };
}

export type EmailTransportResult = { accepted: true } | { accepted: false; error: string };

export function buildDeletionEmail({ hostname, language, reason }: DeletedMessage) {
  const en = language === 'en';
  const title = en ? 'Your subdomain has been deleted' : 'Subdomain của bạn đã bị xoá';
  const description = en ? `An administrator deleted ${hostname} and all of its DNS records.` : `Admin đã xoá ${hostname} cùng toàn bộ DNS record của subdomain này.`;
  const note = en ? 'This subdomain is no longer available in your DNS Panel. Contact the administrator if you need assistance.' : 'Bạn không còn quản lý subdomain này trong DNS Panel. Nếu cần hỗ trợ, vui lòng liên hệ admin.';
  const reasonLabel = en ? 'Reason' : 'Lý do';
  return {
    subject: en ? `${hostname} — subdomain deleted` : `${hostname} — subdomain đã bị xoá`,
    text: [title, description, `${reasonLabel}: ${reason}`, note, 'https://t.me/jinndesu'].join('\n\n'),
    html: `<html lang="${en ? 'en' : 'vi'}"><body style="margin:0;background:#10140e;color:#e7eddb;font-family:Arial,sans-serif"><div style="max-width:540px;margin:24px auto;padding:28px;border:1px solid #52613b;background:#192014"><p style="color:#b7d967;font-size:12px;letter-spacing:2px">TAKESHI DOMAINS</p><h1 style="font-size:24px">${title}</h1><p style="line-height:1.6">${escapeHtml(description)}</p><p style="padding:14px;border:1px solid #895a4b;background:#2d211a;line-height:1.6;white-space:pre-wrap"><strong>${reasonLabel}:</strong> ${escapeHtml(reason)}</p><p style="line-height:1.6">${note}</p><p><a href="https://t.me/jinndesu" style="color:#b7d967">${en ? 'Contact Admin' : 'Liên hệ Admin'}</a></p></div></body></html>`,
  };
}

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
  requestId: string; email: string; hostname: string; language: string; accessKey: string | null;
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

export function sendDeletionEmail(input: {
  requestId: string; email: string; hostname: string; language: string; reason: string; apiKey: string; from: string;
}) {
  return sendResendEmail({ email: input.email, apiKey: input.apiKey, from: input.from,
    idempotencyKey: `deletion-v1/${input.requestId}`, message: buildDeletionEmail(input) });
}
