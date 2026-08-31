'use client';

import { FocusEvent, FormEvent, useEffect, useState } from 'react';

import { HoldToRevealButton } from '@/app/components/HoldToRevealButton';
import { useToast } from '@/app/components/ToastProvider';
import { UserLanguageToggle, useUserLanguage } from '@/app/components/UserLanguageToggle';
import { isValidCnameTarget, isValidOwnerAccessKey, isValidSubdomain, isValidTelegramUsername } from '@/lib/registry';

type SubmissionState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'success'; requestId: string };
type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'error';
type FieldName = 'subdomain' | 'parentDomain' | 'cnameTarget' | 'telegramUsername' | 'accessKey' | 'rules';
type FieldState = { kind: 'idle' | 'valid' | 'invalid'; message: string };
type RegistryDomain = { id: string; hostname: string };

const defaultRegistryDomain: RegistryDomain = { id: 'managed-domain-takeshi-dev', hostname: 'takeshi.dev' };

function DomainSuffixPicker({
  domains,
  value,
  onChange,
  onBlur,
  emptyLabel,
  chooseLabel,
}: {
  domains: RegistryDomain[];
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  emptyLabel: string;
  chooseLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = domains.find((domain) => domain.id === value);

  function closeIfLeaving(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
      onBlur();
    }
  }

  return (
    <div className={`domain-suffix-picker${open ? ' open' : ''}`} onBlur={closeIfLeaving}>
      <button
        className="domain-suffix-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={domains.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={chooseLabel}
      >
        <span>{selected ? `.${selected.hostname}` : emptyLabel}</span><i aria-hidden="true">⌄</i>
      </button>
      {open && <div className="domain-suffix-menu" role="listbox" aria-label={chooseLabel}>
        {domains.map((domain) => <button
          key={domain.id}
          className={domain.id === value ? 'selected' : ''}
          type="button"
          role="option"
          aria-selected={domain.id === value}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { onChange(domain.id); setOpen(false); onBlur(); }}
        >.{domain.hostname}</button>)}
      </div>}
    </div>
  );
}

const emptyTouched: Record<FieldName, boolean> = {
  subdomain: false,
  parentDomain: false,
  cnameTarget: false,
  telegramUsername: false,
  accessKey: false,
  rules: false,
};

function formatRetryAfter(retryAfterSeconds: number | undefined, language: 'vi' | 'en') {
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) return '';

  const totalSeconds = Math.ceil(retryAfterSeconds);
  if (totalSeconds < 60) return language === 'en' ? `${totalSeconds} seconds` : `${totalSeconds} giây`;

  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return language === 'en' ? `${totalMinutes} minutes` : `${totalMinutes} phút`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (language === 'en') return minutes ? `${hours} hours ${minutes} minutes` : `${hours} hours`;
  return minutes ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
}

