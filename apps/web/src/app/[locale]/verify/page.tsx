'use client';

import { useRouter, useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { resolveLocale } from '@/i18n/locales';

/**
 * Where somebody types a certificate number (§13–§16).
 *
 * It is a form and not a browse: there is nothing to list, and the page says
 * so rather than leaving a visitor hunting for a search box that will never
 * exist.
 */
export default function VerifyEntryPage() {
  const params = useParams();
  const router = useRouter();
  const locale = resolveLocale(params.locale);
  const messages = getCertificatesMessages(locale);
  const [code, setCode] = useState('');

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = code.trim();
      if (trimmed === '') return;
      router.push(`/${locale}/verify/${encodeURIComponent(trimmed)}`);
    },
    [code, locale, router],
  );

  return (
    <main className="pc-page">
      <h1>{messages.verifyTitle}</h1>
      <p>{messages.verifyIntro}</p>
      <form onSubmit={submit}>
        <label htmlFor="verification-code">{messages.certificateNumber}</label>
        <input
          id="verification-code"
          name="verificationCode"
          className="pc-input-ltr"
          dir="ltr"
          value={code}
          placeholder={messages.verifyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit">{messages.verifyAction}</button>
      </form>
    </main>
  );
}
