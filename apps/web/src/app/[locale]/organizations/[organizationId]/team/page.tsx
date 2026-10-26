'use client';

import { useCallback, useEffect, useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth-form';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ReauthNotice } from '@/components/admin/admin-kit';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAuthMessages } from '@/i18n/auth-messages';
import { labelFor } from '@/i18n/organization-messages';
import { ApiError, organizationApi, type OrganizationMemberResponse } from '@/lib/api-client';

const ASSIGNABLE_ROLES = [
  'ORGANIZATION_ADMIN',
  'ORGANIZATION_REVIEWER',
  'TEMPLATE_MANAGER',
] as const;

function TeamSection({ organizationId, messages, permissions, locale }: OrganizationShellState) {
  const auth = getAuthMessages(locale);

  const [members, setMembers] = useState<OrganizationMemberResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManage = permissions.has('organization:member:update');
  const canAssignRoles = permissions.has('organization:role:assign');
  const canRemove = permissions.has('organization:member:remove');
  const canRemoveRoles = permissions.has('organization:role:remove');
  const canTransfer = permissions.has('organization:ownership:transfer');
  const t = messages.teamManage;
  const confirmProps = {
    labels: {
      cancel: t.cancel,
      close: t.close,
      optional: t.optional,
      pending: t.working,
      invalid: t.required,
    },
    describeError: (caught: unknown) => ({
      message:
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      reauth: caught instanceof ApiError && caught.code === 'REAUTHENTICATION_REQUIRED',
    }),
    reauthNotice: <ReauthNotice locale={locale} />,
  };

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      try {
        const page = await organizationApi.members(
          organizationId,
          cursor === undefined ? {} : { cursor },
        );
        setMembers((current) => (cursor === undefined ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? auth.genericError)
            : auth.genericError,
        );
      }
    },
    [auth, messages, organizationId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      );
    }
  }

  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const canAct = canManage || canRemove || canAssignRoles;

  const columns: DataColumn<OrganizationMemberResponse>[] = [
    {
      key: 'member',
      header: messages.member,
      primary: true,
      cell: (member) => (
        <span className="pc-cell-stack">
          <strong>
            <bdi>{member.displayName ?? member.email}</bdi>
          </strong>
          {member.displayName !== null && (
            <span className="pc-hint pc-ltr" dir="ltr">
              {member.email}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'roles',
      header: messages.roles,
      cell: (member) =>
        member.roles.length === 0 ? (
          '—'
        ) : (
          <span className="pc-tag-list">
            {member.roles.map((role) => (
              <span key={role} className="pc-tag pc-tag-removable">
                {labelFor(messages.roleLabels, role)}
                {canRemoveRoles ? (
                  <ConfirmAction
                    {...confirmProps}
                    label="×"
                    ariaLabel={`${t.removeRole}: ${labelFor(messages.roleLabels, role)}`}
                    title={`${t.removeRole}: ${labelFor(messages.roleLabels, role)}`}
                    intro={t.removeRoleIntro}
                    confirmLabel={t.removeRole}
                    danger
                    buttonClassName="pc-tag-remove"
                    onConfirm={async () => {
                      await organizationApi.removeRole(organizationId, member.membershipId, role);
                      setNotice(t.roleRemoved);
                      await load();
                    }}
                  />
                ) : null}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'status',
      header: messages.memberStatus,
      cell: (member) => (
        <StatusBadge
          status={member.status}
          label={labelFor(messages.statusLabels, member.status)}
        />
      ),
    },
    {
      key: 'joined',
      header: messages.joined,
      cell: (member) => formatter.format(new Date(member.joinedAt)),
    },
  ];

  if (canAct) {
    columns.push({
      key: 'actions',
      header: messages.actions,
      align: 'end',
      cell: (member) => (
        <div className="pc-row-actions">
          {canAssignRoles && (
            <>
              <label className="pc-visually-hidden" htmlFor={`role-${member.membershipId}`}>
                {messages.addRole}
              </label>
              <select
                id={`role-${member.membershipId}`}
                className="pc-select-sm"
                defaultValue=""
                onChange={(event) => {
                  const roleCode = event.target.value;
                  event.target.value = '';
                  if (roleCode === '') return;
                  void act(() =>
                    organizationApi.assignRole(organizationId, member.membershipId, roleCode),
                  );
                }}
              >
                <option value="">{messages.addRole}</option>
                {ASSIGNABLE_ROLES.filter((role) => !member.roles.includes(role)).map((role) => (
                  <option key={role} value={role}>
                    {labelFor(messages.roleLabels, role)}
                  </option>
                ))}
              </select>
            </>
          )}

          {canManage && member.status === 'ACTIVE' && (
            <button
              type="button"
              className="pc-btn pc-btn-secondary pc-btn-sm"
              onClick={() => {
                if (!window.confirm(messages.confirmSuspend)) return;
                void act(() =>
                  organizationApi.updateMember(organizationId, member.membershipId, 'SUSPENDED'),
                );
              }}
            >
              {messages.suspend}
            </button>
          )}

          {canManage && member.status === 'SUSPENDED' && (
            <button
              type="button"
              className="pc-btn pc-btn-secondary pc-btn-sm"
              onClick={() =>
                void act(() =>
                  organizationApi.updateMember(organizationId, member.membershipId, 'ACTIVE'),
                )
              }
            >
              {messages.reactivate}
            </button>
          )}

          {canRemove && (
            <button
              type="button"
              className="pc-btn pc-btn-danger pc-btn-sm"
              onClick={() => {
                if (!window.confirm(messages.confirmRemove)) return;
                void act(() => organizationApi.removeMember(organizationId, member.membershipId));
              }}
            >
              {messages.remove}
            </button>
          )}
        </div>
      ),
    });
  }

  return (
    <>
      <PageHeader title={messages.teamTitle} description={messages.teamSubtitle} />

      <FormError message={error} />
      <FormSuccess message={notice} />

      <DataTable
        caption={messages.teamTitle}
        columns={columns}
        rows={members}
        rowKey={(member) => member.membershipId}
      />

      {canTransfer ? (
        <TransferOwnership
          organizationId={organizationId}
          members={members}
          messages={messages}
          confirmProps={confirmProps}
          onTransferred={async () => {
            setNotice(t.transferred);
            await load();
          }}
        />
      ) : null}

      {nextCursor !== null && (
        <div className="pc-list-footer">
          <button
            type="button"
            className="pc-btn pc-btn-secondary"
            onClick={() => void load(nextCursor)}
          >
            {messages.loadMore}
          </button>
        </div>
      )}
    </>
  );
}

function TransferOwnership({
  organizationId,
  members,
  messages,
  confirmProps,
  onTransferred,
}: {
  organizationId: string;
  members: readonly OrganizationMemberResponse[];
  messages: OrganizationShellState['messages'];
  confirmProps: Pick<
    Parameters<typeof ConfirmAction>[0],
    'labels' | 'describeError' | 'reauthNotice'
  >;
  onTransferred: () => Promise<void>;
}) {
  const t = messages.teamManage;
  // Only someone already in the organization can be handed it, and never an
  // existing owner.
  const candidates = members.filter(
    (member) => member.status === 'ACTIVE' && !member.roles.includes('ORGANIZATION_OWNER'),
  );
  return (
    <section className="pc-card pc-transfer" aria-labelledby="transfer-ownership-heading">
      <h2 id="transfer-ownership-heading" className="pc-card-title">
        {t.transferTitle}
      </h2>
      <p className="pc-hint">{t.transferIntro}</p>
      {candidates.length === 0 ? (
        <p>{t.noCandidates}</p>
      ) : (
        <ConfirmAction
          {...confirmProps}
          label={t.transfer}
          title={t.transferTitle}
          intro={t.transferIntro}
          danger
          fields={[
            {
              name: 'to',
              label: t.transferTo,
              maxLength: 64,
              options: candidates.map((member) => ({
                value: member.membershipId,
                label:
                  member.displayName === null
                    ? member.email
                    : `${member.displayName} (${member.email})`,
              })),
            },
            {
              name: 'stepDown',
              label: t.stepDown,
              maxLength: 8,
              options: [
                { value: 'yes', label: t.stepDown },
                { value: 'no', label: t.stayOwner },
              ],
            },
          ]}
          onConfirm={async (values) => {
            await organizationApi.transferOwnership(
              organizationId,
              values['to'] ?? '',
              values['stepDown'] !== 'no',
            );
            await onTransferred();
          }}
        />
      )}
    </section>
  );
}

export default function TeamPage() {
  return <OrganizationShell>{(state) => <TeamSection {...state} />}</OrganizationShell>;
}