export default function Home() {
  const { language, setLanguage } = useUserLanguage();
  const { pushToast } = useToast();
  const [subdomain, setSubdomain] = useState('');
  const [registryDomains, setRegistryDomains] = useState<RegistryDomain[]>([defaultRegistryDomain]);
  const [parentDomainId, setParentDomainId] = useState(defaultRegistryDomain.id);
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
  const selectedParentDomain = registryDomains.find((domain) => domain.id === parentDomainId) ?? null;
  const selectedParentDomainName = selectedParentDomain?.hostname ?? '';
  const t = <T,>(vi: T, en: T): T => language === 'en' ? en : vi;

  useEffect(() => {
    if (submission.type === 'error') {
      pushToast({ tone: 'error', text: submission.message });
      return;
    }
    if (submission.type === 'success') {
      const hostname = selectedParentDomainName ? `${subdomain}.${selectedParentDomainName}` : subdomain;
      pushToast({
        tone: 'success',
        text: language === 'en'
          ? `Request received for ${hostname}. Request ID: ${submission.requestId.slice(0, 8)}.`
          : `Đã nhận yêu cầu cho ${hostname}. Mã request: ${submission.requestId.slice(0, 8)}.`,
      });
    }
  }, [language, pushToast, selectedParentDomainName, subdomain, submission]);

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
        ? { kind: 'invalid', message: t('Tên phải dài 3–63 ký tự, chỉ gồm a–z, 0–9 và dấu gạch ngang.', 'Use 3–63 characters: a–z, 0–9, and hyphens only.') }
        : availability === 'available'
          ? { kind: 'valid', message: availabilityMessage || t('✓ Tên có thể dùng.', '✓ This name is available.') }
          : availability === 'taken' || availability === 'error'
            ? { kind: 'invalid', message: availabilityMessage || t('Không thể dùng tên này.', 'This name cannot be used.') }
            : { kind: 'idle', message: availability === 'checking' ? t('Đang kiểm tra tên...', 'Checking name...') : t('Rời ô để kiểm tra tên.', 'Leave the field to check the name.') }),
    parentDomain: withServerError('parentDomain', !selectedParentDomain
      ? { kind: 'invalid', message: t('Hãy chọn một domain đang mở đăng ký.', 'Choose a domain that is open for registration.') }
      : { kind: 'valid', message: `✓ ${t('Đăng ký dưới', 'Register under')} .${selectedParentDomain.hostname}` }),
    cnameTarget: withServerError('cnameTarget', requiredFieldState(
      'cnameTarget',
      Boolean(cnameTarget.trim()),
      isValidCnameTarget(
        cnameTarget.trim().toLowerCase().replace(/\.+$/, ''),
        registryDomains.map((domain) => domain.hostname),
      ),
      t('✓ CNAME hợp lệ.', '✓ Valid CNAME.'),
      !cnameTarget.trim() ? t('Nhập CNAME đích.', 'Enter a CNAME destination.') : t('CNAME cần là hostname hợp lệ, ví dụ your-project.pages.dev.', 'Use a valid hostname, for example your-project.pages.dev.'),
    )),
    telegramUsername: withServerError('telegramUsername', requiredFieldState(
      'telegramUsername',
      Boolean(telegramUsername.trim()),
      isValidTelegramUsername(telegramUsername),
      t('✓ Telegram username hợp lệ.', '✓ Valid Telegram username.'),
      !telegramUsername.trim() ? t('Nhập Telegram username.', 'Enter your Telegram username.') : t('Username Telegram dài 5–32 ký tự, bắt đầu bằng chữ và chỉ dùng chữ, số, _.', 'Use 5–32 characters, beginning with a letter; letters, numbers, and _ only.'),
    )),
    accessKey: withServerError('accessKey', requiredFieldState(
      'accessKey',
      Boolean(accessKeySuffix.trim()),
      isValidOwnerAccessKey(accessKey),
      t('✓ Access key đúng định dạng.', '✓ Valid access key format.'),
      !accessKeySuffix.trim() ? t('Nhập phần access key sau tk-.', 'Enter the access-key part after tk-.') : t('Phần sau tk- phải dài 11–29 ký tự, có cả chữ và số; chỉ dùng thêm . _ - khi cần.', 'The part after tk- must be 11–29 characters, include letters and numbers, and may use . _ -.'),
    )),
    rules: withServerError('rules', requiredFieldState(
      'rules',
      acceptedRules,
      acceptedRules,
      t('✓ Đã đồng ý quy định.', '✓ Rules accepted.'),
      t('Bạn cần đồng ý với quy định để gửi yêu cầu.', 'You must accept the rules before sending a request.'),
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

  useEffect(() => {
    let mounted = true;

    void fetch('/api/registry-domains', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { domains?: RegistryDomain[] };
        if (!response.ok || !Array.isArray(payload.domains) || !mounted) return;

        const domains = payload.domains.filter((domain) => (
          typeof domain.id === 'string' && typeof domain.hostname === 'string'
        ));
        setRegistryDomains(domains);
        setParentDomainId((current) => (
          domains.some((domain) => domain.id === current) ? current : (domains[0]?.id ?? '')
        ));
      })
      .catch(() => {
        if (!mounted) return;
        setRegistryDomains([]);
        setParentDomainId('');
      });

    return () => { mounted = false; };
  }, []);

  function selectParentDomain(value: string) {
    setParentDomainId(value);
    setAvailability('idle');
    setAvailabilityMessage('');
    setTouched((current) => ({ ...current, parentDomain: true, subdomain: false }));
    setRequiredOnSubmit((current) => ({ ...current, parentDomain: false, subdomain: false }));
    setServerErrors((current) => {
      const next = { ...current };
      delete next.parentDomain;
      delete next.subdomain;
      return next;
    });
    setSubmission({ type: 'idle' });
  }

  async function checkAvailability(): Promise<AvailabilityState> {
    markTouched('subdomain');
    if (!subdomain.trim()) {
      setAvailability('idle');
      setAvailabilityMessage('');
      return 'idle';
    }
    if (!selectedParentDomain) {
      markTouched('parentDomain');
      setAvailability('error');
      setAvailabilityMessage(t('Chưa có domain nào đang mở đăng ký.', 'No domains are currently open for registration.'));
      return 'error';
    }
    if (!isValidSubdomain(subdomain)) {
      setAvailability('error');
      setAvailabilityMessage(t('Tên subdomain không hợp lệ hoặc đang được reserved.', 'This subdomain is invalid or reserved.'));
      return 'error';
    }

    const candidate = subdomain;
    const candidateParentDomainId = selectedParentDomain.id;
    setAvailability('checking');
    setAvailabilityMessage('');
    try {
      const response = await fetch(`/api/requests?subdomain=${encodeURIComponent(candidate)}&domainId=${encodeURIComponent(candidateParentDomainId)}`);
      const payload = await response.json() as { available?: boolean; error?: string };
      if (candidate !== subdomain || candidateParentDomainId !== parentDomainId) return 'idle';
      if (!response.ok) {
        setAvailability('error');
        setAvailabilityMessage(language === 'en' ? 'Unable to check this name right now.' : (payload.error ?? 'Không thể kiểm tra tên lúc này.'));
        return 'error';
      }
      const result = payload.available ? 'available' : 'taken';
      setAvailability(result);
      setAvailabilityMessage(payload.available ? t('✓ Tên có thể dùng.', '✓ This name is available.') : t('Tên đã được đăng ký hoặc đang chờ duyệt.', 'This name is already registered or awaiting review.'));
      return result;
    } catch {
      if (candidate === subdomain && candidateParentDomainId === parentDomainId) {
        setAvailability('error');
        setAvailabilityMessage(t('Không thể kết nối registry. Hãy thử lại.', 'Unable to reach the registry. Please try again.'));
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
    setTouched({ subdomain: true, parentDomain: true, cnameTarget: true, telegramUsername: true, accessKey: true, rules: true });
    setRequiredOnSubmit({ subdomain: true, parentDomain: true, cnameTarget: true, telegramUsername: true, accessKey: true, rules: true });
    const localFieldsAreValid = Boolean(selectedParentDomain)
      && isValidSubdomain(subdomain)
      && isValidCnameTarget(
        cnameTarget.trim().toLowerCase().replace(/\.+$/, ''),
        registryDomains.map((domain) => domain.hostname),
      )
      && isValidTelegramUsername(telegramUsername)
      && isValidOwnerAccessKey(accessKey)
      && acceptedRules;
    if (!localFieldsAreValid) {
      setSubmission({ type: 'error', message: t('Hãy sửa các trường được đánh dấu đỏ trước khi gửi.', 'Fix the fields marked in red before sending.') });
      return;
    }

    const currentAvailability = availability === 'available' ? 'available' : await checkAvailability();
    if (currentAvailability !== 'available') {
      setSubmission({ type: 'error', message: t('Hãy chọn một subdomain còn trống trước khi gửi.', 'Choose an available subdomain before sending.') });
      return;
    }

    setSubmission({ type: 'loading' });
    try {
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain, parentDomainId, cnameTarget, telegramUsername, accessKey, acceptedRules, website }),
      });
      const payload = await response.json() as { error?: string; field?: FieldName | 'parentDomainId'; requestId?: string; retryAfterSeconds?: number };
      if (!response.ok || !payload.requestId) {
        if (payload.field) {
          const field = payload.field === 'parentDomainId' ? 'parentDomain' : payload.field;
          setServerErrors((current) => ({ ...current, [field]: language === 'en' ? 'This value is invalid.' : (payload.error ?? 'Giá trị không hợp lệ.') }));
          markTouched(field);
        }
        const headerRetryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
        const retryAfter = formatRetryAfter(
          typeof payload.retryAfterSeconds === 'number'
            ? payload.retryAfterSeconds
            : Number.isFinite(headerRetryAfter) ? headerRetryAfter : undefined,
          language,
        );
        const errorMessage = language === 'en' ? 'Unable to send the request. Please try again.' : (payload.error ?? 'Không thể gửi yêu cầu. Hãy thử lại.');
        setSubmission({ type: 'error', message: retryAfter ? language === 'en' ? `${errorMessage} Try again in about ${retryAfter}.` : `${errorMessage} Thời gian chờ còn lại: khoảng ${retryAfter}.` : errorMessage });
        return;
      }
      setSubmission({ type: 'success', requestId: payload.requestId });
      setAvailability('idle');
      setAvailabilityMessage('');
    } catch {
      setSubmission({ type: 'error', message: t('Không thể kết nối registry. Hãy thử lại.', 'Unable to reach the registry. Please try again.') });
    }
  }

  const heroButtonLabel = availability === 'available' ? t('Đăng ký subdomain', 'Register subdomain') : availability === 'checking' ? t('Đang kiểm tra...', 'Checking...') : t('Kiểm tra subdomain', 'Check subdomain');
  const heroStatusClass = availability === 'available' ? 'field-good' : availability === 'taken' || availability === 'error' ? 'field-bad' : undefined;

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Takeshi Domains home">
          <span className="brand-block" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>TAKESHI <span className="brand-dim">DOMAINS</span></span>
        </a>
        <nav className="site-nav" aria-label={t('Điều hướng chính', 'Main navigation')}><a href="#request">{t('Đăng ký', 'Register')}</a><a href="#how">{t('Cách hoạt động', 'How it works')}</a><a href="#rules">{t('Quy định', 'Rules')}</a><a className="dns-panel-link" href="/manage">DNS Panel</a><UserLanguageToggle language={language} onChange={setLanguage} /></nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow"><span className="pixel-dot" /> COMMUNITY SUBDOMAIN REGISTRY</p>
        <h1>Claim your<br /><span>.takeshi.dev</span></h1>
        <p>{t('Đăng ký subdomain miễn phí cho project, portfolio hoặc trang cá nhân của bạn.', 'Claim a free subdomain for your project, portfolio, or personal site.')}</p>
        <div className="hero-name-check">
          <div className="hero-check-row">
            <div className={inputClass('subdomain', 'field-combo')}><input id="hero-subdomain" aria-label={t('Kiểm tra subdomain', 'Check subdomain')} placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={() => { void checkAvailability(); }} autoComplete="off" /><DomainSuffixPicker domains={registryDomains} value={parentDomainId} onChange={selectParentDomain} onBlur={() => markTouched('parentDomain')} emptyLabel={t('Không có domain', 'No domains')} chooseLabel={t('Chọn domain', 'Choose domain')} /></div>
            <a className="button secondary hero-check-button" href="#request" onClick={(event) => { if (availability !== 'available') { event.preventDefault(); if (availability !== 'checking') void checkAvailability(); } }} aria-disabled={availability === 'checking'}>{heroButtonLabel}</a>
          </div>
          <small aria-live="polite" className={heroStatusClass}>{availability === 'checking' ? t('Đang kiểm tra tên...', 'Checking name...') : availabilityMessage}</small>
        </div>
      </section>

      <section className="content-grid" id="request">
        <form className="panel request-form" noValidate onSubmit={submitClaim}>
          <div className="panel-heading"><span className="block-mark" aria-hidden="true" /><div><p>NEW REQUEST</p><h2>{t('Đăng ký subdomain', 'Register a subdomain')}</h2></div></div>
          <label htmlFor="subdomain">{t('Tên bạn muốn dùng', 'Your chosen name')}
            <div className={inputClass('subdomain', 'field-combo')}><input id="subdomain" placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={() => { void checkAvailability(); }} autoComplete="off" required /><DomainSuffixPicker domains={registryDomains} value={parentDomainId} onChange={selectParentDomain} onBlur={() => markTouched('parentDomain')} emptyLabel={t('Không có domain', 'No domains')} chooseLabel={t('Chọn domain', 'Choose domain')} /></div>
            {displayHint('subdomain', t('3–63 ký tự: a–z, 0–9, dấu gạch ngang. Rời ô để kiểm tra tên.', '3–63 characters: a–z, 0–9, hyphens. Leave the field to check the name.'))}
          </label>
          <label htmlFor="cname-target">{t('CNAME đích', 'CNAME destination')}
            <input id="cname-target" className={inputClass('cnameTarget')} placeholder="your-project.pages.dev" value={cnameTarget} onChange={(event) => { setCnameTarget(event.target.value); resetFieldFeedback('cnameTarget'); }} onBlur={() => markTouched('cnameTarget')} required />
            {displayHint('cnameTarget', t('Thêm custom domain tại dịch vụ host của bạn trước khi gửi yêu cầu.', 'Add this custom domain at your hosting provider before sending the request.'))}
          </label>
          <div className="form-pair">
            <label htmlFor="telegram-username">Telegram username
              <input id="telegram-username" className={inputClass('telegramUsername')} placeholder="username" value={telegramUsername} onChange={(event) => { setTelegramUsername(event.target.value.replace(/^@/, '').replace(/[^a-z0-9_]/gi, '').slice(0, 32)); resetFieldFeedback('telegramUsername'); }} onBlur={() => markTouched('telegramUsername')} autoComplete="username" required />
              {displayHint('telegramUsername', t('Nhập username, không cần dấu @.', 'Enter your username without @.'))}
            </label>
            <label htmlFor="access-key">Access key
              <div className={inputClass('accessKey', 'field-combo access-key-combo')}><b>tk-</b><input id="access-key" type={showAccessKey ? 'text' : 'password'} placeholder="your-key-part" value={accessKeySuffix} onChange={(event) => { setAccessKeySuffix(event.target.value.replace(/[^a-z0-9._-]/gi, '').slice(0, 29)); resetFieldFeedback('accessKey'); }} onBlur={() => markTouched('accessKey')} autoComplete="new-password" required /><HoldToRevealButton label="access key" onRevealChange={setShowAccessKey} /></div>
              {displayHint('accessKey', t('Phần bạn đặt dài 11–29 ký tự, bắt buộc có cả chữ và số; chỉ dùng thêm . _ - khi cần.', 'Use 11–29 characters with letters and numbers; . _ - are optional.'))}
            </label>
          </div>
          <label className="check-row" htmlFor="rules"><input id="rules" className={touched.rules && fieldState.rules.kind !== 'idle' ? fieldState.rules.kind : ''} type="checkbox" checked={acceptedRules} onChange={(event) => { setAcceptedRules(event.target.checked); resetFieldFeedback('rules'); }} onBlur={() => markTouched('rules')} required /><span>{t('Tôi đồng ý dùng subdomain đúng mục đích và tuân thủ quy định.', 'I agree to use this subdomain appropriately and follow the rules.')}</span></label>
          {touched.rules && fieldState.rules.kind !== 'idle' && <small className={fieldState.rules.kind === 'valid' ? 'field-good rules-feedback' : 'field-bad rules-feedback'}>{fieldState.rules.message}</small>}
          <label className="honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
          <button className="button" type="submit" disabled={submission.type === 'loading' || submission.type === 'success'}>{submission.type === 'loading' ? t('Đang gửi...', 'Sending...') : submission.type === 'success' ? t('Đã gửi', 'Sent') : t('Gửi yêu cầu', 'Send request')}</button>
        </form>

        <aside className="side-stack">
          <section className="panel compact-panel" id="how"><p className="eyebrow"><span className="pixel-dot" /> HOW IT WORKS</p><h2>{t('Ba bước là xong', 'Three simple steps')}</h2><ol className="steps"><li><b>01</b><span>{t(<>Thêm domain này vào trang cấu hình của host: <code>name.takeshi.dev</code>.</>, <>Add this domain in your hosting provider: <code>name.takeshi.dev</code>.</>)}</span></li><li><b>02</b><span>{t('Gửi CNAME đích qua form bên cạnh.', 'Submit the destination CNAME in the form.')}</span></li><li><b>03</b><span>{t('Chờ duyệt. Khi được duyệt, DNS record sẽ được tạo.', 'Wait for review. Once approved, the DNS record is created.')}</span></li></ol></section>
          <section className="panel compact-panel" id="rules"><p className="eyebrow"><span className="pixel-dot" /> RULES</p><h2>{t('Dùng cho đúng', 'Use it responsibly')}</h2><ul className="rules-list"><li>{t('Mọi yêu cầu được duyệt thủ công; CNAME chính chỉ được tạo sau khi duyệt.', 'Every request is reviewed manually; the primary CNAME is created only after approval.')}</li><li>{t('Sau khi active, dùng DNS Panel và access key để quản lý record dưới subdomain của bạn.', 'After activation, use DNS Panel and your access key to manage records below your subdomain.')}</li><li>{t('Giữ access key riêng tư. Phishing, spam, malware, mạo danh hoặc lạm dụng sẽ bị từ chối hoặc gỡ.', 'Keep your access key private. Phishing, spam, malware, impersonation, or abuse will be rejected or removed.')}</li></ul></section>
        </aside>
      </section>

      <footer><span>TAKESHI DOMAINS</span><span>{t('Duyệt thủ công · DNS Panel sau khi được duyệt', 'Manual review · DNS Panel after approval')}</span><span>© 2026</span></footer>
    </main>
  );
}
