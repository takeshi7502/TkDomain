import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0d120d',
        padding: 26,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          border: '5px solid #46543a',
          background: '#161d14',
          boxShadow: 'inset 0 0 0 5px #293323',
        }}
      >
        <div style={{ display: 'flex', color: '#edf5cf', fontFamily: 'monospace', fontSize: 122, fontWeight: 900, letterSpacing: -18, lineHeight: 1 }}>
          T<span style={{ color: '#b9df68' }}>K</span>
        </div>
        <div style={{ display: 'flex', marginTop: 22, color: '#b9df68', fontFamily: 'monospace', fontSize: 18, fontWeight: 800, letterSpacing: 3 }}>
          TAKESHI DOMAINS
        </div>
      </div>
    </div>,
    {
      width: 320,
      height: 320,
      headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
    },
  );
}
