'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AdminGate,
  ConfirmAction,
  describeAdminError,
  useAdminLocale,
} from '@/components/admin/admin-kit';
import { FormSuccess } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { adminApi, type AdminOrganizationDetailResponse } from '@/lib/api-client';

/**
 * One organization, for PalCert staff: its profile, its standing, and its
 * verification requests — and the decisions staff may take about each.
 *
 * Every action re-reads the organization afterwards rather than guessing the
 * new state, so two staff members working at once see what really happened.
 */
export default function AdminOrganizationPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:organization:read')}>
      <Detail />
    </AdminGate>
  );
}

function Detail() {
  const locale = useAdminLocale();
  const params = useParams();
  const organizationId = String(params.organizationId);
  const messages = getAdminMessages(locale);
  const labels = getOrganizationMessages(locale);
  const { globalPermissions } = useShell();
  const canVerify = globalPermissions.has('admin:organization:verify');
  const canSuspend = globalPermissions.has('admin:organization:suspend');

  const [detail, setDetail] = useState<AdminOrganizationDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await adminApi.organization(organizationId));
      setError(null);
    } catch (caught) {
      setError(describeAdminError(messages, caught).message);
    }
  }, [messages, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function after(message: string): Promise<void> {
    setDone(message);
    await load();
  }

  if (error !== null && detail === null) {
    return (
      <main className="pc-page">
        <PageHeader title={messages.nav.organizations} />
        <ErrorState title={error} />
      </main>
    );
  }
  if (detail === null) {
    return (
      <main className="pc-page">
        <LoadingState label={messages.common.loading} />
      </main>
    );
  }

  const organization = detail.organization;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = (value: string | null) =>
    value === null ? '—' : <time dateTime={value}>{when.format(new Date(value))}</time>;
  const pending = detail.verificationRequests.find((request) => request.status === 'PENDING');

  return (
    <main className="pc-page">
      <PageHeader
        title={organization.displayName}
        description={
          <span className="pc-tag-list">
            <StatusBadge
              status={organization.status}
              label={labels.statusLabels[organization.status] ?? organization.status}
            />
            <StatusBadge
              status={organization.verificationStatus}
              label={
                labels.verificationLabels[organization.verificationStatus] ??
                organization.verificationStatus
              }
            />
          </span>
        }
      />
      <FormSuccess message={done} />
      {error === null ? null : <ErrorState title={error} />}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section className="pc-card" aria-labelledby="org-verification-heading">
            <h2 id="org-verification-heading" className="pc-card-title">
              {messages.organization.verificationTitle}
            </h2>
            {pending === undefined ? null : (
              <div className="pc-alert pc-alert-warning">
                <p>{messages.organization.pendingRequest}</p>
                {canVerify ? (
                  <div className="pc-actions">
                    <ConfirmAction
                      locale={locale}
                      label={messages.organization.approve}
                      title={messages.organization.approve}
                      intro={messages.organization.approveIntro}
                      buttonClassName="pc-btn"
                      fields={[
                        {
                          name: 'decisionReason',
                          label: messages.organization.decisionReasonLabel,
                          hint: messages.organization.decisionReasonHint,
                          maxLength: 1000,
                          multiline: true,
                        },
                        {
                          name: 'internalNotes',
                          label: messages.organization.internalNotesLabel,
                          hint: messages.organization.internalNotesHint,
                          maxLength: 2000,
                          multiline: true,
                        },
                      ]}
                      onConfirm={async (values) => {
                        await adminApi.decideVerification(organizationId, {
                          approve: true,
                          ...optional('decisionReason', values),
                          ...optional('internalNotes', values),
                        });
                        await after(messages.organization.approved);
                      }}
                    />
                    <ConfirmAction
                      locale={locale}
                      label={messages.organization.reject}
                      title={messages.organization.reject}
                      intro={messages.organization.rejectIntro}
                      danger
                      fields={[
                        {
                          name: 'decisionReason',
                          label: messages.organization.decisionReasonLabel,
                          hint: messages.organization.decisionReasonHint,
                          maxLength: 1000,
                          multiline: true,
                          required: true,
                        },
                        {
                          name: 'internalNotes',
                          label: messages.organization.internalNotesLabel,
                          hint: messages.organization.internalNotesHint,
                          maxLength: 2000,
                          multiline: true,
                        },
                      ]}
                      onConfirm={async (values) => {
                        await adminApi.decideVerification(organizationId, {
                          approve: false,
                          ...optional('decisionReason', values),
                          ...optional('internalNotes', values),
                        });
                        await after(messages.organization.rejected);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            )}

            <h3 className="pc-subheading">{messages.organization.history}</h3>
            {detail.verificationRequests.length === 0 ? (
              <EmptyState
                icon="verified"
                title={messages.organization.noRequests}
                headingLevel={3}
              />
            ) : (
              <ol className="pc-timeline">
                {detail.verificationRequests.map((request) => (
                  <li key={request.id}>
                    <StatusBadge
                      status={request.status}
                      label={
                        messages.organization.requestStatuses[request.status] ?? request.status
                      }
                    />
                    <dl className="pc-summary">
                      <dt>{messages.organizations.requestedAt}</dt>
                      <dd>{date(request.requestedAt)}</dd>
                      {request.submissionNote === null ? null : (
                        <>
                          <dt>{messages.organization.submissionNote}</dt>
                          <dd>
                            <bdi>{request.submissionNote}</bdi>
                          </dd>
                        </>
                      )}
                      {request.reviewedAt === null ? null : (
                        <>
                          <dt>{messages.organization.reviewedAt}</dt>
                          <dd>{date(request.reviewedAt)}</dd>
                        </>
                      )}
                      {request.decisionReason === null ? null : (
                        <>
                          <dt>{messages.organization.decisionReason}</dt>
                          <dd>
                            <bdi>{request.decisionReason}</bdi>
                          </dd>
                        </>
                      )}
                      {request.internalNotes === undefined ||
                      request.internalNotes === null ? null : (
                        <>
                          <dt>{messages.organization.internalNotes}</dt>
                          <dd>
                            <bdi>{request.internalNotes}</bdi>
                          </dd>
                        </>
                      )}
                    </dl>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="pc-detail-side">
          <section className="pc-card" aria-labelledby="org-profile-heading">
            <h2 id="org-profile-heading" className="pc-card-title">
              {messages.organization.profile}
            </h2>
            <dl className="pc-summary">
              <dt>{messages.organization.legalName}</dt>
              <dd>
                <bdi>{organization.legalName}</bdi>
              </dd>
              <dt>{messages.organizations.type}</dt>
              <dd>{labels.typeLabels[organization.type] ?? organization.type}</dd>
              <dt>{messages.organizations.country}</dt>
              <dd dir="ltr" className="pc-ltr">
                {organization.countryCode}
              </dd>
              <dt>{messages.organization.slug}</dt>
              <dd>
                <code dir="ltr">{organization.slug}</code>
              </dd>
              <dt>{messages.organization.website}</dt>
              <dd>
                {organization.website === null ? (
                  '—'
                ) : (
                  <span dir="ltr" className="pc-ltr">
                    {organization.website}
                  </span>
                )}
              </dd>
              <dt>{messages.organization.members}</dt>
              <dd>{new Intl.NumberFormat(locale).format(organization.memberCount)}</dd>
              <dt>{messages.organizations.created}</dt>
              <dd>{date(organization.createdAt)}</dd>
              <dt>{messages.organization.updated}</dt>
              <dd>{date(organization.updatedAt)}</dd>
            </dl>
          </section>

          <section className="pc-card" aria-labelledby="org-standing-heading">
            <h2 id="org-standing-heading" className="pc-card-title">
              {messages.organization.standing}
            </h2>
            <dl className="pc-summary">
              <dt>{messages.organizations.status}</dt>
              <dd>
                <StatusBadge
                  status={organization.status}
                  label={labels.statusLabels[organization.status] ?? organization.status}
                />
              </dd>
              {detail.suspendedAt === null ? null : (
                <>
                  <dt>{messages.organization.suspendedAt}</dt>
                  <dd>{date(detail.suspendedAt)}</dd>
                </>
              )}
              {detail.suspensionReason === null ? null : (
                <>
                  <dt>{messages.organization.suspensionReason}</dt>
                  <dd>
                    <bdi>{detail.suspensionReason}</bdi>
                  </dd>
                </>
              )}
            </dl>
            {organization.status === 'CLOSED' ? (
              <p className="pc-hint">{messages.organization.closedNote}</p>
            ) : canSuspend ? (
              <div className="pc-actions">
                {organization.status === 'ACTIVE' ? (
                  <ConfirmAction
                    locale={locale}
                    label={messages.organization.suspend}
                    title={messages.organization.suspend}
                    intro={messages.organization.suspendIntro}
                    danger
                    fields={[
                      {
                        name: 'reason',
                        label: messages.organization.suspendReason,
                        maxLength: 500,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) => {
                      await adminApi.suspendOrganization(organizationId, values['reason']);
                      await after(messages.organization.suspended);
                    }}
                  />
                ) : (
                  <ConfirmAction
                    locale={locale}
                    label={messages.organization.reactivate}
                    title={messages.organization.reactivate}
                    intro={messages.organization.reactivateIntro}
                    onConfirm={async () => {
                      await adminApi.reactivateOrganization(organizationId);
                      await after(messages.organization.reactivated);
                    }}
                  />
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

/** A field the person left empty is not sent at all. */
function optional(
  name: 'decisionReason' | 'internalNotes',
  values: Readonly<Record<string, string>>,
): Partial<Record<typeof name, string>> {
  const value = values[name]?.trim() ?? '';
  return value === '' ? {} : { [name]: value };
}
