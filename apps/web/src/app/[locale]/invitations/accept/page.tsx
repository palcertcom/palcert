'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { FormError, FormShell, FormSuccess } from '@/components/auth-form';
import { getAuthMessages } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';
import { getOrganizationMessages, labelFor } from '@/i18n/organization-messages';
import { ApiError, organizationApi } from '@/lib/api-client';

interface Preview {
  organizationDisplayName: string;
  roleCode: string;
  expiresAt: string;
  requiresRegistration: boolean;
}

function AcceptInvitation() {
  const locale = resolveLocale(useParams().locale);
  const messages = getOrganizationMessages(locale);
  const auth = getAuthMessages(locale);
  const router = useRouter();
  const token = useSearchParams().get('token');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (token === null || token === '') {
      setError(auth.verifyMissingToken);
      return;
    }

    let cancelled = false;
    void organizationApi
      .previewInvitation(token)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? caught.code === 'VALIDATION_FAILED'
              ? (messages.errors.INVITATION_NOT_FOUND ?? auth.genericError)
              : (messages.errors[caught.code] ?? auth.genericError)
            : auth.genericError,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [auth, messages, token]);

  async function onAccept(): Promise<void> {
    if (token === null) return;
    setError(null);
    setPending(true);

    try {
      const result = await organizationApi.acceptInvitation(token);
      setNotice(messages.acceptedMessage);
      router.push(`/${locale}/organizations/${result.organizationId}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        // Not signed in: the invited address must authenticate first.
        router.push(`/${locale}/login`);
        return;
      }
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      );
      setPending(false);
    }
  }

  return (
    <FormShell title={messages.acceptTitle} subtitle={messages.acceptSubtitle}>
      <FormError message={error} />
      <FormSuccess message={notice} />

      {preview !== null && (
        <>
          <dl className="pc-definitions">
            <dt>{messages.organizations}</dt>
            <dd>{preview.organizationDisplayName}</dd>
            <dt>{messages.role}</dt>
            <dd>{labelFor(messages.roleLabels, preview.roleCode)}</dd>
            <dt>{messages.expires}</dt>
            <dd>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                new Date(preview.expiresAt),
              )}
            </dd>
          </dl>

          {preview.requiresRegistration ? (
            <>
              <p>{messages.acceptRegisterFirst}</p>
              <nav className="pc-links">
                <Link className="pc-button" href={`/${locale}/register`}>
                  {auth.register}
                </Link>
              </nav>
            </>
          ) : (
            <button
              type="button"
              className="pc-button"
              disabled={pending}
              aria-busy={pending}
              onClick={() => void onAccept()}
            >
              {pending ? auth.sending : messages.acceptInvitation}
            </button>
          )}
        </>
      )}
    </FormShell>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvitation />
    </Suspense>
  );
}
