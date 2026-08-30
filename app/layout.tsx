import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const display = Space_Grotesk({ variable: '--font-display', subsets: ['latin'] });
const mono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export async function generateMetadata(): Promise<Metadata> {
  const userAgent = (await headers()).get('user-agent') ?? '';
  const isTelegramCrawler = /TelegramBot/i.test(userAgent);

  return {
    title: 'Takeshi Domains',
    description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
    metadataBase: new URL('https://domain.takeshi.dev'),
    openGraph: {
      type: 'website',
      url: 'https://domain.takeshi.dev',
      siteName: 'Takeshi Domains',
      title: 'Takeshi Domains',
      description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
      ...(isTelegramCrawler ? {
        images: [{
          url: 'https://domain.takeshi.dev/telegram-card',
          width: 320,
          height: 320,
          alt: 'Takeshi Domains',
          type: 'image/png',
        }],
      } : {}),
    },
    twitter: {
      card: 'summary',
      title: 'Takeshi Domains',
      description: 'Đăng ký và quản lý subdomain .takeshi.dev.',
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body className={`${display.variable} ${mono.variable}`}>{children}</body></html>;
}
