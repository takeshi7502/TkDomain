import type { Metadata } from 'next';
import { Geist_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const display = Space_Grotesk({ variable: '--font-display', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Takeshi Domains — Claim your .takeshi.dev',
  description: 'A community registry for personal .takeshi.dev subdomains.',
  metadataBase: new URL('https://domain.takeshi.dev'),
  openGraph: {
    title: 'Takeshi Domains — Claim your .takeshi.dev',
    description: 'A community registry for personal .takeshi.dev subdomains.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Takeshi Domains — Claim your .takeshi.dev',
    description: 'A community registry for personal .takeshi.dev subdomains.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body className={`${display.variable} ${mono.variable}`}>{children}</body></html>;
}
