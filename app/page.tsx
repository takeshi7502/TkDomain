'use client';

import { FormEvent, useState } from 'react';

type SubmissionState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'success'; requestId: string };

export default function Home() {
  const [subdomain, setSubdomain] = useState('');
  const [cnameTarget, setCnameTarget] = useState('');
  const [githubHandle, setGithubHandle] = useState('');
  const [email, setEmail] = useState('');
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [website, setWebsite] = useState('');
  const [submission, setSubmission] = useState<SubmissionState>({ type: 'idle' });
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');

  function cleanSubdomain(value: string) {
    setSubdomain(value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63));
    setAvailability('idle');
    setSubmission({ type: 'idle' });
  }

  async function checkAvailability() {
    if (subdomain.length < 3) return;
    setAvailability('checking');
    try {
      const response = await fetch(`/api/requests?subdomain=${encodeURIComponent(subdomain)}`);
      const payload = await response.json() as { available?: boolean };
      setAvailability(payload.available ? 'available' : 'taken');
    } catch {
      setAvailability('idle');
    }
  }

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmission({ type: 'loading' });
    try {
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain, cnameTarget, githubHandle, email, acceptedRules, website }),
      });
      const payload = await response.json() as { error?: string; requestId?: string };
      if (!response.ok || !payload.requestId) {
        setSubmission({ type: 'error', message: payload.error ?? 'Không thể gửi yêu cầu. Hãy thử lại.' });
        return;
      }
      setSubmission({ type: 'success', requestId: payload.requestId });
      setAvailability('taken');
    } catch {
      setSubmission({ type: 'error', message: 'Không thể kết nối registry. Hãy thử lại.' });
    }
  }

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Takeshi Domains home">
          <span className="brand-block" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>TAKESHI <span className="brand-dim">DOMAINS</span></span>
        </a>
        <nav aria-label="Main navigation"><a href="#how">Cách hoạt động</a><a href="#rules">Quy định</a><a href="/manage">Quản lý DNS</a><a href="/admin">Admin</a></nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow"><span className="pixel-dot" /> COMMUNITY SUBDOMAIN REGISTRY</p>
        <h1>Claim your<br /><span>.takeshi.dev</span></h1>
        <p>Đăng ký subdomain miễn phí cho project, portfolio hoặc trang cá nhân của bạn.</p>
        <a className="button secondary" href="#claim">Đăng ký subdomain</a>
      </section>

      <section className="content-grid" id="claim">
        <form className="panel request-form" onSubmit={submitClaim}>
          <div className="panel-heading"><span className="block-mark" aria-hidden="true" /><div><p>NEW REQUEST</p><h2>Đăng ký subdomain</h2></div></div>
          <label htmlFor="subdomain">Tên bạn muốn dùng
            <div className="field-combo"><input id="subdomain" placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={checkAvailability} autoComplete="off" required /><b>.takeshi.dev</b></div>
            <small>3–63 ký tự: a–z, 0–9, dấu gạch ngang. {availability === 'checking' && 'Đang kiểm tra...'}{availability === 'available' && <span className="field-good">✓ Tên có thể dùng</span>}{availability === 'taken' && <span className="field-bad">× Tên đã được đăng ký hoặc đang chờ duyệt</span>}</small>
          </label>
          <label htmlFor="cname-target">CNAME đích
            <input id="cname-target" className="field" placeholder="your-project.pages.dev" value={cnameTarget} onChange={(event) => setCnameTarget(event.target.value)} required />
            <small>Thêm custom domain tại dịch vụ host của bạn trước khi gửi yêu cầu.</small>
          </label>
          <div className="form-pair">
            <label htmlFor="github-handle">GitHub (không bắt buộc)<input id="github-handle" className="field" placeholder="username" value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} /></label>
            <label htmlFor="email">Email liên hệ<input id="email" className="field" type="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          </div>
          <label className="check-row" htmlFor="rules"><input id="rules" type="checkbox" checked={acceptedRules} onChange={(event) => setAcceptedRules(event.target.checked)} required /><span>Tôi đồng ý dùng subdomain đúng mục đích và tuân thủ quy định.</span></label>
          <label className="honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
          {submission.type === 'error' && <p className="form-message error" role="alert">{submission.message}</p>}
          {submission.type === 'success' && <p className="form-message success" role="status">Đã nhận yêu cầu cho <strong>{subdomain}.takeshi.dev</strong>. Mã request: {submission.requestId.slice(0, 8)}.</p>}
          <button className="button" type="submit" disabled={submission.type === 'loading' || submission.type === 'success'}>{submission.type === 'loading' ? 'Đang gửi...' : submission.type === 'success' ? 'Đã gửi' : 'Gửi yêu cầu'}</button>
        </form>

        <aside className="side-stack">
          <section className="panel compact-panel" id="how"><p className="eyebrow"><span className="pixel-dot" /> HOW IT WORKS</p><h2>Ba bước là xong</h2><ol className="steps"><li><b>01</b><span>Thêm domain này vào trang cấu hình của host: <code>name.takeshi.dev</code>.</span></li><li><b>02</b><span>Gửi CNAME đích qua form bên cạnh.</span></li><li><b>03</b><span>Chờ duyệt. Khi được duyệt, DNS record sẽ được tạo.</span></li></ol></section>
          <section className="panel compact-panel" id="rules"><p className="eyebrow"><span className="pixel-dot" /> RULES</p><h2>Giữ nó tử tế</h2><ul className="rules-list"><li>Chỉ hỗ trợ CNAME ở giai đoạn đầu.</li><li>Không phishing, spam, malware hoặc mạo danh.</li><li>Record vi phạm hoặc bỏ hoang có thể bị gỡ.</li></ul></section>
        </aside>
      </section>

      <footer><span>TAKESHI DOMAINS</span><span>CNAME only · Review before publish</span><span>© 2026</span></footer>
    </main>
  );
}
