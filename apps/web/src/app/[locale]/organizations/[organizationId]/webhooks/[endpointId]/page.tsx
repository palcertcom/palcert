'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { WebhookSecretPanel } from '@/components/webhook-secret';
import { getWebhooksMessages, webhookLabel } from '@/i18n/webhooks-messages';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  webhooksApi,
  type WebhookAttemptResponse,
  type WebhookConfigVersionResponse,
  type WebhookDeliveryResponse,
  type WebhookEndpointResponse,
  type WebhookOperationResponse,
  type WebhookRotationPendingResponse,
  type WebhookSecretResponse,
  type WebhookVerificationAttemptResponse,
} from '@/lib/api-client';

const EVENT_TYPES = [
  'submission.ready',
  'submission.revision_ready',
  'submission.under_review',
  'submission.approved',
  'submission.rejected',
  'submission.revision_requested',
  'submission.comment_added',
  'certificate.issued',
  'certificate.revoked',
] as const;

/**
 * One endpoint, and everything an administrator does to it.
 *
 * The rotation warning is not a tooltip. Deliveries already scheduled keep the
 * configuration they were created with, so a receiver that retires the old
 * secret as soon as it sees a new one drops real events — and the count of
 * traffic still on the old configuration is the number to wait for, which is
 * why it is on the screen rather than in the documentation.
 */
export default function WebhookEndpointPage() {
  const endpointId = useParams().endpointId;

  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) => (
        <EndpointDetail
          organizationId={organizationId}
          endpointId={typeof endpointId === 'string' ? endpointId : ''}
          locale={locale}
          canManage={permissions.has('integration:webhook:manage')}
          canRotate={permissions.has('integration:webhook:secret:rotate')}
          canReplay={permissions.has('integration:webhook:replay')}
        />
      )}
    </OrganizationShell>
  );
}

