'use client';

import { FormEvent, useState } from 'react';

const previewBlocks = [
  ['#1e2a20', '#4c7040'], ['#263225', '#627e43'], ['#182119', '#34502e'],
  ['#27301f', '#8a9b50'], ['#1b251d', '#4b663a'], ['#2c251c', '#8d6844'],
];

const features = [
  { title: 'Bring your own host', text: 'Trỏ website từ Cloudflare Pages, Vercel, GitHub Pages hoặc bất kỳ host nào hỗ trợ CNAME.', tag: 'CNAME ONLY' },
  { title: 'Review before publish', text: 'Mỗi request đều được kiểm tra trước khi record DNS xuất hiện trên Internet.', tag: 'HUMAN CHECK' },
  { title: 'HTTPS by default', text: '.dev yêu cầu HTTPS. Hãy thêm custom domain ở host của bạn trước khi request được duyệt.', tag: 'SECURE' },
];

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
  const [jumped, setJumped] = useState(false);

  function cleanSubdomain(value: string) {
    setSubdomain(value.replace(/[^a-z0-9-]/g, '').slice(0, 63));
    setAvailability('idle');
    setSubmission({ type: 'idle' });
  }

  function previewClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJumped(true);
    document.getElementById('claim')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        setSubmission({ type: 'error', message: payload.error ?? 'Không thể gửi request. Hãy thử lại.' });
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
      <div className="ambient-grid" aria-hidden="true" />
      <div className="sky-glow" aria-hidden="true" />
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Takeshi Domains home"><span className="brand-block" aria-hidden="true"><i /><i /><i /><i /></span><span>TAKESHI<span className="brand-dim">.DOMAINS</span></span></a>
        <nav aria-label="Main navigation"><a href="#how">HOW IT WORKS</a><a href="#rules">RULES</a></nav>
        <span className="status-chip"><b /> DNS ONLINE</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="pixel-dot" /> COMMUNITY SUBDOMAIN REGISTRY <span className="eyebrow-line" /></div>
        <p className="hero-kicker">Claim a corner of the overworld.</p>
        <h1>BUILD ON<br /><em>TAKESHI.DEV</em></h1>
        <p className="hero-copy">Đăng ký một subdomain miễn phí, trỏ nó đến website của bạn và mang thế giới của bạn lên Internet.</p>
        <form className="hero-search" onSubmit={previewClaim}>
          <label className="sr-only" htmlFor="quick-subdomain">Tên subdomain mong muốn</label>
          <span className="search-prompt">/</span>
          <input id="quick-subdomain" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} placeholder="your-name" autoComplete="off" />
          <span className="search-suffix">.takeshi.dev</span>
          <button type="submit">CHECK NAME <span>→</span></button>
        </form>
        {jumped && subdomain && <p className="search-note"><span>✓</span> Đã mang <strong>{subdomain}.takeshi.dev</strong> xuống form đăng ký.</p>}
        <div className="hero-stats" aria-label="Registry details"><span><b>CNAME</b> records only</span><span><b>HTTPS</b> required</span><span><b>REVIEW</b> to publish</span></div>
      </section>

      <section className="terrain" aria-label="Decorative block terrain"><div className="terrain-grass" /><div className="terrain-dirt" /><div className="terrain-stone" /><div className="terrain-spark spark-one" /><div className="terrain-spark spark-two" /><div className="terrain-spark spark-three" /></section>

      <section className="claim-section" id="claim">
        <div className="section-heading"><span className="section-index">01</span><div><p>REGISTRATION TERMINAL</p><h2>CLAIM YOUR<br /><span>SUBDOMAIN</span></h2></div><span className="section-corner" aria-hidden="true" /></div>
        <div className="claim-grid">
          <form className="claim-card" onSubmit={submitClaim}>
            <div className="terminal-bar"><span><i /> NEW REQUEST</span><span className="terminal-id">{submission.type === 'success' ? `REQ_${submission.requestId.slice(0, 6).toUpperCase()}` : 'REQ_NEW'}</span></div>
            <div className="form-content">
              <label htmlFor="subdomain"><span>DESIRED SUBDOMAIN</span><div className="field-combo"><input id="subdomain" placeholder="your-name" value={subdomain} onChange={(event) => cleanSubdomain(event.target.value)} onBlur={checkAvailability} required /><b>.takeshi.dev</b></div><small>3–63 ký tự: a–z, 0–9, dấu gạch ngang. {availability === 'checking' && 'Checking...'}{availability === 'available' && <span className="field-good">✓ Available</span>}{availability === 'taken' && <span className="field-bad">× Already claimed or pending</span>}</small></label>
              <label htmlFor="cname-target"><span>CNAME DESTINATION</span><input id="cname-target" className="field" placeholder="your-project.pages.dev" value={cnameTarget} onChange={(event) => setCnameTarget(event.target.value)} required /><small>Thêm domain này vào hosting provider của bạn trước.</small></label>
              <div className="form-pair"><label htmlFor="github-handle"><span>GITHUB HANDLE</span><input id="github-handle" className="field" placeholder="@username" value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} /></label><label htmlFor="email"><span>EMAIL</span><input id="email" className="field" type="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></label></div>
              <label className="check-row" htmlFor="rules"><input id="rules" type="checkbox" checked={acceptedRules} onChange={(event) => setAcceptedRules(event.target.checked)} required /><span>I will use this domain responsibly and accept the registry rules.</span></label>
              <label className="honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
              {submission.type === 'error' && <p className="form-message error" role="alert">{submission.message}</p>}
              {submission.type === 'success' && <p className="form-message success" role="status">Request received. We will review <strong>{subdomain}.takeshi.dev</strong> before creating DNS.</p>}
              <button className="claim-button" type="submit" disabled={submission.type === 'loading' || submission.type === 'success'}>{submission.type === 'loading' ? 'SENDING REQUEST...' : submission.type === 'success' ? 'REQUEST RECEIVED' : <>SUBMIT REQUEST <span>↗</span></>}</button>
            </div>
          </form>
          <aside className="claim-aside"><div className="aside-label">WHAT HAPPENS NEXT?</div><ol><li><b>01</b><span><strong>Configure your host</strong>Thêm custom domain ở Pages, Vercel, Netlify hoặc host của bạn.</span></li><li><b>02</b><span><strong>Send the request</strong>Chúng mình kiểm tra tên, CNAME và thông tin owner.</span></li><li><b>03</b><span><strong>DNS goes live</strong>Khi được duyệt, record được publish và bạn nhận email.</span></li></ol><div className="aside-callout"><span>!</span><p>Không hỗ trợ A, AAAA, MX, TXT hoặc wildcard record trong giai đoạn đầu.</p></div></aside>
        </div>
      </section>

      <section className="feature-section" id="how"><div className="section-heading compact"><span className="section-index">02</span><div><p>SMALL, FAIR, SIMPLE</p><h2>HOW IT <span>WORKS</span></h2></div></div><div className="feature-grid">{features.map((feature, index) => <article className="feature-card" key={feature.title}><div className="mini-terrain" aria-hidden="true">{previewBlocks.slice(index * 2, index * 2 + 2).map(([soil, grass], block) => <span key={block} style={{ '--soil': soil, '--grass': grass } as React.CSSProperties} />)}</div><p className="feature-tag">{feature.tag}</p><h3>{feature.title}</h3><p>{feature.text}</p></article>)}</div></section>
      <section className="rules-section" id="rules"><div><p className="eyebrow"><span className="pixel-dot" /> THE IMPORTANT BITS</p><h2>KEEP THE REALM<br /><span>FRIENDLY.</span></h2></div><div className="rules-list"><p><b>NO. 01</b> One person, one primary subdomain.</p><p><b>NO. 02</b> No phishing, malware, spam or deceptive content.</p><p><b>NO. 03</b> Inactive or abusive records can be removed.</p><a href="#claim">READ FULL RULES <span>→</span></a></div></section>
      <footer><a className="brand" href="#top"><span className="brand-block" aria-hidden="true"><i /><i /><i /><i /></span><span>TAKESHI<span className="brand-dim">.DOMAINS</span></span></a><p>Made for people who build things on the internet.</p><span>TAKESHI.DEV © 2026</span></footer>
    </main>
  );
}
