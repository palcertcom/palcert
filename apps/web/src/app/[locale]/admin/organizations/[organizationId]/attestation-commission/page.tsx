'use client';

import type { AttestationCommissionView } from '@palcert/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, ReauthNotice, useAdminLocale } from '@/components/admin/admin-kit';
import { describeAttestationError, formatDate } from '@/components/attestation';
import { AttestationRevenue } from '@/components/attestation-revenue';
import { FormError } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { attestationAdminApi } from '@/lib/attestations-api';

/** 0–100 with at most two decimals, as the API accepts it. The API decides; this only helps. */
function isCommissionPercent(value: string): boolean {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return false;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps >= 0 && bps <= 10_000;
}

/**
 * PalCert's commission for one institution, with its history.
 *
 * A change is a new row, never an edit, and applies to requests submitted
 * from its effective time; every earlier request keeps the rate it was
 * priced at.
 */
export default function AttestationCommissionPage() {
  return (
    <AdminGate
      allowed={(can) =>
        can.has('admin:attestation-finance:read') || can.has('admin:attestation-commission:manage')
      }
    >
      <Commission />
    </AdminGate>
  );
}

function Commission() {
  const locale = useAdminLocale();
  const params = useParams();
  const organizationId = String(params.organizationId);
  const messages = getAttestationsMessages(locale);
  const a = messages.admin;
  const { globalPermissions } = useShell();
  const canManage = globalPermissions.has('admin:attestation-commission:manage');
  const canReadFinance = globalPermissions.has('admin:attestation-finance:read');

  const [view, setView] = useState<AttestationCommissionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await attestationAdminApi.commission(organizationId));
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }, [organizationId, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pc-page">
      <Link className="pc-back-link" href={`/${locale}/admin/attestations`}>
        {a.financeTitle}
      </Link>
      <PageHeader title={a.commissionTitle} description={a.commissionIntro} />
      {error === null ? null : <FormError message={error} />}
      {view === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          <section className="pc-card" data-testid="commission-current">
            <h2 className="pc-card-title">{a.current}</h2>
            <p className="pc-admin-figure-value" dir="ltr" data-testid="commission-percent">
              {view.currentPercent}%
            </p>
            <p className="pc-hint">
              {view.isDefault
                ? a.defaultRate
                : `${a.effectiveFrom}: ${formatDate(view.currentEffectiveFrom, locale, true)}`}
            </p>
            {canManage ? (
              <ConfirmAction
                labels={{
                  cancel: messages.cancel,
                  close: messages.close,
                  optional: messages.optional,
                  pending: messages.saving,
                  invalid: messages.required,
                }}
                describeError={(caught) => ({
                  message: describeAttestationError(messages, caught),
                  reauth: caught instanceof ApiError && caught.code === 'REAUTHENTICATION_REQUIRED',
                })}
                reauthNotice={<ReauthNotice locale={locale} />}
                label={a.newRate}
                title={a.newRate}
                intro={a.commissionIntro}
                confirmLabel={a.setRate}
                buttonClassName="pc-btn"
                fields={[
                  {
                    name: 'percent',
                    label: a.percent,
                    hint: a.percentHint,
                    maxLength: 6,
                    required: true,
                    inputMode: 'decimal',
                    ltr: true,
                    validate: (value) => (isCommissionPercent(value) ? null : a.percentInvalid),
                  },
                  {
                    name: 'reason',
                    label: a.reason,
                    hint: a.reasonHint,
                    maxLength: 500,
                    required: true,
                    multiline: true,
                  },
                  {
                    name: 'effectiveFrom',
                    label: a.effectiveFrom,
                    hint: a.effectiveFromHint,
                    maxLength: 40,
                    ltr: true,
                  },
                ]}
                onConfirm={async (values) => {
                  const effective = (values['effectiveFrom'] ?? '').trim();
                  setView(
                    await attestationAdminApi.setCommission(organizationId, {
                      percent: (values['percent'] ?? '').trim(),
                      reason: (values['reason'] ?? '').trim(),
                      ...(effective === ''
                        ? {}
                        : { effectiveFrom: new Date(effective).toISOString() }),
                    }),
                  );
                }}
              />
            ) : null}
          </section>

          <section className="pc-card">
            <h2 className="pc-card-title">{a.history}</h2>
            {view.history.length === 0 ? (
              <p className="pc-hint">{a.defaultRate}</p>
            ) : (
              <DataTable
                caption={a.history}
                rows={view.history}
                rowKey={(row) => row.id}
                columns={[
                  {
                    key: 'percent',
                    header: a.percent,
                    primary: true,
                    cell: (row) => <span dir="ltr">{row.percent}%</span>,
                  },
                  {
                    key: 'effective',
                    header: a.effectiveFrom,
                    cell: (row) => formatDate(row.effectiveFrom, locale, true),
                  },
                  { key: 'reason', header: a.reason, cell: (row) => <bdi>{row.changeReason}</bdi> },
                  {
                    key: 'by',
                    header: a.changedBy,
                    cell: (row) => <bdi>{row.changedByName ?? row.changedByUserId}</bdi>,
                  },
                  {
                    key: 'at',
                    header: a.changedAt,
                    cell: (row) => formatDate(row.createdAt, locale, true),
                  },
                ]}
              />
            )}
          </section>

          {canReadFinance ? (
            <section className="pc-card">
              <h2 className="pc-card-title">{messages.revenue.title}</h2>
              <AttestationRevenue
                locale={locale}
                messages={messages}
                load={(query) => attestationAdminApi.organizationRevenue(organizationId, query)}
              />
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
