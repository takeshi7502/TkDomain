import type { Metadata } from 'next';
import { Geist_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const display = Space_Grotesk({ variable: '--font-display', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Takeshi Domains',
  description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
  metadataBase: new URL('https://domain.takeshi.dev'),
  openGraph: {
    type: 'website',
    url: 'https://domain.takeshi.dev',
    siteName: 'Takeshi Domains',
    title: 'Takeshi Domains',
    description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
  },
  twitter: {
    card: 'summary',
    title: 'Takeshi Domains',
    description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body className={`${display.variable} ${mono.variable}`}>{children}</body></html>;
}
