'use client';

import { FormEvent, useState } from 'react';

import { HoldToRevealButton } from '@/app/components/HoldToRevealButton';
import { isValidCnameTarget, isValidOwnerAccessKey, isValidSubdomain, isValidTelegramUsername } from '@/lib/registry';

type SubmissionState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'success'; requestId: string };
type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'error';
type FieldName = 'subdomain' | 'cnameTarget' | 'telegramUsername' | 'accessKey' | 'rules';
type FieldState = { kind: 'idle' | 'valid' | 'invalid'; message: string };

const emptyTouched: Record<FieldName, boolean> = {
  subdomain: false,
  cnameTarget: false,
  telegramUsername: false,
  accessKey: false,
  rules: false,
};

function formatRetryAfter(retryAfterSeconds?: number) {
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) return '';

  const totalSeconds = Math.ceil(retryAfterSeconds);
  if (totalSeconds < 60) return `${totalSeconds} giây`;

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} phút`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
}

export default function Home() {
  const [subdomain, setSubdomain] = useState('');
  const [cnameTarget, setCnameTarget] = useState('');
  const [telegramUsername, setTelegramUsername] = useState('');
  const [accessKeySuffix, setAccessKeySuffix] = useState('');
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [website, setWebsite] = useState('');
  const [submission, setSubmission] = useState<SubmissionState>({ type: 'idle' });
  const [availability, setAvailability] = useState<AvailabilityState>('idle');
  const [availabilityMessage, setAvailabilityMessage] = useState('');
  const [touched, setTouched] = useState(emptyTouched);
  const [requiredOnSubmit, setRequiredOnSubmit] = useState(emptyTouched);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});

  const accessKey = `tk-${accessKeySuffix}`;
  function withServerError(field: FieldName, state: FieldState): FieldState {
    return serverErrors[field] ? { kind: 'invalid', message: serverErrors[field] } : state;
  }

  function requiredFieldState(field: FieldName, hasValue: boolean, valid: boolean, validMessage: string, invalidMessage: string): FieldState {
    if (!hasValue && !requiredOnSubmit[field]) return { kind: 'idle', message: '' };
    return valid ? { kind: 'valid', message: validMessage } : { kind: 'invalid', message: invalidMessage };
  }

  const fieldState: Record<FieldName, FieldState> = {
    subdomain: withServerError('subdomain', !subdomain.trim() && !requiredOnSubmit.subdomain
      ? { kind: 'idle', message: '' }
      : !isValidSubdomain(subdomain)
        ? { kind: 'invalid', message: 'Tên phải dài 3–63 ký tự, chỉ gồm a–z, 0–9 và dấu gạch ngang.' }
        : availability === 'available'
          ? { kind: 'valid', message: availabilityMessage || '✓ Tên có thể dùng.' }
          : availability === 'taken' || availability === 'error'
            ? { kind: 'invalid', message: availabilityMessage || 'Không thể dùng tên này.' }
            : { kind: 'idle', message: availability === 'checking' ? 'Đang kiểm tra tên...' : 'Rời ô để kiểm tra tên.' }),
    cnameTarget: withServerError('cnameTarget', requiredFieldState(
      'cnameTarget',
      Boolean(cnameTarget.trim()),
      isValidCnameTarget(cnameTarget.trim().toLowerCase().replace(/\.+$/, '')),
      '✓ CNAME hợp lệ.',
      !cnameTarget.trim() ? 'Nhập CNAME đích.' : 'CNAME cần là hostname hợp lệ, ví dụ your-project.pages.dev.',
    )),
    telegramUsername: withServerError('telegramUsername', requiredFieldState(
      'telegramUsername',
      Boolean(telegramUsername.trim()),
      isValidTelegramUsername(telegramUsername),
      '✓ Telegram username hợp lệ.',
      !telegramUsername.trim() ? 'Nhập Telegram username.' : 'Username Telegram dài 5–32 ký tự, bắt đầu bằng chữ và chỉ dùng chữ, số, _.',
    )),
    accessKey: withServerError('accessKey', requiredFieldState(
      'accessKey',
      Boolean(accessKeySuffix.trim()),
      isValidOwnerAccessKey(accessKey),
      '✓ Access key đúng định dạng.',
      !accessKeySuffix.trim() ? 'Nhập phần access key sau tk-.' : 'Phần sau tk- phải dài 11–29 ký tự, có cả chữ và số; chỉ dùng thêm . _ - khi cần.',
    )),
    rules: withServerError('rules', requiredFieldState(
      'rules',
      acceptedRules,
      acceptedRules,
      '✓ Đã đồng ý quy định.',
      'Bạn cần đồng ý với quy định để gửi yêu cầu.',
    )),
  };

  function markTouched(field: FieldName) {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function resetFieldFeedback(field: FieldName) {
    setTouched((current) => ({ ...current, [field]: false }));
    setRequiredOnSubmit((current) => ({ ...current, [field]: false }));
    setServerErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmission({ type: 'idle' });
  }

  function cleanSubdomain(value: string) {
    setSubdomain(value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63));
    setAvailability('idle');
    setAvailabilityMessage('');
    resetFieldFeedback('subdomain');
  }

  async function checkAvailability(): Promise<AvailabilityState> {
    markTouched('subdomain');
    if (!subdomain.trim()) {
      setAvailability('idle');
      setAvailabilityMessage('');
      return 'idle';
    }
    if (!isValidSubdomain(subdomain)) {
      setAvailability('error');
      setAvailabilityMessage('Tên subdomain không hợp lệ hoặc đang được reserved.');
      return 'error';
    }

    const candidate = subdomain;
    setAvailability('checking');
    setAvailabilityMessage('');
    try {
      const response = await fetch(`/api/requests?subdomain=${encodeURIComponent(candidate)}`);
      const payload = await response.json() as { available?: boolean; error?: string };
      if (candidate !== subdomain) return 'idle';
      if (!response.ok) {
        setAvailability('error');
        setAvailabilityMessage(payload.error ?? 'Không thể kiểm tra tên lúc này.');
        return 'error';
      }
      const result = payload.available ? 'available' : 'taken';
      setAvailability(result);
      setAvailabilityMessage(payload.available ? '✓ Tên có thể dùng.' : 'Tên đã được đăng ký hoặc đang chờ duyệt.');
      return result;
    } catch {
      if (candidate === subdomain) {
        setAvailability('error');
        setAvailabilityMessage('Không thể kết nối registry. Hãy thử lại.');
      }
      return 'error';
    }
  }

  function displayHint(field: FieldName, fallback: string) {
    const state = fieldState[field];
    const shouldShowState = touched[field] && state.kind !== 'idle';
    return <small className={shouldShowState ? `field-${state.kind === 'valid' ? 'good' : 'bad'}` : undefined}>{shouldShowState ? state.message : fallback}</small>;
  }

  function inputClass(field: FieldName, base = 'field') {
    const state = fieldState[field];
    return `${base}${touched[field] && state.kind !== 'idle' ? ` ${state.kind}` : ''}`;
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({ subdomain: true, cnameTarget: true, telegramUsername: true, accessKey: true, rules: true });
    setRequiredOnSubmit({ subdomain: true, cnameTarget: true, telegramUsername: true, accessKey: true, rules: true });
    const localFieldsAreValid = isValidCnameTarget(cnameTarget.trim().toLowerCase().replace(/\.+$/, ''))
      && isValidTelegramUsername(telegramUsername)
      && isValidOwnerAccessKey(accessKey)
      && acceptedRules;
    if (!localFieldsAreValid) {
      setSubmission({ type: 'error', message: 'Hãy sửa các trường được đánh dấu đỏ trước khi gửi.' });
      return;
    }

    const currentAvailability = availability === 'available' ? 'available' : await checkAvailability();
    if (currentAvailability !== 'available') {
      setSubmission({ type: 'error', message: 'Hãy chọn một subdomain còn trống trước khi gửi.' });
      return;
    }

    setSubmission({ type: 'loading' });
    try {
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain, cnameTarget, telegramUsername, accessKey, acceptedRules, website }),
      });
      const payload = await response.json() as { error?: string; field?: FieldName; requestId?: string; retryAfterSeconds?: number };
      if (!response.ok || !payload.requestId) {
        if (payload.field) {
          setServerErrors((current) => ({ ...current, [payload.field as FieldName]: payload.error ?? 'Giá trị không hợp lệ.' }));
          markTouched(payload.field);
        }
        const headerRetryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
        const retryAfter = formatRetryAfter(
          typeof payload.retryAfterSeconds === 'number'
            ? payload.retryAfterSeconds
            : Number.isFinite(headerRetryAfter) ? headerRetryAfter : undefined,
        );
        const errorMessage = payload.error ?? 'Không thể gửi yêu cầu. Hãy thử lại.';
        setSubmission({ type: 'error', message: retryAfter ? `${errorMessage} Thời gian chờ còn lại: khoảng ${retryAfter}.` : errorMessage });
        return;
      }
      setSubmission({ type: 'success', requestId: payload.requestId });
      setAvailability('idle');
      setAvailabilityMessage('');
    } catch {
      setSubmission({ type: 'error', message: 'Không thể kết nối registry. Hãy thử lại.' });
    }
  }

  const heroButtonLabel = availability === 'available' ? 'Đăng ký subdomain' : availability === 'checking' ? 'Đang kiểm tra...' : 'Kiểm tra subdomain';
  const heroStatusClass = availability === 'available' ? 'field-good' : availability === 'taken' || availability === 'error' ? 'field-bad' : undefined;

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Takeshi Domains home">
          <span className="brand-block" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>TAKESHI <span className="brand-dim">DOMAINS</span></span>
        </a>
        <nav className="site-nav" aria-label="Main navigation"><a href="#request">Đăng ký</a><a href="#how">Cách hoạt động</a><a href="#rules">Quy định</a><a className="dns-panel-link" href="/manage">DNS Panel</a></nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow"><span className="pixel-dot" /> COMMUNITY SUBDOMAIN REGISTRY</p>
        <h1>Claim your<br /><span>.takeshi.dev</span></h1>
        <p>Đăng ký subdomain miễn phí cho project, portfolio hoặc trang cá nhân của bạn.</p>
        <div className="hero-name-check">
          <div className="hero-check-row">
            <div className={inputClass('subdomain', 'field-combo')}><input id="hero-subdomain" aria-label="Kiểm tra subdomain" placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={() => { void checkAvailability(); }} autoComplete="off" /><b>.takeshi.dev</b></div>
            <a className="button secondary hero-check-button" href="#request" onClick={(event) => { if (availability !== 'available') { event.preventDefault(); if (availability !== 'checking') void checkAvailability(); } }} aria-disabled={availability === 'checking'}>{heroButtonLabel}</a>
          </div>
          <small aria-live="polite" className={heroStatusClass}>{availability === 'checking' ? 'Đang kiểm tra tên...' : availabilityMessage}</small>
        </div>
      </section>

      <section className="content-grid" id="request">
        <form className="panel request-form" noValidate onSubmit={submitClaim}>
          <div className="panel-heading"><span className="block-mark" aria-hidden="true" /><div><p>NEW REQUEST</p><h2>Đăng ký subdomain</h2></div></div>
          <label htmlFor="subdomain">Tên bạn muốn dùng
            <div className={inputClass('subdomain', 'field-combo')}><input id="subdomain" placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={() => { void checkAvailability(); }} autoComplete="off" required /><b>.takeshi.dev</b></div>
            {displayHint('subdomain', '3–63 ký tự: a–z, 0–9, dấu gạch ngang. Rời ô để kiểm tra tên.')}
          </label>
          <label htmlFor="cname-target">CNAME đích
            <input id="cname-target" className={inputClass('cnameTarget')} placeholder="your-project.pages.dev" value={cnameTarget} onChange={(event) => { setCnameTarget(event.target.value); resetFieldFeedback('cnameTarget'); }} onBlur={() => markTouched('cnameTarget')} required />
            {displayHint('cnameTarget', 'Thêm custom domain tại dịch vụ host của bạn trước khi gửi yêu cầu.')}
          </label>
          <div className="form-pair">
            <label htmlFor="telegram-username">Telegram username
              <input id="telegram-username" className={inputClass('telegramUsername')} placeholder="username" value={telegramUsername} onChange={(event) => { setTelegramUsername(event.target.value.replace(/^@/, '').replace(/[^a-z0-9_]/gi, '').slice(0, 32)); resetFieldFeedback('telegramUsername'); }} onBlur={() => markTouched('telegramUsername')} autoComplete="username" required />
              {displayHint('telegramUsername', 'Nhập username, không cần dấu @.')}
            </label>
            <label htmlFor="access-key">Access key
              <div className={inputClass('accessKey', 'field-combo access-key-combo')}><b>tk-</b><input id="access-key" type={showAccessKey ? 'text' : 'password'} placeholder="your-key-part" value={accessKeySuffix} onChange={(event) => { setAccessKeySuffix(event.target.value.replace(/[^a-z0-9._-]/gi, '').slice(0, 29)); resetFieldFeedback('accessKey'); }} onBlur={() => markTouched('accessKey')} autoComplete="new-password" required /><HoldToRevealButton label="access key" onRevealChange={setShowAccessKey} /></div>
              {displayHint('accessKey', 'Phần bạn đặt dài 11–29 ký tự, bắt buộc có cả chữ và số; chỉ dùng thêm . _ - khi cần.')}
            </label>
          </div>
          <label className="check-row" htmlFor="rules"><input id="rules" className={touched.rules && fieldState.rules.kind !== 'idle' ? fieldState.rules.kind : ''} type="checkbox" checked={acceptedRules} onChange={(event) => { setAcceptedRules(event.target.checked); resetFieldFeedback('rules'); }} onBlur={() => markTouched('rules')} required /><span>Tôi đồng ý dùng subdomain đúng mục đích và tuân thủ quy định.</span></label>
          {touched.rules && fieldState.rules.kind !== 'idle' && <small className={fieldState.rules.kind === 'valid' ? 'field-good rules-feedback' : 'field-bad rules-feedback'}>{fieldState.rules.message}</small>}
          <label className="honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
          {submission.type === 'error' && <p className="form-message error" role="alert">{submission.message}</p>}
          {submission.type === 'success' && <p className="form-message success" role="status">Đã nhận yêu cầu cho <strong>{subdomain}.takeshi.dev</strong>. Mã request: {submission.requestId.slice(0, 8)}.</p>}
          <button className="button" type="submit" disabled={submission.type === 'loading' || submission.type === 'success'}>{submission.type === 'loading' ? 'Đang gửi...' : submission.type === 'success' ? 'Đã gửi' : 'Gửi yêu cầu'}</button>
        </form>

        <aside className="side-stack">
          <section className="panel compact-panel" id="how"><p className="eyebrow"><span className="pixel-dot" /> HOW IT WORKS</p><h2>Ba bước là xong</h2><ol className="steps"><li><b>01</b><span>Thêm domain này vào trang cấu hình của host: <code>name.takeshi.dev</code>.</span></li><li><b>02</b><span>Gửi CNAME đích qua form bên cạnh.</span></li><li><b>03</b><span>Chờ duyệt. Khi được duyệt, DNS record sẽ được tạo.</span></li></ol></section>
          <section className="panel compact-panel" id="rules"><p className="eyebrow"><span className="pixel-dot" /> RULES</p><h2>Dùng cho đúng</h2><ul className="rules-list"><li>Mọi yêu cầu được duyệt thủ công; CNAME chính chỉ được tạo sau khi duyệt.</li><li>Sau khi active, dùng DNS Panel và access key để quản lý record dưới subdomain của bạn.</li><li>Giữ access key riêng tư. Phishing, spam, malware, mạo danh hoặc lạm dụng sẽ bị từ chối hoặc gỡ.</li></ul></section>
        </aside>
      </section>

      <footer><span>TAKESHI DOMAINS</span><span>Duyệt thủ công · DNS Panel sau khi được duyệt</span><span>© 2026</span></footer>
    </main>
  );
}
