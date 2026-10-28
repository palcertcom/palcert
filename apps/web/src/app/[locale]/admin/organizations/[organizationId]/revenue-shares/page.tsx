'use client';
import type { OrganizationRevenueSharesView } from '@palcert/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AdminGate, ReauthNotice, useAdminLocale } from '@/components/admin/admin-kit';
import { useShell } from '@/components/shell/shell-context';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { PageHeader } from '@/components/ui/page-header';
import { FormError } from '@/components/auth-form';
import { ServiceRevenue } from '@/components/service-revenue';
import { revenueMessages } from '@/i18n/revenue-sharing-messages';
import { revenueSharingApi } from '@/lib/revenue-sharing-api';
import { ApiError } from '@/lib/api-client';

export default function RevenueSharesPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:revenue-share:read')}>
      <Shares />
    </AdminGate>
  );
}
function validPercent(value: string): boolean {
  return /^\d{1,3}(\.\d{1,2})?$/.test(value.trim()) && Number(value) <= 100;
}
function Shares() {
  const locale = useAdminLocale();
  const { organizationId } = useParams<{ organizationId: string }>();
  const { globalPermissions } = useShell();
  const canManage = globalPermissions.has('admin:revenue-share:manage');
  const m = revenueMessages(locale);
  const [view, setView] = useState<OrganizationRevenueSharesView | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void revenueSharingApi
      .rates(organizationId)
      .then((result) => {
        if (active) setView(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  return (
    <main className="pc-page">
      <Link className="pc-back-link" href={`/${locale}/admin/organizations/${organizationId}`}>
        {view?.organizationName ?? organizationId}
      </Link>
      <PageHeader title={m.title} description={m.intro} />
      <p className="pc-hint">{m.example}</p>
      {error && <FormError message={m.error} />}
      {!view && !error && <p role="status">{m.loading}</p>}
      {view?.rates.map((rate) => (
        <section className="pc-card" key={rate.serviceCode}>
          <h2>{m.services[rate.serviceCode]}</h2>
          <p>
            {m.institution}: <bdi>{rate.institutionPercent}%</bdi> · {m.platform}:{' '}
            <bdi>{rate.platformPercent}%</bdi>
          </p>
          <p className="pc-hint">
            {rate.isDefault
              ? m.default
              : `${m.effective}: ${new Date(rate.effectiveFrom!).toLocaleString(locale)}`}
          </p>
          {canManage && (
            <ConfirmAction
              label={m.edit}
              title={`${m.edit}: ${m.services[rate.serviceCode]}`}
              intro={m.intro}
              confirmLabel={m.save}
              buttonClassName="pc-btn"
              labels={{
                cancel: m.cancel,
                close: m.close,
                optional: m.optional,
                pending: m.pending,
                invalid: m.invalid,
              }}
              describeError={(caught) => ({
                message: caught instanceof ApiError ? caught.message : m.error,
                reauth: caught instanceof ApiError && caught.code === 'REAUTHENTICATION_REQUIRED',
              })}
              reauthNotice={<ReauthNotice locale={locale} />}
              fields={[
                {
                  name: 'institutionPercent',
                  label: m.percent,
                  hint: m.hint,
                  required: true,
                  inputMode: 'decimal',
                  ltr: true,
                  maxLength: 6,
                  validate: (value) => (validPercent(value) ? null : m.invalid),
                },
                {
                  name: 'reason',
                  label: m.reason,
                  required: true,
                  multiline: true,
                  maxLength: 500,
                },
                {
                  name: 'effectiveFrom',
                  label: m.effective,
                  hint: m.effectiveHint,
                  maxLength: 40,
                  ltr: true,
                },
              ]}
              onConfirm={async (values) => {
                const effectiveFrom = values['effectiveFrom']?.trim();
                setView(
                  await revenueSharingApi.set(organizationId, rate.serviceCode, {
                    institutionPercent: values['institutionPercent']!.trim(),
                    reason: values['reason']!.trim(),
                    ...(effectiveFrom
                      ? { effectiveFrom: new Date(effectiveFrom).toISOString() }
                      : {}),
                  }),
                );
              }}
            />
          )}
          {rate.history.length > 0 && (
            <details>
              <summary>{m.history}</summary>
              <ul>
                {rate.history.map((row) => (
                  <li key={row.id}>
                    <bdi>{row.institutionPercent}%</bdi> —{' '}
                    {new Date(row.effectiveFrom).toLocaleString(locale)} —{' '}
                    <bdi>{row.changeReason}</bdi> · {m.by}: <bdi>{row.changedByUserId}</bdi>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
      {view && <ServiceRevenue organizationId={organizationId} locale={locale} admin />}
    </main>
  );
}
