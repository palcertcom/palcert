import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Arabic typography is a product requirement, so its contract is tested
 * rather than left to review: PalCert ships its own Arabic face, sets Arabic
 * in it with Arabic weights and leading, never spaces Arabic letters apart,
 * and keeps technical strings left-to-right and monospaced.
 */
const here = dirname(fileURLToPath(import.meta.url));
const styles = join(here, '..');
const read = (name: string) => readFileSync(join(styles, name), 'utf8');
const require = createRequire(import.meta.url);

describe('Arabic typography', () => {
  const tokens = read('tokens.css');
  const base = read('base.css');

  it('sets Arabic in the bundled face first, with the system face only last', () => {
    const stack = /--pc-font-arabic:\s*([^;]+);/.exec(tokens)?.[1] ?? '';
    const faces = stack.split(',').map((face) => face.trim().replace(/'/g, ''));
    expect(faces[0]).toBe('IBM Plex Sans Arabic');
    expect(faces.slice(0, 4)).toEqual([
      'IBM Plex Sans Arabic',
      'Noto Sans Arabic',
      'Cairo',
      'Tajawal',
    ]);
    expect(faces.at(-1)).toBe('sans-serif');
  });

  it('ships the face from PalCert’s own origin, in the four weights it uses, under the OFL', () => {
    const layout = readFileSync(join(styles, '..', 'app', 'layout.tsx'), 'utf8');
    for (const weight of [400, 500, 600, 700]) {
      expect(layout).toContain(`@fontsource/ibm-plex-sans-arabic/${weight}.css`);
      const css = readFileSync(
        require.resolve(`@fontsource/ibm-plex-sans-arabic/${weight}.css`),
        'utf8',
      );
      // Relative, same-origin files only: the content security policy allows
      // fonts from 'self' and nothing else.
      expect(css).not.toMatch(/url\(\s*['"]?https?:/);
      expect(css).toMatch(/unicode-range/);
    }
    const manifest = JSON.parse(
      readFileSync(require.resolve('@fontsource/ibm-plex-sans-arabic/package.json'), 'utf8'),
    ) as { license: string };
    expect(manifest.license).toBe('OFL-1.1');
    expect(
      existsSync(
        join(dirname(require.resolve('@fontsource/ibm-plex-sans-arabic/package.json')), 'LICENSE'),
      ),
    ).toBe(true);
  });

  it('defines the Arabic weights deliberately', () => {
    expect(tokens).toMatch(/--pc-ar-weight-body:\s*400/);
    expect(tokens).toMatch(/--pc-ar-weight-label:\s*500/);
    expect(tokens).toMatch(/--pc-ar-weight-heading:\s*600/);
    expect(tokens).toMatch(/--pc-ar-weight-title:\s*700/);
  });

  it('gives Arabic body text generous leading', () => {
    const leading = Number(/--pc-leading-arabic:\s*([\d.]+)/.exec(tokens)?.[1]);
    expect(leading).toBeGreaterThanOrEqual(1.6);
    expect(leading).toBeLessThanOrEqual(1.75);
    expect(base).toMatch(/html\[lang='ar'\] body\s*\{[^}]*var\(--pc-leading-arabic\)/);
  });

  it('never tracks Arabic letters apart', () => {
    expect(base).toMatch(/html\[lang='ar'\] \*,[\s\S]*?letter-spacing:\s*0 !important/);
  });

  it('keeps technical strings left-to-right and monospaced in Arabic', () => {
    expect(base).toMatch(/\.pc-ltr\s*\{[^}]*direction:\s*ltr/);
    expect(base).toMatch(/unicode-bidi:\s*isolate/);
    expect(base).toMatch(
      /html\[lang='ar'\] :is\(code, kbd, samp, \.pc-hash, \.pc-rule-code, \.pc-ltr\)\s*\{[^}]*--pc-font-mono/,
    );
    expect(base).toMatch(/input\[type='email'\][\s\S]*?direction:\s*ltr/);
  });
});
