import { describe, expect, it } from 'vitest';
import { getChecksMessages } from '@/i18n/checks-messages';
import { checksApi } from './api-client';

describe('the exact report download', () => {
  it('points at the canonical artifact route, not a re-serialized copy', () => {
    expect(checksApi.reportArtifactUrl('chk-1')).toBe('/api/v1/checks/chk-1/report/artifact');
  });

  it('encodes the id so it cannot change the path', () => {
    expect(checksApi.reportArtifactUrl('a/../b')).toBe('/api/v1/checks/a%2F..%2Fb/report/artifact');
  });

  it('is labelled in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const messages = getChecksMessages(locale);
      expect(messages.downloadReportArtifact.length).toBeGreaterThan(0);
      expect(messages.downloadReportArtifactHint.length).toBeGreaterThan(0);
    }
  });
});
