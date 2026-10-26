'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  PRIVILEGED_ROLES,
  ROLE_DEFINITIONS,
  RoleScope,
  type RoleCode,
} from '@palcert/contracts/auth/roles';
import {
  AdminGate,
  ConfirmAction,
  describeAdminError,
  ReauthNotice,
  useAdminLocale,
  type AdminFailure,
} from '@/components/admin/admin-kit';
import { FormError, FormSuccess } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getAuthMessages } from '@/i18n/auth-messages';
import { FINANCE_READ } from '@/lib/shell-navigation';
import { adminApi, type UserProfileResponse } from '@/lib/api-client';

/**
 * PalCert-wide roles that can be granted here. Organization roles belong to
 * organizations, and the machine role belongs to API credentials: the API
 * refuses both, so neither is offered.
 */
const GRANTABLE: readonly RoleCode[] = ROLE_DEFINITIONS.filter(
  (role) => role.scope === RoleScope.GLOBAL && role.code !== 'API_CLIENT',
).map((role) => role.code);

/**
 * One PalCert account, for staff: what it is, which PalCert-wide roles it
 * holds, and the few things staff may do about it. There is no password
 * reset, sign-in-as, or edit of a person's details here — the API offers
 * none, deliberately.
 */
export default function AdminUserPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:user:read')}>
      <Detail />
    </AdminGate>
  );
}

