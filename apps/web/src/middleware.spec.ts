import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function requestFor(path: string, acceptLanguage?: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${path}`), {
    headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  });
}

describe('locale middleware', () => {
  it('redirects the root path to the negotiated locale', () => {
    const response = middleware(requestFor('/', 'ar-PS,ar;q=0.9'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/ar');
  });

  it('falls back to English when the language is unsupported', () => {
    const response = middleware(requestFor('/', 'fr-FR'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/en');
  });

  it('preserves the rest of the path when redirecting', () => {
    const response = middleware(requestFor('/standards', 'ar'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/ar/standards');
  });

  it('passes through paths that already carry a locale', () => {
    const response = middleware(requestFor('/ar/standards'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('does not treat a similarly-prefixed path as a locale', () => {
    const response = middleware(requestFor('/enterprise', 'en'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/en/enterprise');
  });
});
