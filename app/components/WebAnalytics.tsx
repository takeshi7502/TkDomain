'use client';

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    // Track paths, not query strings/fragments that could contain private data.
    const url = new URL(event.url);
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}

export function WebAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