function Detail() {
  const locale = useAdminLocale();
  const userId = String(useParams().userId);
  const messages = getAdminMessages(locale);
  const auth = getAuthMessages(locale);
  const shell = useShell();
  const can = shell.globalPermissions;
  const yourself = shell.user?.id === userId;

  const [user, setUser] = useState<UserProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUser(await adminApi.user(userId));
      setError(null);
    } catch (caught) {
      setError(describeAdminError(messages, caught).message);
    }
  }, [messages, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function after(message: string, updated?: UserProfileResponse): Promise<void> {
    setDone(message);
    if (updated === undefined) await load();
    else setUser(updated);
  }

  if (user === null) {
    return (
      <main className="pc-page">
        {error === null ? (
          <LoadingState label={messages.common.loading} />
        ) : (
          <>
            <PageHeader title={messages.nav.users} />
            <ErrorState title={error} />
          </>
        )}
      </main>
    );
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = (value: string | null) =>
    value === null ? (
      messages.common.never
    ) : (
      <time dateTime={value}>{when.format(new Date(value))}</time>
    );
  const roleLabel = (code: string) => auth.accountRoleLabels[code] ?? code;
  const globalRoles = user.roles.filter((role) => (GRANTABLE as readonly string[]).includes(role));
  const grantable = GRANTABLE.filter((code) => !user.roles.includes(code));
  const canFinance = FINANCE_READ.some((permission) => can.has(permission));

  return (
    <main className="pc-page">
      <PageHeader
        title={user.displayName ?? user.email}
        description={
          <StatusBadge
            status={user.status}
            label={auth.accountStatusLabels[user.status] ?? user.status}
          />
        }
      />
      <FormSuccess message={done} />
      {yourself ? <p className="pc-alert pc-alert-warning">{messages.user.yourself}</p> : null}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section className="pc-card" aria-labelledby="user-roles-heading">
            <h2 id="user-roles-heading" className="pc-card-title">
              {messages.user.roles}
            </h2>
            {globalRoles.length === 0 ? (
              <p className="pc-hint">{messages.user.noRoles}</p>
            ) : (
              <ul className="pc-role-list">
                {globalRoles.map((role) => (
                  <li key={role}>
                    <span className="pc-tag">{roleLabel(role)}</span>
                    {can.has('admin:role:remove') && !yourself ? (
                      <ConfirmAction
                        locale={locale}
                        label={messages.user.removeRole}
                        title={`${messages.user.removeRole}: ${roleLabel(role)}`}
                        intro={messages.user.removeIntro}
                        danger
                        buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
                        onConfirm={async () => {
                          await after(
                            messages.user.removed,
                            await adminApi.removeRole(userId, role),
                          );
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {can.has('admin:role:assign') && !yourself && grantable.length > 0 ? (
              <GrantRole
                locale={locale}
                options={grantable}
                roleLabel={roleLabel}
                onGranted={async (updated) => after(messages.user.granted, updated)}
                userId={userId}
              />
            ) : null}
          </section>

          {canFinance ? (
            <section className="pc-card" aria-labelledby="user-finance-heading">
              <h2 id="user-finance-heading" className="pc-card-title">
                {messages.user.finance}
              </h2>
              <Link
                className="pc-btn pc-btn-secondary"
                href={`/${locale}/admin/finance/customers/${userId}`}
              >
                {messages.user.viewFinance}
              </Link>
            </section>
          ) : null}
        </div>

        <div className="pc-detail-side">
          <section className="pc-card" aria-labelledby="user-account-heading">
            <h2 id="user-account-heading" className="pc-card-title">
              {messages.user.account}
            </h2>
            <dl className="pc-summary">
              <dt>{messages.users.email}</dt>
              <dd>
                <span dir="ltr" className="pc-ltr">
                  {user.email}
                </span>
              </dd>
              <dt>{messages.users.emailVerified}</dt>
              <dd>{user.emailVerified ? messages.common.yes : messages.common.no}</dd>
              <dt>{messages.user.mfa}</dt>
              <dd>
                {user.mfaEnrolled ? messages.user.mfaOn : messages.user.mfaOff}
                {user.mfaRequired ? ` · ${messages.user.mfaRequired}` : ''}
              </dd>
              <dt>{messages.users.created}</dt>
              <dd>{date(user.createdAt)}</dd>
              <dt>{messages.users.lastLogin}</dt>
              <dd>{date(user.lastLoginAt)}</dd>
            </dl>
            {yourself ? null : (
              <div className="pc-actions">
                {user.status === 'SUSPENDED' ? (
                  can.has('admin:user:reactivate') ? (
                    <ConfirmAction
                      locale={locale}
                      label={messages.user.reactivate}
                      title={messages.user.reactivate}
                      intro={messages.user.reactivateIntro}
                      onConfirm={async () => {
                        await after(
                          messages.user.reactivated,
                          await adminApi.reactivateUser(userId),
                        );
                      }}
                    />
                  ) : null
                ) : user.status === 'ACTIVE' && can.has('admin:user:suspend') ? (
                  <ConfirmAction
                    locale={locale}
                    label={messages.user.suspend}
                    title={messages.user.suspend}
                    intro={messages.user.suspendIntro}
                    danger
                    fields={[
                      {
                        name: 'reason',
                        label: messages.user.suspendReason,
                        maxLength: 500,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) => {
                      await after(
                        messages.user.suspended,
                        await adminApi.suspendUser(userId, values['reason']),
                      );
                    }}
                  />
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function GrantRole({
  locale,
  userId,
  options,
  roleLabel,
  onGranted,
}: {
  locale: 'en' | 'ar';
  userId: string;
  options: readonly RoleCode[];
  roleLabel: (code: string) => string;
  onGranted: (updated: UserProfileResponse) => Promise<void>;
}) {
  const messages = getAdminMessages(locale);
  const selectId = useId();
  const [role, setRole] = useState<RoleCode>(options[0]!);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const privileged = (PRIVILEGED_ROLES as readonly string[]).includes(role);

  return (
    <div className="pc-grant-role">
      <h3 className="pc-subheading">{messages.user.grantRole}</h3>
      <div className="pc-field">
        <label htmlFor={selectId}>{messages.user.roleLabel}</label>
        <select
          id={selectId}
          value={role}
          onChange={(event) => {
            setRole(event.target.value as RoleCode);
            setFailure(null);
          }}
        >
          {options.map((code) => (
            <option key={code} value={code}>
              {roleLabel(code)}
            </option>
          ))}
        </select>
      </div>
      {privileged ? <p className="pc-hint">{messages.user.privilegedWarning}</p> : null}
      {failure === null ? null : failure.reauth ? (
        <ReauthNotice locale={locale} />
      ) : (
        <FormError message={failure.message} />
      )}
      <ConfirmAction
        locale={locale}
        label={messages.user.grantRole}
        title={`${messages.user.grantRole}: ${roleLabel(role)}`}
        intro={
          privileged
            ? `${messages.user.grantIntro} ${messages.user.privilegedWarning}`
            : messages.user.grantIntro
        }
        onConfirm={async () => {
          setFailure(null);
          await onGranted(await adminApi.grantRole(userId, role));
        }}
      />
    </div>
  );
}
