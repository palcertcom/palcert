'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/auth-form';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { getAuthMessages } from '@/i18n/auth-messages';
import { labelFor } from '@/i18n/organization-messages';
import { ApiError, organizationApi, type OrganizationInvitationResponse } from '@/lib/api-client';

const INVITABLE_ROLES = [
  'ORGANIZATION_ADMIN',
  'ORGANIZATION_REVIEWER',
  'TEMPLATE_MANAGER',
] as const;

function InvitationsSection({
  organizationId,
  messages,
  permissions,
  locale,
}: OrganizationShellState) {
  const auth = getAuthMessages(locale);
  const roleId = useId();

  const [invitations, setInvitations] = useState<OrganizationInvitationResponse[]>([]);
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState<string>('ORGANIZATION_REVIEWER');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canInvite = permissions.has('organization:member:invite');

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await organizationApi.invitations(organizationId);
      setInvitations(page.items);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      );
    }
  }, [auth, messages, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onInvite(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      await organizationApi.invite(organizationId, { email, roleCode });
      setNotice(messages.invitationSent);
      setEmail('');
      await load();
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

  const columns: DataColumn<(typeof invitations)[number]>[] = [
    {
      key: 'email',
      header: messages.emailAddress,
      primary: true,
      cell: (invitation) => (
        <span className="pc-ltr" dir="ltr">
          {invitation.email}
        </span>
      ),
    },
    {
      key: 'role',
      header: messages.role,
      cell: (invitation) => (
        <span className="pc-tag">{labelFor(messages.roleLabels, invitation.roleCode)}</span>
      ),
    },
    {
      key: 'status',
      header: messages.memberStatus,
      cell: (invitation) => (
        <StatusBadge
          status={invitation.status}
          label={labelFor(messages.statusLabels, invitation.status)}
        />
      ),
    },
    {
      key: 'expires',
      header: messages.expires,
      cell: (invitation) => formatter.format(new Date(invitation.expiresAt)),
    },
  ];
  if (canInvite) {
    columns.push({
      key: 'actions',
      header: messages.actions,
      align: 'end',
      cell: (invitation) =>
        invitation.status === 'PENDING' ? (
          <button
            type="button"
            className="pc-btn pc-btn-secondary pc-btn-sm"
            onClick={() => {
              void organizationApi
                .revokeInvitation(organizationId, invitation.id)
                .then(load)
                .catch(() => setError(auth.genericError));
            }}
          >
            {messages.revoke}
          </button>
        ) : null,
    });
  }

  return (
    <>
      <PageHeader title={messages.invitationsTitle} />

      <FormError message={error} />
      <FormSuccess message={notice} />

      <div className={canInvite ? 'pc-detail-grid' : undefined}>
        <div className="pc-detail-main">
          {invitations.length === 0 ? (
            <EmptyState icon="invitation" title={messages.noInvitations} headingLevel={2} />
          ) : (
            <DataTable
              caption={messages.invitationsTitle}
              columns={columns}
              rows={invitations}
              rowKey={(invitation) => invitation.id}
            />
          )}
        </div>

        {canInvite && (
          <section className="pc-card" aria-labelledby="invite-heading">
            <h2 id="invite-heading" className="pc-card-title">
              {messages.sendInvitation}
            </h2>
            <form className="pc-form" onSubmit={onInvite} noValidate>
              <Field
                label={messages.emailAddress}
                type="email"
                name="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                inputMode="email"
              />
              <div className="pc-field">
                <label htmlFor={roleId}>{messages.role}</label>
                <select
                  id={roleId}
                  value={roleCode}
                  onChange={(event) => setRoleCode(event.target.value)}
                >
                  {INVITABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {labelFor(messages.roleLabels, role)}
                    </option>
                  ))}
                </select>
              </div>
              <SubmitButton
                label={messages.sendInvitation}
                pendingLabel={auth.sending}
                pending={pending}
              />
            </form>
          </section>
        )}
      </div>
    </>
  );
}

export default function InvitationsPage() {
  return <OrganizationShell>{(state) => <InvitationsSection {...state} />}</OrganizationShell>;
}
