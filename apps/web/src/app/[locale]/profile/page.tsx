'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { roleRequiresMfa } from '@palcert/contracts/auth/roles';
import { AiConsentSettings, DisableMfa } from '@/components/account-security';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/auth-form';
import { ResendVerification } from '@/components/resend-verification';
import { ApiError, authApi, type UserProfileResponse } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { LOCALES, LOCALE_LABELS, resolveLocale } from '@/i18n/locales';

export default function ProfilePage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const router = useRouter();

  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [preferredLocale, setPreferredLocale] = useState<string>(locale);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const securityHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    void authApi
      .me()
      .then((result) => {
        if (cancelled) return;
        // A read cut short (Firefox, when a navigation interrupts the body)
        // resolves with no account at all. Rendering that as a profile would
        // crash the page, so it is treated as the failure it is.
        if (result === undefined || result === null) {
          setError(messages.genericError);
          return;
        }
        setProfile(result);
        setDisplayName(result.displayName ?? '');
        setPreferredLocale(result.preferredLocale);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // An unauthenticated visitor is sent to the dedicated page rather than
        // shown an empty profile.
        if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
          router.push(`/${locale}/unauthorized`);
          return;
        }
        setError(messages.genericError);
      });
    return () => {
      cancelled = true;
    };
  }, [locale, messages, router]);

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setPending(true);

    try {
      const updated = await authApi.updateMe({ displayName, preferredLocale });
      setProfile(updated);
      setSuccess(messages.profileSaved);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  /** After a security change, read the account again rather than guess its new state. */
  async function refresh(message: string): Promise<void> {
    setError(null);
    setSuccess(null);
    try {
      const me = await authApi.me();
      // An empty body (a cancelled read) leaves the last known state in place.
      if (me !== undefined && me !== null) setProfile(me);
      // Announced only once the page shows the new state, so the message and
      // the badge never disagree.
      setSuccess(message);
    } catch (caught) {
      // The change itself succeeded; say so even if the re-read did not.
      setSuccess(message);
      if (caught instanceof ApiError && caught.status === 401) {
        router.push(`/${locale}/login`);
        return;
      }
      setError(messages.genericError);
    }
  }

  async function onSignOut(): Promise<void> {
    await authApi.logout().catch(() => undefined);
    router.push(`/${locale}/login`);
  }

  const label = (map: Readonly<Record<string, string>>, value: string) => map[value] ?? value;

  return (
    <main className="pc-page">
      <PageHeader title={messages.profileTitle} />
      <FormError message={error} />
      <FormSuccess message={success} />

      {profile === null ? (
        error === null ? (
          <LoadingState label={messages.sending} />
        ) : null
      ) : (
        <div className="pc-detail-grid">
          {profile.emailVerified ? null : (
            <section className="pc-card pc-notice-card" aria-labelledby="email-unconfirmed-heading">
              <h2 id="email-unconfirmed-heading" className="pc-card-title">
                {messages.emailUnconfirmed}
              </h2>
              <ResendVerification locale={locale} email={profile.email} />
            </section>
          )}
          <div className="pc-detail-main">
            <section className="pc-card pc-form-card" aria-labelledby="profile-details-heading">
              <h2 id="profile-details-heading" className="pc-card-title">
                {messages.profileDetails}
              </h2>
              <form className="pc-form" onSubmit={onSave} noValidate>
                <Field
                  label={messages.displayName}
                  type="text"
                  name="name"
                  value={displayName}
                  onChange={setDisplayName}
                  autoComplete="name"
                  required={false}
                />

                <div className="pc-field">
                  <label htmlFor="preferred-locale">{messages.preferredLanguage}</label>
                  <select
                    id="preferred-locale"
                    name="preferred-locale"
                    value={preferredLocale}
                    onChange={(event) => setPreferredLocale(event.target.value)}
                  >
                    {LOCALES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {LOCALE_LABELS[candidate]}
                      </option>
                    ))}
                  </select>
                </div>

                <SubmitButton
                  label={messages.profileSave}
                  pendingLabel={messages.sending}
                  pending={pending}
                />
              </form>
            </section>
            {profile.permissions.includes('password:change:self') && (
              <ChangePassword messages={messages} />
            )}
            <AiConsentSettings locale={locale} />
          </div>

          <div className="pc-detail-side">
            <section
              id="security"
              className="pc-card"
              aria-labelledby="profile-security-heading"
              data-testid="profile-security"
            >
              {/* Focus lands here after two-step sign-in is turned off: the
                  button that opened the dialog no longer exists. */}
              <h2
                id="profile-security-heading"
                className="pc-card-title"
                tabIndex={-1}
                ref={securityHeading}
              >
                {messages.profileSecurity}
              </h2>
              <dl className="pc-summary">
                <dt>{messages.profileMfa}</dt>
                <dd>
                  <StatusBadge
                    tone={profile.mfaEnrolled ? 'success' : 'neutral'}
                    label={profile.mfaEnrolled ? messages.profileMfaOn : messages.profileMfaOff}
                  />
                </dd>
              </dl>
              {/* Enrollment is open to any signed-in account; the API refuses
                  a second enrollment, so set-up is offered only while two-step
                  sign-in is off, and turning it off only while it is on. */}
              {profile.mfaEnrolled ? (
                <DisableMfa
                  locale={locale}
                  mfaRequired={profile.mfaRequired}
                  requiredByRole={profile.roles.some((role) => roleRequiresMfa(role))}
                  canManage={profile.permissions.includes('mfa:manage:self')}
                  onDisabled={async () => {
                    await refresh(messages.mfaDisabled);
                    securityHeading.current?.focus();
                  }}
                />
              ) : (
                <div className="pc-actions">
                  <Link
                    className="pc-btn"
                    href={`/${locale}/mfa/enroll`}
                    aria-label={messages.profileMfaSetUp}
                  >
                    {messages.profileMfaSetUpShort}
                  </Link>
                </div>
              )}
              <div className="pc-actions">
                <Link className="pc-btn pc-btn-secondary" href={`/${locale}/sessions`}>
                  {messages.sessionsTitle}
                </Link>
                <button type="button" className="pc-btn pc-btn-secondary" onClick={onSignOut}>
                  {messages.signOut}
                </button>
              </div>
            </section>

            <section className="pc-card" aria-labelledby="profile-account-heading">
              <h2 id="profile-account-heading" className="pc-card-title">
                {messages.profileAccount}
              </h2>
              <dl className="pc-summary">
                <dt>{messages.email}</dt>
                <dd>
                  <span dir="ltr" className="pc-ltr">
                    {profile.email}
                  </span>
                </dd>
                <dt>{messages.profileStatus}</dt>
                <dd>
                  <StatusBadge
                    status={profile.status}
                    label={label(messages.accountStatusLabels, profile.status)}
                  />
                </dd>
                <dt>{messages.profileRoles}</dt>
                <dd>
                  <span className="pc-tag-list">
                    {profile.roles.map((role) => (
                      <span key={role} className="pc-tag">
                        {label(messages.accountRoleLabels, role)}
                      </span>
                    ))}
                  </span>
                </dd>
              </dl>
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * Change the password (requires the current one). The API rotates this
 * session and revokes every other, so a stolen session stops working at once.
 */
function ChangePassword({ messages }: { messages: ReturnType<typeof getAuthMessages> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setDone(null);
    if (next !== confirm) {
      setError(messages.passwordMismatch);
      return;
    }
    setPending(true);
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(messages.passwordChanged);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === 'AUTHENTICATION_FAILED'
            ? messages.currentPasswordWrong
            : messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="pc-card" aria-labelledby="password-change-heading">
      <h2 id="password-change-heading" className="pc-card-title">
        {messages.passwordChangeTitle}
      </h2>
      <FormError message={error} />
      <FormSuccess message={done} />
      <form className="pc-form" onSubmit={onSubmit} noValidate>
        <Field
          label={messages.currentPassword}
          type="password"
          name="current-password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <Field
          label={messages.newPassword}
          type="password"
          name="new-password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          hint={messages.passwordHint}
        />
        <Field
          label={messages.confirmPassword}
          type="password"
          name="confirm-password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <SubmitButton
          label={messages.passwordChangeTitle}
          pendingLabel={messages.sending}
          pending={pending}
        />
      </form>
    </section>
  );
}
