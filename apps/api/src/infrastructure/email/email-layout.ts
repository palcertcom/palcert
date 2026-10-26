/**
 * The HTML and text shell for PalCert's own transactional mail (ADR-0146).
 *
 * Every interpolated value is escaped. There is no script, no remote image, no
 * remote stylesheet and no tracking pixel: the message renders the same with
 * remote content blocked, which is how many recipients read it. Arabic mail is
 * `dir="rtl"`; technical strings (addresses, links) are wrapped `dir="ltr"` so
 * they do not reorder.
 */
export type EmailLocale = 'en' | 'ar';

export function resolveEmailLocale(value: string | null | undefined): EmailLocale {
  return (value ?? '').trim().toLowerCase() === 'ar' ? 'ar' : 'en';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailLayoutInput {
  readonly locale: EmailLocale;
  readonly subject: string;
  readonly heading: string;
  /** Plain sentences. Escaped here. */
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Rows of label/value shown as a small table (test mail). Escaped. */
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
  readonly footer: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderEmailLayout(input: EmailLayoutInput): RenderedEmail {
  const direction = input.locale === 'ar' ? 'rtl' : 'ltr';
  const align = input.locale === 'ar' ? 'right' : 'left';
  const font =
    input.locale === 'ar'
      ? "Tahoma, 'Segoe UI', Arial, sans-serif"
      : "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

  const paragraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(p)}</p>`)
    .join('');

  const action =
    input.action === undefined
      ? ''
      : `<p style="margin:24px 0"><a href="${escapeHtml(input.action.url)}" ` +
        `style="background:#0f5132;color:#ffffff;padding:12px 20px;border-radius:6px;` +
        `text-decoration:none;display:inline-block;font-weight:600">${escapeHtml(input.action.label)}</a></p>` +
        `<p style="margin:0 0 16px;line-height:1.6;font-size:13px;color:#555555">` +
        `<span dir="ltr" style="word-break:break-all">${escapeHtml(input.action.url)}</span></p>`;

  const facts =
    input.facts === undefined || input.facts.length === 0
      ? ''
      : `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font-size:14px">` +
        input.facts
          .map(
            (fact) =>
              `<tr><th scope="row" style="text-align:${align};padding:4px 12px 4px 0;color:#555555;font-weight:600">` +
              `${escapeHtml(fact.label)}</th><td style="padding:4px 0"><span dir="ltr">${escapeHtml(fact.value)}</span></td></tr>`,
          )
          .join('') +
        `</table>`;

  const html =
    `<!doctype html><html lang="${input.locale}" dir="${direction}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f5f5f4">` +
    `<div role="article" aria-label="${escapeHtml(input.subject)}" dir="${direction}" ` +
    `style="max-width:560px;margin:0 auto;padding:24px;font-family:${font};color:#1c1917;text-align:${align}">` +
    `<p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#0f5132">PalCert</p>` +
    `<div style="background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:24px">` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4">${escapeHtml(input.heading)}</h1>` +
    paragraphs +
    facts +
    action +
    `</div>` +
    `<p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#78716c">${escapeHtml(input.footer)}</p>` +
    `</div></body></html>`;

  const textParts = [input.heading, '', ...input.paragraphs.flatMap((p) => [p, ''])];
  if (input.facts !== undefined) {
    for (const fact of input.facts) textParts.push(`${fact.label}: ${fact.value}`);
    textParts.push('');
  }
  if (input.action !== undefined) textParts.push(`${input.action.label}:`, input.action.url, '');
  textParts.push('—', input.footer);

  return { subject: input.subject, text: textParts.join('\n'), html };
}