function EndpointDetail({
  organizationId,
  endpointId,
  locale,
  canManage,
  canRotate,
  canReplay,
}: {
  organizationId: string;
  endpointId: string;
  locale: Locale;
  canManage: boolean;
  canRotate: boolean;
  canReplay: boolean;
}) {
  const messages = getWebhooksMessages(locale);
  // One key per action, held across retries of the *same* action. Verify, test
  // and rotate have no body, so pressing the button again is always the same
  // request; the URL update and a replay are keyed on what they name.
  const verifyKey = useIdempotencyKey();
  const urlKey = useIdempotencyKey();
  const testKey = useIdempotencyKey();
  const rotateKey = useIdempotencyKey();
  const replayKey = useIdempotencyKey();

  const [endpoint, setEndpoint] = useState<WebhookEndpointResponse | null>(null);
  const [deliveries, setDeliveries] = useState<readonly WebhookDeliveryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<readonly WebhookAttemptResponse[]>([]);
  const [openDelivery, setOpenDelivery] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<readonly WebhookVerificationAttemptResponse[]>(
    [],
  );
  const [versions, setVersions] = useState<readonly WebhookConfigVersionResponse[]>([]);
  const [operations, setOperations] = useState<readonly WebhookOperationResponse[]>([]);
  const [name, setName] = useState('');
  const [rotation, setRotation] = useState<WebhookRotationPendingResponse | null>(null);
  const [secret, setSecret] = useState<WebhookSecretResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);

  function describe(caught: unknown): string {
    if (caught instanceof ApiError) return messages.errors[caught.code] ?? messages.genericError;
    return messages.genericError;
  }

  async function load(): Promise<void> {
    try {
      const [detail, page, history, configs, pending, log] = await Promise.all([
        webhooksApi.getEndpoint(organizationId, endpointId),
        webhooksApi.deliveries(organizationId, { endpointId }),
        webhooksApi.verificationAttempts(organizationId, endpointId),
        webhooksApi.configVersions(organizationId, endpointId),
        webhooksApi.rotationPending(organizationId, endpointId),
        webhooksApi.operations(organizationId, endpointId),
      ]);
      setEndpoint(detail);
      setChosen(detail.subscribedEventTypes);
      setDeliveries(page.items);
      setCursor(page.nextCursor);
      setVerifications(history);
      setVersions(configs);
      setRotation(pending);
      setOperations(log);
      setName(detail.description);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  useEffect(() => {
    void load();
    // Keyed on the ids the load actually depends on; `load` itself is
    // recreated every render and would refetch on each one.
  }, [organizationId, endpointId]);

  async function run(work: () => Promise<string | null>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await load();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  if (endpoint === null) {
    return error !== null ? (
      <FormError message={error} />
    ) : (
      <LoadingState label={messages.loading} />
    );
  }

  const disabled = endpoint.status === 'DISABLED';
  const dash = (value: string | number | null) => (value === null ? '—' : value);

  const deliveryColumns: DataColumn<(typeof deliveries)[number]>[] = [
    {
      key: 'event',
      header: messages.columnEvent,
      primary: true,
      cell: (delivery) =>
        delivery.eventType === null
          ? delivery.kind
          : webhookLabel(messages.eventTypes, delivery.eventType),
    },
    {
      key: 'status',
      header: messages.columnStatus,
      cell: (delivery) => (
        <StatusBadge
          status={delivery.status}
          label={webhookLabel(messages.deliveryStatuses, delivery.status)}
        />
      ),
    },
    {
      key: 'attempts',
      header: messages.columnAttempts,
      align: 'end',
      cell: (delivery) => delivery.attemptCount,
    },
    {
      key: 'error',
      header: messages.columnError,
      cell: (delivery) => <code>{dash(delivery.lastErrorCode)}</code>,
    },
    {
      key: 'http',
      header: messages.columnHttp,
      align: 'end',
      cell: (delivery) => dash(delivery.responseStatusCode),
    },
    {
      key: 'actions',
      header: messages.attemptsTitle,
      align: 'end',
      cell: (delivery) => (
        <div className="pc-row-actions">
          <button
            type="button"
            className="pc-btn pc-btn-secondary pc-btn-sm"
            onClick={() =>
              void run(async () => {
                setAttempts(await webhooksApi.attempts(organizationId, delivery.id));
                setOpenDelivery(delivery.id);
                return null;
              })
            }
          >
            {messages.attemptsTitle}
          </button>
          {canReplay && delivery.kind !== 'TEST' && (
            <button
              type="button"
              className="pc-btn pc-btn-secondary pc-btn-sm"
              onClick={() =>
                void run(async () => {
                  await webhooksApi.replay(
                    organizationId,
                    delivery.id,
                    replayKey.keyFor(delivery.id),
                  );
                  replayKey.reset();
                  return messages.replayAccepted;
                })
              }
            >
              {messages.replay}
            </button>
          )}
        </div>
      ),
    },
  ];

  const attemptColumns: DataColumn<(typeof attempts)[number]>[] = [
    { key: 'n', header: '#', primary: true, cell: (attempt) => attempt.attemptNumber },
    { key: 'outcome', header: messages.columnStatus, cell: (attempt) => dash(attempt.outcome) },
    {
      key: 'error',
      header: messages.columnError,
      cell: (attempt) => <code>{dash(attempt.errorCode)}</code>,
    },
    {
      key: 'http',
      header: messages.columnHttp,
      align: 'end',
      cell: (attempt) => dash(attempt.responseStatusCode),
    },
    {
      key: 'duration',
      header: messages.columnDuration,
      align: 'end',
      cell: (attempt) => (attempt.durationMs === null ? '—' : `${attempt.durationMs} ms`),
    },
  ];

  return (
    <>
      <p className="pc-back-link">
        <Link href={`/${locale}/organizations/${organizationId}/webhooks`}>{messages.title}</Link>
      </p>
      <PageHeader title={<bdi>{endpoint.description}</bdi>} />
      {error !== null && <FormError message={error} />}
      {notice !== null && (
        <p className="pc-alert pc-alert-success" role="status">
          {notice}
        </p>
      )}

      {/* The signing secret, shown once, at the top. */}
      {secret !== null && (
        <WebhookSecretPanel
          locale={locale}
          secret={secret}
          onDismiss={() => {
            setSecret(null);
          }}
        />
      )}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          {endpoint.pendingConfig !== null && (
            <section className="pc-card pc-pending-card" aria-labelledby="pending-heading">
              <h2 id="pending-heading" className="pc-card-title">
                {messages.pendingTitle}
              </h2>
              <p>{messages.pendingIntro}</p>
              <p data-testid="pending-destination" className="pc-ltr" dir="ltr">
                {endpoint.pendingConfig.destination}
              </p>
              <p className="pc-hint">
                {messages.lastVerificationError}:{' '}
                {endpoint.pendingConfig.lastVerificationError ?? messages.never}
              </p>
              {canManage && (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await webhooksApi.verify(
                        organizationId,
                        endpointId,
                        verifyKey.keyFor(endpoint.pendingConfig?.configVersionId ?? endpointId),
                      );
                      verifyKey.reset();
                      return messages.verifyAccepted;
                    })
                  }
                >
                  {endpoint.pendingConfig.lastVerificationError === null
                    ? messages.verify
                    : messages.verifyAgain}
                </button>
              )}
            </section>
          )}

          <section aria-labelledby="deliveries-heading">
            <h2 id="deliveries-heading">{messages.deliveriesTitle}</h2>
            {deliveries.length === 0 ? (
              <p className="pc-empty">{messages.noHistory}</p>
            ) : (
              <DataTable
                caption={messages.deliveriesTitle}
                columns={deliveryColumns}
                rows={deliveries}
                rowKey={(delivery) => delivery.id}
              />
            )}
            {cursor !== null && (
              <div className="pc-list-footer">
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      const page = await webhooksApi.deliveries(organizationId, {
                        endpointId,
                        cursor,
                      });
                      setDeliveries((current) => [...current, ...page.items]);
                      setCursor(page.nextCursor);
                      return null;
                    })
                  }
                >
                  {messages.loadMore}
                </button>
              </div>
            )}
          </section>

          {openDelivery !== null && (
            <section aria-labelledby="attempts-heading">
              <h2 id="attempts-heading">{messages.attemptsTitle}</h2>
              <DataTable
                caption={messages.attemptsTitle}
                columns={attemptColumns}
                rows={attempts}
                rowKey={(attempt) => attempt.id}
              />
            </section>
          )}

          <section className="pc-card" aria-labelledby="verification-heading">
            <h2 id="verification-heading" className="pc-card-title">
              {messages.verificationHistoryTitle}
            </h2>
            {verifications.length === 0 ? (
              <p className="pc-hint">{messages.noHistory}</p>
            ) : (
              <ol className="pc-timeline">
                {verifications.map((attempt) => (
                  <li key={attempt.id}>
                    <strong>#{attempt.attemptNumber}</strong> {dash(attempt.outcome)}{' '}
                    <code>{dash(attempt.errorCode)}</code>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="pc-card" aria-labelledby="operations-heading">
            <h2 id="operations-heading" className="pc-card-title">
              {messages.operationsTitle}
            </h2>
            <p className="pc-hint">{messages.operationsIntro}</p>
            {operations.length === 0 ? (
              <p className="pc-hint">{messages.noHistory}</p>
            ) : (
              <ol className="pc-timeline" data-testid="operations-log">
                {operations.map((operation) => (
                  <li key={operation.id}>
                    <strong>{webhookLabel(messages.operationKinds, operation.operation)}</strong>{' '}
                    <time dateTime={operation.createdAt}>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(operation.createdAt))}
                    </time>{' '}
                    {operation.settledAt === null
                      ? messages.operationPending
                      : messages.operationSettled}
                    {operation.settledErrorCode === null ? null : (
                      <>
                        {' '}
                        <code>{operation.settledErrorCode}</code>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="pc-card" aria-labelledby="configs-heading">
            <h2 id="configs-heading" className="pc-card-title">
              {messages.configHistoryTitle}
            </h2>
            <ol className="pc-timeline">
              {versions.map((version) => (
                <li key={version.id}>
                  <strong>v{version.configVersion}</strong>{' '}
                  {webhookLabel(messages.configStatuses, version.status)}{' '}
                  <span className="pc-ltr" dir="ltr">
                    {version.destination}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="pc-detail-side">
          <section className="pc-card" aria-labelledby="endpoint-facts-heading">
            <h2 id="endpoint-facts-heading" className="pc-card-title">
              {messages.statusLabel}
            </h2>
            <p data-testid="endpoint-status">
              <StatusBadge
                status={endpoint.status}
                label={webhookLabel(messages.endpointStatuses, endpoint.status)}
              />
            </p>
            <dl className="pc-summary">
              <dt>{messages.destination}</dt>
              <dd data-testid="endpoint-destination">
                {endpoint.destination === '' ? (
                  messages.noDestination
                ) : (
                  <span dir="ltr" className="pc-ltr">
                    {endpoint.destination}
                  </span>
                )}
              </dd>
              <dt>{messages.configVersion}</dt>
              <dd>{endpoint.configVersion}</dd>
            </dl>
            <p className="pc-hint">{messages.destinationHint}</p>
          </section>

          {canManage && !disabled && (
            <section className="pc-card" aria-labelledby="actions-heading">
              <h2 id="actions-heading" className="pc-card-title">
                {messages.detailTitle}
              </h2>

              <div className="pc-actions">
                {endpoint.status === 'ACTIVE' && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(async () => {
                        await webhooksApi.lifecycle(organizationId, endpointId, 'pause');
                        return null;
                      })
                    }
                  >
                    {messages.pause}
                  </button>
                )}
                {endpoint.status === 'PAUSED' && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(async () => {
                        await webhooksApi.lifecycle(organizationId, endpointId, 'resume');
                        return null;
                      })
                    }
                  >
                    {messages.resume}
                  </button>
                )}
                {endpoint.status === 'ACTIVE' && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(async () => {
                        await webhooksApi.test(
                          organizationId,
                          endpointId,
                          testKey.keyFor(endpointId),
                        );
                        testKey.reset();
                        return messages.testAccepted;
                      })
                    }
                  >
                    {messages.test}
                  </button>
                )}
                <button
                  type="button"
                  className="pc-danger"
                  onClick={() => {
                    if (!window.confirm(messages.disableConfirm)) return;
                    void run(async () => {
                      await webhooksApi.lifecycle(organizationId, endpointId, 'disable');
                      return null;
                    });
                  }}
                >
                  {messages.disable}
                </button>
              </div>

              <form
                className="pc-form pc-card-divider"
                onSubmit={(event) => {
                  event.preventDefault();
                  const description = name.trim();
                  if (description === '' || description === endpoint.description) return;
                  void run(async () => {
                    await webhooksApi.updateDescription(organizationId, endpointId, description);
                    return messages.renamed;
                  });
                }}
              >
                <div className="pc-field">
                  <label htmlFor="endpoint-name">{messages.descriptionLabel}</label>
                  <input
                    id="endpoint-name"
                    type="text"
                    value={name}
                    required
                    maxLength={200}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </div>
                <button type="submit" className="secondary">
                  {messages.rename}
                </button>
              </form>

              <form
                className="pc-form pc-card-divider"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await webhooksApi.updateUrl(
                      organizationId,
                      endpointId,
                      newUrl,
                      urlKey.keyFor(newUrl),
                    );
                    urlKey.reset();
                    setNewUrl('');
                    return null;
                  });
                }}
              >
                <div className="pc-field">
                  <label htmlFor="new-url">{messages.urlLabel}</label>
                  <input
                    id="new-url"
                    type="url"
                    value={newUrl}
                    required
                    onChange={(event) => {
                      setNewUrl(event.target.value);
                    }}
                  />
                </div>
                <button type="submit" className="secondary">
                  {messages.updateUrl}
                </button>
              </form>

              <form
                className="pc-form pc-card-divider"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await webhooksApi.replaceSubscriptions(organizationId, endpointId, chosen);
                    return null;
                  });
                }}
              >
                <fieldset className="pc-scope-list">
                  <legend>{messages.eventTypesLabel}</legend>
                  {EVENT_TYPES.map((eventType) => (
                    <label key={eventType} htmlFor={`sub-${eventType}`} className="pc-scope">
                      <input
                        id={`sub-${eventType}`}
                        type="checkbox"
                        checked={chosen.includes(eventType)}
                        onChange={(event) => {
                          setChosen((current) =>
                            event.target.checked
                              ? [...current, eventType]
                              : current.filter((value) => value !== eventType),
                          );
                        }}
                      />
                      <span>{webhookLabel(messages.eventTypes, eventType)}</span>
                    </label>
                  ))}
                </fieldset>
                <button type="submit" className="secondary">
                  {messages.saveSubscriptions}
                </button>
              </form>
            </section>
          )}

          {canRotate && !disabled && (
            <section className="pc-card pc-rotation-card" aria-labelledby="rotate-heading">
              <h2 id="rotate-heading" className="pc-card-title">
                {messages.rotationWarningTitle}
              </h2>
              <p>{messages.rotationWarningBody}</p>
              <p data-testid="rotation-pending" className="pc-hint">
                {rotation !== null && rotation.unsettledOldConfigDeliveries === 0
                  ? messages.rotationClear
                  : `${messages.rotationPendingCount}: ${rotation?.unsettledOldConfigDeliveries ?? 0}`}
              </p>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    setSecret(
                      await webhooksApi.rotateSecret(
                        organizationId,
                        endpointId,
                        rotateKey.keyFor(endpointId),
                      ),
                    );
                    rotateKey.reset();
                    return null;
                  })
                }
              >
                {messages.rotate}
              </button>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
