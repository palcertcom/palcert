'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { useShell } from '@/components/shell/shell-context';
import { ConfirmAction as SharedConfirmAction } from '@/components/ui/confirm-action';
import { LoadingState } from '@/components/ui/states';
import { SystemMessage } from '@/components/ui/system-message';
import { getAdminMessages, type AdminMessages } from '@/i18n/admin-messages';
import { resolveLocale, type Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { ApiError } from '@/lib/api-client';

export function useAdminLocale(): Locale {
  return resolveLocale(useParams().locale);
}

/**
 * Shows a staff page only to someone whose PalCert-wide permissions allow it.
 *
 * A courtesy, not the control: every request the page makes is authorized by
 * the API regardless, and a direct URL gets exactly the refusal the API would
 * give. What this spares is a page of failed requests for someone who was
 * never going to be allowed.
 */
export function AdminGate({
  allowed,
  children,
}: {
  allowed: (permissions: ReadonlySet<string>) => boolean;
  children: ReactNode;
}) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const shell = useShell();

  if (shell.status === 'loading') {
    return (
      <main className="pc-page">
        <LoadingState label={messages.common.loading} />
      </main>
    );
  }
  if (shell.status !== 'signed-in' || !allowed(shell.globalPermissions)) {
    return (
      <SystemMessage
        icon="shield"
        title={messages.forbiddenTitle}
        body={messages.forbiddenBody}
        actions={
          <Link className="pc-btn pc-btn-secondary" href={`/${locale}`}>
            {getShellMessages(locale).dashboard}
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}

export interface AdminFailure {
  readonly message: string;
  /** The API wants a fresh sign-in before it will do this. */
  readonly reauth: boolean;
}

export function describeAdminError(messages: AdminMessages, caught: unknown): AdminFailure {
  if (caught instanceof ApiError) {
    return {
      message: messages.errors[caught.code] ?? messages.genericError,
      reauth: caught.code === 'REAUTHENTICATION_REQUIRED',
    };
  }
  return { message: messages.genericError, reauth: false };
}

/**
 * Why an action was refused for want of a recent sign-in, and the way back.
 *
 * PalCert has no in-place step-up: "recent" means the session began (or its
 * second factor was completed) within the re-authentication window, so the
 * honest answer is to sign in again — and then land back on this page.
 */
export function ReauthNotice({ locale }: { locale: Locale }) {
  const messages = getAdminMessages(locale);
  const pathname = usePathname();
  return (
    <div className="pc-alert pc-alert-warning" role="alert">
      <strong>{messages.reauthTitle}</strong>
      <p>{messages.reauthBody}</p>
      <Link
        className="pc-btn pc-btn-secondary pc-btn-sm"
        href={`/${locale}/login?next=${encodeURIComponent(pathname)}`}
      >
        {messages.reauthAction}
      </Link>
    </div>
  );
}

export type { ConfirmField } from '@/components/ui/confirm-action';

/** The shared confirmation dialog, with the console's labels and error wording. */
export function ConfirmAction(
  props: Omit<
    Parameters<typeof SharedConfirmAction>[0],
    'labels' | 'describeError' | 'reauthNotice'
  > & { locale: Locale },
) {
  const { locale, ...rest } = props;
  const messages = getAdminMessages(locale);
  return (
    <SharedConfirmAction
      {...rest}
      labels={{
        cancel: messages.common.cancel,
        close: messages.common.close,
        optional: messages.common.optional,
        pending: messages.common.loading,
        invalid: messages.errors.VALIDATION_FAILED ?? messages.genericError,
      }}
      describeError={(caught) => describeAdminError(messages, caught)}
      reauthNotice={<ReauthNotice locale={locale} />}
    />
  );
}

/** A small labelled figure. The number is always one the API returned. */
export function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="pc-admin-figure">
      <span className="pc-admin-figure-label">{label}</span>
      <span className="pc-admin-figure-value">{value}</span>
    </div>
  );
}
