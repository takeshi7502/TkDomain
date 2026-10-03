import { describe, expect, it } from 'vitest';
import { HttpError, readJson, trustedMutation, validId } from '@/lib/http';
import { validateDnsRecord } from '@/lib/dns';

function json(value: unknown) { return new Request('https://domain.takeshi.dev/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }
describe('API input safety', () => {
  it('requires an object and JSON content type', async () => {
    for (const v of [null, [], 12, 'x']) await expect(readJson(json(v))).rejects.toBeInstanceOf(HttpError);
    await expect(readJson(new Request('https://example.com', { method: 'POST', body: '{}' }))).rejects.toMatchObject({ status: 415 });
    expect(await readJson(json({ ok: true }))).toEqual({ ok: true });
  });
  it('caps bytes even without a Content-Length header', async () => {
    await expect(readJson(json({ text: 'x'.repeat(17000) }))).rejects.toMatchObject({ status: 413 });
  });
  it('blocks sibling-site and cross-site cookie mutations', () => {
    const request = (origin: string) => new Request('https://domain.takeshi.dev/api/test', { headers: { origin } });
    expect(trustedMutation(request('https://domain.takeshi.dev'))).toBe(true);
    expect(trustedMutation(request('https://evil.takeshi.dev'))).toBe(false);
    expect(trustedMutation(new Request('https://domain.takeshi.dev/api/test', { headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false);
  });
  it('rejects malformed DNS input without throwing a TypeError', () => {
    for (const v of [null, [], {}, { recordType: 1 }, { recordType: 'A', recordName: 10, content: {} }]) expect(validateDnsRecord(v)).toHaveProperty('error');
    expect(validId({})).toBe(false);
    expect(validateDnsRecord({ recordType: 'A', recordName: '@', content: '203.0.113.10', ttl: 1, proxied: false })).toHaveProperty('value');
    expect(validateDnsRecord({ recordType: 'CAA', recordName: '@', content: '256 issue example.com', ttl: 1 })).toHaveProperty('error');
  });
});
