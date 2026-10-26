import { describe, expect, it } from 'vitest';
import {
  MAX_FILENAME_LENGTH,
  contentDispositionAttachment,
  encodeRFC8187,
  extensionOf,
  sanitizeOriginalFilename,
} from './filename.js';

describe('sanitizeOriginalFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeOriginalFilename('My Thesis v3.docx')).toBe('My Thesis v3.docx');
  });

  it('keeps Arabic', () => {
    expect(sanitizeOriginalFilename('رسالة الماجستير.pdf')).toBe('رسالة الماجستير.pdf');
  });

  it('normalizes to NFC so equal-looking names are equal', () => {
    expect(sanitizeOriginalFilename('e\u0301tude.pdf')).toBe('\u00e9tude.pdf');
  });

  it('turns path separators into plain characters', () => {
    expect(sanitizeOriginalFilename('../../etc/passwd.pdf')).toBe('_.._etc_passwd.pdf');
    expect(sanitizeOriginalFilename('../../etc/passwd .pdf')).toBe('_.._etc_passwd.pdf');
    expect(sanitizeOriginalFilename('C:\\Users\\x\\thesis.docx')).toBe('C__Users_x_thesis.docx');
  });

  it('strips control characters and NUL', () => {
    expect(sanitizeOriginalFilename('thesis\u0000.pdf\r\n')).toBe('thesis.pdf');
    expect(sanitizeOriginalFilename('a\u001bb.pdf')).toBe('ab.pdf');
  });

  it('strips bidi overrides that disguise an extension', () => {
    // "thesis[RLO]fdp.exe" renders as "thesisexe.pdf" in a naive UI.
    expect(sanitizeOriginalFilename('thesis\u202efdp.exe')).toBe('thesisfdp.exe');
  });

  it('removes leading dots and trailing dots or spaces', () => {
    expect(sanitizeOriginalFilename('...hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeOriginalFilename('thesis.pdf. ')).toBe('thesis.pdf');
  });

  it('never returns an empty name', () => {
    expect(sanitizeOriginalFilename('')).toBe('document');
    expect(sanitizeOriginalFilename('\u0000\u0001')).toBe('document');
    expect(sanitizeOriginalFilename('...')).toBe('document');
  });

  it('bounds the length while keeping the extension', () => {
    const long = `${'x'.repeat(400)}.docx`;
    const result = sanitizeOriginalFilename(long);
    expect(Array.from(result).length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(result.endsWith('.docx')).toBe(true);
  });

  it('is idempotent', () => {
    for (const name of ['a/b\\c.pdf', '  spaced   name.docx ', 'x\u0000y.pdf']) {
      const once = sanitizeOriginalFilename(name);
      expect(sanitizeOriginalFilename(once)).toBe(once);
    }
  });
});

describe('extensionOf', () => {
  it('lower-cases and includes the dot', () => {
    expect(extensionOf('Thesis.PDF')).toBe('.pdf');
    expect(extensionOf('a.b.DOCX')).toBe('.docx');
  });

  it('is empty for no extension, a trailing dot, or a dotfile', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('thesis.')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
  });
});

describe('contentDispositionAttachment', () => {
  it('produces an ASCII fallback and a UTF-8 form', () => {
    expect(contentDispositionAttachment('thesis.pdf')).toBe(
      'attachment; filename="thesis.pdf"; filename*=UTF-8\'\'thesis.pdf',
    );
  });

  it('carries Arabic through the RFC 8187 form only', () => {
    const header = contentDispositionAttachment('رسالة.pdf');
    expect(header).toMatch(/^attachment; filename="_+\.pdf"; filename\*=UTF-8''%D8%B1/);
    expect(header).not.toMatch(/[^\x20-\x7e]/);
  });

  it('cannot inject a header or break out of the quoted string', () => {
    const header = contentDispositionAttachment('a"\r\nX-Injected: 1.pdf');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.match(/"/g)?.length).toBe(2);
  });

  it('percent-encodes everything outside attr-char', () => {
    expect(encodeRFC8187('a b;c.pdf')).toBe('a%20b%3Bc.pdf');
    expect(encodeRFC8187('safe!#$&+-.^_`|~')).toBe('safe!#$&+-.^_`|~');
  });
});
