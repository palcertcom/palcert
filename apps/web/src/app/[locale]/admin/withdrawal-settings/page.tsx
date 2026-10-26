'use client';

import type {
  WithdrawalPolicyView,
  WithdrawalReconciliationView,
  WithdrawalReviewerCandidateView,
  WithdrawalReviewerView,
} from '@palcert/contracts/finance/withdrawals';
import { WITHDRAWAL_CURRENCIES } from '@palcert/contracts/finance/withdrawals';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, ReauthNotice, useAdminLocale } from '@/components/admin/admin-kit';
import { Amount, describeWithdrawalError } from '@/components/withdrawal';
import { useShell } from '@/components/shell/shell-context';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { toMinorUnits } from '@/lib/money';
import { withdrawalSettingsApi } from '@/lib/withdrawals-api';

/**
 * Withdrawal settings (spec §19, §28, §38; D3, D4): clearing periods, limits,
 * reviewer assignment and the report-only consistency check. No fee setting
 * exists, because v1 charges none.
 */
export default function WithdrawalSettingsPage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:withdrawal:read')}>
      <Settings />
    </AdminGate>
  );
}

function Settings() {
  const locale = useAdminLocale();
  const messages = getWithdrawalMessages(locale);
  const s = messages.settings;
  const { globalPermissions: can } = useShell();
  const canManage = can.has('admin:withdrawal-policy:manage');
  const [policy, setPolicy] = useState<WithdrawalPolicyView | null>(null);
  const [userDays, setUserDays] = useState('');
  const [orgDays, setOrgDays] = useState('');
  const [limitCurrency, setLimitCurrency] = useState(WITHDRAWAL_CURRENCIES[0] ?? 'USD');
  const [limitMin, setLimitMin] = useState('');
  const [limitMax, setLimitMax] = useState('');
  const [reviewers, setReviewers] = useState<WithdrawalReviewerView[]>([]);
  const [candidates, setCandidates] = useState<WithdrawalReviewerCandidateView[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<WithdrawalReconciliationView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; reauth: boolean } | null>(null);

  const fail = (caught: unknown) => setFailure(describeWithdrawalError(messages, caught));

  const load = useCallback(async () => {
    try {
      const [current, assigned] = await Promise.all([
        withdrawalSettingsApi.policy(),
        withdrawalSettingsApi.reviewers(),
      ]);
      setPolicy(current);
      setUserDays(String(current.userManualTopUpClearingDays));
      setOrgDays(String(current.organizationClearingDays));
      setReviewers(assigned);
      setChosen(new Set(assigned.map((reviewer) => reviewer.userId)));
      if (canManage) setCandidates(await withdrawalSettingsApi.candidates());
    } catch (caught) {
      fail(caught);
    }
  }, [canManage, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  if (policy === null) {
    return (
      <main className="pc-page">
        <PageHeader title={s.title} />
        {failure === null ? (
          <LoadingState label={messages.loading} />
        ) : (
          <p className="pc-error" role="alert">
            {failure.message}
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="pc-page">
      <PageHeader title={s.title} description={s.intro} />
      {failure === null ? null : failure.reauth ? (
        <ReauthNotice locale={locale} />
      ) : (
        <p className="pc-error" role="alert">
          {failure.message}
        </p>
      )}
      {notice === null ? null : (
        <p className="pc-alert pc-alert-success" role="status">
          {notice}
        </p>
      )}
      {canManage ? null : <p className="pc-hint">{s.readOnly}</p>}

      <section className="pc-card" aria-labelledby="clearing-periods">
        <h2 id="clearing-periods">{s.policyTitle}</h2>
        <form
          className="pc-form"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            void withdrawalSettingsApi
              .updatePolicy({
                userManualTopUpClearingDays: Number(userDays),
                organizationClearingDays: Number(orgDays),
                expectedVersion: policy.version,
              })
              .then((next) => {
                setPolicy(next);
                setFailure(null);
                setNotice(s.saved);
              })
              .catch(fail);
          }}
        >
          <div className="pc-field">
            <label htmlFor="user-days">{s.userDays}</label>
            <input
              id="user-days"
              type="number"
              min={0}
              max={90}
              inputMode="numeric"
              dir="ltr"
              value={userDays}
              disabled={!canManage}
              onChange={(event) => setUserDays(event.target.value)}
            />
            <span className="pc-hint">{s.userDaysHint}</span>
          </div>
          <div className="pc-field">
            <label htmlFor="org-days">{s.organizationDays}</label>
            <input
              id="org-days"
              type="number"
              min={0}
              max={180}
              inputMode="numeric"
              dir="ltr"
              value={orgDays}
              disabled={!canManage}
              onChange={(event) => setOrgDays(event.target.value)}
            />
            <span className="pc-hint">{s.organizationDaysHint}</span>
          </div>
          <p className="pc-hint">{s.feeNone}</p>
          {canManage ? (
            <div className="pc-actions">
              <button type="submit" className="pc-btn pc-btn-primary">
                {s.save}
              </button>
            </div>
          ) : null}
        </form>
      </section>

      <section className="pc-card" aria-labelledby="withdrawal-limits">
        <h2 id="withdrawal-limits">{s.limitsTitle}</h2>
        <p className="pc-hint">{s.limitsIntro}</p>
        {policy.limits.length === 0 ? (
          <p className="pc-hint">{s.noLimit}</p>
        ) : (
          <DataTable<WithdrawalPolicyView['limits'][number]>
            caption={s.limitsCaption}
            rows={policy.limits}
            rowKey={(row) => row.currency}
            columns={[
              {
                key: 'currency',
                header: s.limitCurrency,
                primary: true,
                cell: (row) => <span className="pc-ltr">{row.currency}</span>,
              },
              {
                key: 'min',
                header: s.limitMinimum,
                align: 'end',
                cell: (row) =>
                  row.minimum === null ? (
                    s.noLimit
                  ) : (
                    <Amount amount={row.minimum} locale={locale} />
                  ),
              },
              {
                key: 'max',
                header: s.limitMaximum,
                align: 'end',
                cell: (row) =>
                  row.maximum === null ? (
                    s.noLimit
                  ) : (
                    <Amount amount={row.maximum} locale={locale} />
                  ),
              },
            ]}
          />
        )}
        {canManage ? (
          <form
            className="pc-withdrawal-filters"
            onSubmit={(event) => {
              event.preventDefault();
              const min = limitMin.trim() === '' ? null : toMinorUnits(limitMin, limitCurrency);
              const max = limitMax.trim() === '' ? null : toMinorUnits(limitMax, limitCurrency);
              if (
                (limitMin.trim() !== '' && min === null) ||
                (limitMax.trim() !== '' && max === null)
              ) {
                setFailure({ message: messages.form.invalidAmount, reauth: false });
                return;
              }
              void withdrawalSettingsApi
                .setLimit(limitCurrency, min, max)
                .then((next) => {
                  setPolicy(next);
                  setFailure(null);
                  setNotice(s.saved);
                })
                .catch(fail);
            }}
          >
            <div className="pc-field">
              <label htmlFor="limit-currency">{s.limitCurrency}</label>
              <select
                id="limit-currency"
                value={limitCurrency}
                onChange={(event) => setLimitCurrency(event.target.value)}
              >
                {WITHDRAWAL_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div className="pc-field">
              <label htmlFor="limit-min">{s.limitMinimum}</label>
              <input
                id="limit-min"
                inputMode="decimal"
                dir="ltr"
                value={limitMin}
                placeholder={s.noLimit}
                onChange={(event) => setLimitMin(event.target.value)}
              />
            </div>
            <div className="pc-field">
              <label htmlFor="limit-max">{s.limitMaximum}</label>
              <input
                id="limit-max"
                inputMode="decimal"
                dir="ltr"
                value={limitMax}
                placeholder={s.noLimit}
                onChange={(event) => setLimitMax(event.target.value)}
              />
            </div>
            <div className="pc-actions">
              <button type="submit" className="pc-btn pc-btn-secondary">
                {s.saveLimit}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="pc-card" aria-labelledby="withdrawal-reviewers">
        <h2 id="withdrawal-reviewers">{s.reviewersTitle}</h2>
        <p className="pc-hint">{s.reviewersIntro}</p>
        <p className="pc-hint">{s.reviewersEmptyMeansAll}</p>
        {canManage ? (
          candidates.length === 0 ? (
            <p className="pc-hint">{s.noCandidates}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void withdrawalSettingsApi
                  .replaceReviewers([...chosen])
                  .then((next) => {
                    setReviewers(next);
                    setFailure(null);
                    setNotice(s.saved);
                  })
                  .catch(fail);
              }}
            >
              <fieldset
                className="pc-topup-reviewer-picker"
                data-testid="withdrawal-reviewer-picker"
              >
                <legend>{s.reviewersTitle}</legend>
                <ul className="pc-topup-reviewer-options" role="list">
                  {candidates.map((candidate) => {
                    const id = `withdrawal-reviewer-${candidate.userId}`;
                    return (
                      <li key={candidate.userId}>
                        <input
                          type="checkbox"
                          id={id}
                          checked={chosen.has(candidate.userId)}
                          onChange={(event) =>
                            setChosen((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(candidate.userId);
                              else next.delete(candidate.userId);
                              return next;
                            })
                          }
                        />
                        <label htmlFor={id}>
                          <span className="pc-topup-reviewer-name" dir="auto">
                            {candidate.displayName ?? candidate.email}
                          </span>
                          <span className="pc-topup-reviewer-meta">
                            <span className="pc-ltr">{candidate.email}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <div className="pc-actions">
                <button type="submit" className="pc-btn pc-btn-secondary">
                  {s.saveReviewers}
                </button>
              </div>
            </form>
          )
        ) : null}
        {reviewers.length === 0 ? null : (
          <ul role="list">
            {reviewers.map((reviewer) => (
              <li key={reviewer.userId}>
                <span dir="auto">{reviewer.displayName ?? reviewer.email}</span>{' '}
                <span className="pc-hint">— {reviewer.eligible ? s.eligible : s.notEligible}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pc-card" aria-labelledby="withdrawal-reconciliation">
        <h2 id="withdrawal-reconciliation">{s.reconciliationTitle}</h2>
        <p className="pc-hint">{s.reconciliationIntro}</p>
        <button
          type="button"
          className="pc-btn pc-btn-secondary"
          onClick={() => {
            void withdrawalSettingsApi.reconcile().then(setReport).catch(fail);
          }}
        >
          {s.runReconciliation}
        </button>
        {report === null ? null : report.consistent ? (
          <p className="pc-alert pc-alert-success" role="status">
            {s.consistent(String(report.requestsChecked))}
          </p>
        ) : (
          <>
            <p className="pc-alert pc-alert-warning" role="status">
              {s.findingsTitle(String(report.findings.length))}
            </p>
            <DataTable<WithdrawalReconciliationView['findings'][number]>
              caption={s.findingsCaption}
              rows={report.findings}
              rowKey={(row) => `${row.code}:${row.subjectId}`}
              columns={[
                {
                  key: 'code',
                  header: s.findingColumns.code,
                  primary: true,
                  cell: (row) => <span className="pc-ltr">{row.code}</span>,
                },
                { key: 'detail', header: s.findingColumns.detail, cell: (row) => row.detail },
                {
                  key: 'subject',
                  header: s.findingColumns.subject,
                  cell: (row) => <span className="pc-ltr">{row.subjectId}</span>,
                },
              ]}
            />
          </>
        )}
      </section>
    </main>
  );
}
