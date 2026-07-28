// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  contentDispositionAttachment,
  extensionOf,
  isActiveContent,
  MAX_FILENAME_LENGTH,
  normalizeFilename,
  safeContentType,
} from './filenames.js';

const normalized = (input: string): string => {
  const result = normalizeFilename(input);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.normalized;
};

describe('normalizeFilename', () => {
  it('keeps ordinary names unchanged', () => {
    expect(normalized('quarterly report.pdf')).toBe('quarterly report.pdf');
    expect(normalized('archive-2026_v2.tar.gz')).toBe('archive-2026_v2.tar.gz');
  });

  it('strips POSIX and Windows path components', () => {
    expect(normalized('../../etc/passwd')).toBe('passwd');
    expect(normalized('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(normalized('a/b\\c/d.txt')).toBe('d.txt');
    expect(normalized('/absolute/path/file.bin')).toBe('file.bin');
  });

  it('rejects control characters', () => {
    expect(normalizeFilename('report\u0000.pdf')).toEqual({
      ok: false,
      reason: 'CONTROL_CHARACTERS',
    });
    expect(normalizeFilename('a\nb.txt')).toEqual({ ok: false, reason: 'CONTROL_CHARACTERS' });
  });

  it('removes bidirectional overrides used for extension spoofing', () => {
    expect(normalized('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
  });

  it('rejects pure-dot names and strips leading dots', () => {
    expect(normalizeFilename('..')).toEqual({ ok: false, reason: 'PATH_COMPONENT' });
    expect(normalizeFilename('.')).toEqual({ ok: false, reason: 'PATH_COMPONENT' });
    expect(normalized('.env')).toBe('env');
  });

  it('rejects empty and whitespace-only names', () => {
    expect(normalizeFilename('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizeFilename('   ')).toEqual({ ok: false, reason: 'NO_USABLE_CHARACTERS' });
  });

  it('rejects reserved device names', () => {
    expect(normalizeFilename('CON')).toEqual({ ok: false, reason: 'RESERVED' });
    expect(normalizeFilename('nul.txt')).toEqual({ ok: false, reason: 'RESERVED' });
    expect(normalized('console.txt')).toBe('console.txt');
  });

  it('replaces characters that are hostile in headers or paths', () => {
    expect(normalized('a"b<c>d|e*f?.txt')).toBe('a_b_c_d_e_f_.txt');
  });

  it('drops trailing dots and spaces', () => {
    expect(normalized('report.pdf...')).toBe('report.pdf');
    expect(normalized('report.pdf   ')).toBe('report.pdf');
  });

  it('truncates long names but keeps the extension', () => {
    const long = `${'x'.repeat(500)}.pdf`;
    const result = normalized(long);
    expect(result.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('rejects absurdly long input outright', () => {
    expect(normalizeFilename('x'.repeat(2000))).toEqual({ ok: false, reason: 'TOO_LONG' });
  });

  it('is idempotent', () => {
    for (const input of ['../a/b.txt', 'a"b.txt', '.env', 'report.pdf...']) {
      const once = normalizeFilename(input);
      if (!once.ok) continue;
      expect(normalizeFilename(once.normalized)).toEqual({ ok: true, normalized: once.normalized });
    }
  });
});

describe('contentDispositionAttachment', () => {
  it('always uses attachment disposition', () => {
    expect(contentDispositionAttachment('a.pdf')).toMatch(/^attachment;/);
  });

  it('escapes quotes in the ascii fallback and encodes the utf-8 form', () => {
    const header = contentDispositionAttachment('re"port .pdf');
    expect(header).toContain('filename="re_port .pdf"');
    expect(header).not.toMatch(/filename="[^"]*"[^;]/);
  });

  it('encodes non-ascii names', () => {
    const header = contentDispositionAttachment('отчёт.pdf');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toMatch(/filename="_+\.pdf"/);
  });

  it('falls back to "download" when nothing ascii survives', () => {
    expect(contentDispositionAttachment('')).toContain('filename="download"');
  });
});

describe('extensionOf', () => {
  it.each([
    ['a.PDF', '.pdf'],
    ['a.tar.gz', '.gz'],
    ['noext', ''],
    ['trailing.', ''],
    ['.env', ''],
  ])('%s -> %s', (input, expected) => {
    expect(extensionOf(input)).toBe(expected);
  });
});

describe('active content handling', () => {
  it.each([
    ['text/html', 'page.txt'],
    ['image/svg+xml', 'logo.svg'],
    ['application/pdf', 'doc.pdf'],
    ['application/octet-stream', 'page.html'],
    ['application/octet-stream', 'script.mjs'],
  ])('%s / %s is active', (type, name) => {
    expect(isActiveContent(type, name)).toBe(true);
  });

  it('treats ordinary media as inactive', () => {
    expect(isActiveContent('image/png', 'a.png')).toBe(false);
    expect(isActiveContent('text/plain', 'a.txt')).toBe(false);
  });

  it('downgrades active types to octet-stream', () => {
    expect(safeContentType('text/html', 'a.html')).toBe('application/octet-stream');
    expect(safeContentType('image/png', 'evil.svg')).toBe('application/octet-stream');
  });

  it('rejects malformed types', () => {
    expect(safeContentType('not a type', 'a.bin')).toBe('application/octet-stream');
    expect(safeContentType('', 'a.bin')).toBe('application/octet-stream');
  });

  it('preserves safe types and drops parameters', () => {
    expect(safeContentType('image/PNG; charset=utf-8', 'a.png')).toBe('image/png');
  });
});
