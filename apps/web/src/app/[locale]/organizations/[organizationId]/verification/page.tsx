'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { FormError, FormSuccess, SubmitButton } from '@/components/auth-form';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { getAuthMessages } from '@/i18n/auth-messages';
import { labelFor } from '@/i18n/organization-messages';
import { ApiError, organizationApi, type VerificationResponse } from '@/lib/api-client';

function VerificationSection({
  organizationId,
  messages,
  permissions,
  locale,
  reload,
}: OrganizationShellState) {
  const auth = getAuthMessages(locale);

  const [state, setState] = useState<VerificationResponse | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canRequest = permissions.has('organization:verification:request');

  useEffect(() => {
    let cancelled = false;
    void organizationApi
      .verification(organizationId)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? auth.genericError)
            : auth.genericError,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [auth, messages, organizationId]);

  async function onRequest(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      const result = await organizationApi.requestVerification(
        organizationId,
        note.trim() === '' ? undefined : note.trim(),
      );
      setState(result);
      setNotice(messages.verificationRequested);
      setNote('');
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const offerRequest = state !== null && canRequest && state.canRequest;

  return (
    <>
      {/* States plainly what verification does and does not mean (§27). */}
      <PageHeader title={messages.verificationTitle} description={messages.verificationSemantics} />

      <FormError message={error} />
      <FormSuccess message={notice} />

      {state !== null && (
        <div className={offerRequest ? 'pc-detail-grid' : undefined}>
          <section className="pc-card" aria-labelledby="verification-status-heading">
            <h2 id="verification-status-heading" className="pc-card-title">
              {messages.memberStatus}
            </h2>
            <p>
              <StatusBadge
                status={state.status}
                tone={
                  state.status === 'VERIFIED'
                    ? 'success'
                    : state.status === 'REJECTED'
                      ? 'danger'
                      : 'neutral'
                }
                label={labelFor(messages.verificationLabels, state.status)}
              />
            </p>
            <dl className="pc-summary">
              {state.requestedAt !== null && (
                <>
                  <dt>{messages.created}</dt>
                  <dd>{formatter.format(new Date(state.requestedAt))}</dd>
                </>
              )}
              {state.decisionReason !== null && (
                <>
                  <dt>{messages.verificationReason}</dt>
                  <dd>{state.decisionReason}</dd>
                </>
              )}
            </dl>
          </section>

          {offerRequest && (
            <section className="pc-card" aria-labelledby="verification-request-heading">
              <h2 id="verification-request-heading" className="pc-card-title">
                {messages.requestVerification}
              </h2>
              <form className="pc-form" onSubmit={onRequest} noValidate>
                <div className="pc-field">
                  <label htmlFor="verification-note">{messages.verificationNote}</label>
                  <textarea
                    id="verification-note"
                    name="verification-note"
                    rows={4}
                    maxLength={2000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </div>
                <SubmitButton
                  label={messages.requestVerification}
                  pendingLabel={auth.sending}
                  pending={pending}
                />
              </form>
            </section>
          )}
        </div>
      )}
    </>
  );
}

export default function VerificationPage() {
  return <OrganizationShell>{(state) => <VerificationSection {...state} />}</OrganizationShell>;
}
