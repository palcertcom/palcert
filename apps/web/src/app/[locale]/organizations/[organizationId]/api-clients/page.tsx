'use client';

import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useEffect, useState } from 'react';
import { ApiClientSecretPanel } from '@/components/api-client-secret';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { apiClientLabel, getApiClientsMessages } from '@/i18n/api-clients-messages';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import {
  ApiError,
  apiClientsApi,
  type ApiClientResponse,
  type ApiClientScopeResponse,
  type ApiClientSecretResponse,
} from '@/lib/api-client';

/**
 * Overlaps an administrator can pick, in seconds.
 *
 * Offered as a short list rather than a free number, because the sensible
 * answers are "long enough to deploy" and "immediately", and a text field
 * invites somebody to type the longest value the API accepts as a way of
 * avoiding the deadline. Zero is first: cutting the old secret off now is the
 * right answer when you are rotating because it leaked.
 */
const OVERLAP_CHOICES = [0, 15 * 60, 60 * 60, 6 * 60 * 60, 12 * 60 * 60] as const;

/**
 * An organization's machine credentials.
 *
 * The screen keeps two distinctions visible everywhere, because both of them
 * are ones people get wrong under pressure: disabling is reversible and keeps
 * the secret, revoking is final; and the secret is shown once, on creation and
 * on rotation, and never again.
 */
export default function ApiClientsPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) => (
        <ApiClientsSection
          organizationId={organizationId}
          locale={locale}
          canManage={permissions.has('integration:api-client:manage')}
          canIssueSecret={permissions.has('integration:api-client:secret:issue')}
        />
      )}
    </OrganizationShell>
  );
}

function ApiClientsSection({
  organizationId,
  locale,
  canManage,
  canIssueSecret,
}: {
  organizationId: string;
  locale: 'en' | 'ar';
  canManage: boolean;
  canIssueSecret: boolean;
}) {
  const messages = getApiClientsMessages(locale);
  // One key for this create, reused if the button is pressed again after an
  // uncertain outcome, replaced the moment what is being asked for changes,
  // and discarded once it has succeeded.
  const idempotency = useIdempotencyKey();

  const [clients, setClients] = useState<readonly ApiClientResponse[] | null>(null);
  const [catalogue, setCatalogue] = useState<readonly ApiClientScopeResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [overlap, setOverlap] = useState<number>(OVERLAP_CHOICES[1]);

  // Held in component state and nowhere else. A secret that outlives the page
  // is one nobody decided to keep.
  const [reveal, setReveal] = useState<{
    readonly value: ApiClientSecretResponse;
    readonly kind: 'create' | 'rotate';
  } | null>(null);

  function describe(caught: unknown): string {
    if (caught instanceof ApiError) return messages.errors[caught.code] ?? messages.genericError;
    return messages.genericError;
  }

  async function load(): Promise<void> {
    try {
      setClients(await apiClientsApi.list(organizationId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  useEffect(() => {
    void load();
    // The scope catalogue is served rather than hard-coded, so a screen can
    // never offer a scope that does not exist or describe one as granting
    // something it does not.
    void apiClientsApi
      .scopes(organizationId)
      .then(setCatalogue)
      .catch(() => {
        setCatalogue([]);
      });
    // Keyed on the id the loads depend on; the functions are recreated every
    // render and would refetch on each one.
  }, [organizationId]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const body = {
        displayName,
        ...(description === '' ? {} : { description }),
        scopes: [...chosen].sort(),
        ...(expiresAt === '' ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      };
      const created = await apiClientsApi.create(
        organizationId,
        body,
        idempotency.keyFor(JSON.stringify(body)),
      );
      idempotency.reset();
      setReveal({ value: created, kind: 'create' });
      setDisplayName('');
      setDescription('');
      setChosen([]);
      setExpiresAt('');
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setPending(false);
    }
  }

  async function act(work: () => Promise<unknown>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setPending(false);
    }
  }

  async function rotate(client: ApiClientResponse): Promise<void> {
    await act(async () => {
      const rotated = await apiClientsApi.rotateSecret(
        organizationId,
        client.apiClientId,
        overlap,
        crypto.randomUUID(),
      );
      setReveal({ value: rotated, kind: 'rotate' });
    });
  }

  function revoke(client: ApiClientResponse): void {
    // Final, so it asks. The confirmation names the reversible alternative,
    // because the moment somebody reaches for this is the moment they are
    // least likely to remember that Disable exists.
    if (!window.confirm(messages.revokeConfirm)) return;
    void act(() => apiClientsApi.revoke(organizationId, client.apiClientId));
  }

  const formatDate = (value: string | null, fallback: string): string =>
    value === null
      ? fallback
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        );

  return (
    <>
      <PageHeader title={messages.title} description={messages.intro} />
      {error !== null && <FormError message={error} />}

      {/* Shown once, at the top, before anything else: the only time this
          secret will ever be visible. */}
      {reveal !== null && (
        <ApiClientSecretPanel
          locale={locale}
          reveal={reveal.value}
          kind={reveal.kind}
          onDismiss={() => {
            setReveal(null);
          }}
        />
      )}

      <div className="pc-detail-grid">
        <section className="pc-detail-main" aria-label={messages.title}>
          {clients === null ? (
            <LoadingState label={messages.loading} />
          ) : clients.length === 0 ? (
            <EmptyState icon="key" title={messages.empty} headingLevel={2} />
          ) : (
            <ul className="pc-integration-list">
              {clients.map((client) => (
                <li
                  key={client.apiClientId}
                  className="pc-card pc-integration-card"
                  data-status={client.status}
                  data-testid={`client-${client.apiClientId}`}
                >
                  <div className="pc-integration-head">
                    <h2 className="pc-card-title">
                      <bdi>{client.displayName}</bdi>
                    </h2>
                    <span data-testid={`status-${client.apiClientId}`}>
                      <StatusBadge
                        status={client.status}
                        label={apiClientLabel(messages.statuses, client.status)}
                      />
                    </span>
                  </div>
                  <dl className="pc-summary">
                    <dt>{messages.clientIdLabel}</dt>
                    <dd>
                      {/* Left-to-right even in Arabic: see the secret panel. */}
                      <code dir="ltr">{client.clientId}</code>
                    </dd>
                    <dt>{messages.scopesColumn}</dt>
                    <dd>
                      <span className="pc-tag-list">
                        {client.scopes.map((scope) => (
                          <span key={scope} className="pc-tag">
                            {apiClientLabel(messages.scopeNames, scope)}
                          </span>
                        ))}
                      </span>
                    </dd>
                    <dt>{messages.lastUsedLabel}</dt>
                    <dd>{formatDate(client.lastUsedAt, messages.neverUsed)}</dd>
                    <dt>{messages.expiresLabel}</dt>
                    <dd>{formatDate(client.expiresAt, messages.noExpiry)}</dd>
                    {client.rotationOverlapEndsAt !== null && (
                      <>
                        <dt>{messages.overlapEndsAt}</dt>
                        <dd data-testid={`overlap-${client.apiClientId}`}>
                          {formatDate(client.rotationOverlapEndsAt, '')}
                        </dd>
                      </>
                    )}
                  </dl>

                  {/* A revoked client has no actions. Offering a disabled-looking
                      button on something that is permanently dead is a way of
                      implying it could come back. */}
                  {client.status !== 'REVOKED' && (canIssueSecret || canManage) && (
                    <div className="pc-actions">
                      {canIssueSecret && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={pending}
                          onClick={() => void rotate(client)}
                          data-testid={`rotate-${client.apiClientId}`}
                        >
                          {pending ? messages.rotating : messages.rotate}
                        </button>
                      )}
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            disabled={pending}
                            onClick={() =>
                              void act(() =>
                                apiClientsApi.setEnabled(
                                  organizationId,
                                  client.apiClientId,
                                  client.status !== 'ACTIVE',
                                ),
                              )
                            }
                            data-testid={`toggle-${client.apiClientId}`}
                          >
                            {client.status === 'ACTIVE' ? messages.disable : messages.enable}
                          </button>
                          <button
                            type="button"
                            className="pc-danger"
                            disabled={pending}
                            onClick={() => {
                              revoke(client);
                            }}
                            data-testid={`revoke-${client.apiClientId}`}
                          >
                            {messages.revoke}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="pc-hint">{messages.disableHint}</p>
        </section>

        {(canIssueSecret || canManage) && (
          <div className="pc-detail-side">
            {canManage && canIssueSecret && (
              <section className="pc-card" aria-labelledby="api-client-create-heading">
                <h2 id="api-client-create-heading" className="pc-card-title">
                  {messages.createTitle}
                </h2>
                <form className="pc-form" onSubmit={create}>
                  <p className="pc-hint">{messages.createIntro}</p>

                  <div className="pc-field">
                    <label htmlFor="api-client-name">{messages.displayNameLabel}</label>
                    <input
                      id="api-client-name"
                      value={displayName}
                      maxLength={120}
                      required
                      onChange={(event) => {
                        setDisplayName(event.target.value);
                      }}
                    />
                    <p className="pc-hint">{messages.displayNameHint}</p>
                  </div>

                  <div className="pc-field">
                    <label htmlFor="api-client-description">{messages.descriptionLabel}</label>
                    <input
                      id="api-client-description"
                      value={description}
                      maxLength={500}
                      onChange={(event) => {
                        setDescription(event.target.value);
                      }}
                    />
                  </div>

                  <fieldset className="pc-scope-list">
                    <legend>{messages.scopesLabel}</legend>
                    <p className="pc-hint">{messages.scopesHint}</p>
                    {catalogue.map((entry) => (
                      <label
                        key={entry.scope}
                        htmlFor={`scope-${entry.scope}`}
                        className="pc-scope"
                      >
                        <input
                          id={`scope-${entry.scope}`}
                          type="checkbox"
                          checked={chosen.includes(entry.scope)}
                          onChange={(event) => {
                            setChosen((current) =>
                              event.target.checked
                                ? [...current, entry.scope]
                                : current.filter((value) => value !== entry.scope),
                            );
                          }}
                        />
                        <span>
                          <strong>{apiClientLabel(messages.scopeNames, entry.scope)}</strong>
                          {/* What the scope actually grants, next to the box. The
                              choice being made is about somebody else's thesis,
                              not about a checkbox. */}
                          <small>{apiClientLabel(messages.scopeDescriptions, entry.scope)}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <div className="pc-field">
                    <label htmlFor="api-client-expires">{messages.expiresAtLabel}</label>
                    <input
                      id="api-client-expires"
                      type="date"
                      value={expiresAt}
                      onChange={(event) => {
                        setExpiresAt(event.target.value);
                      }}
                    />
                    <p className="pc-hint">{messages.expiresAtHint}</p>
                  </div>

                  <button type="submit" disabled={pending}>
                    {pending ? messages.creating : messages.create}
                  </button>
                </form>
              </section>
            )}

            {canIssueSecret && (
              <section className="pc-card" aria-labelledby="api-client-overlap-heading">
                <h2 id="api-client-overlap-heading" className="pc-card-title">
                  {messages.rotateOverlapLabel}
                </h2>
                <p className="pc-hint">{messages.rotateOverlapHint}</p>
                <div className="pc-field">
                  <select
                    aria-label={messages.rotateOverlapLabel}
                    value={overlap}
                    onChange={(event) => {
                      setOverlap(Number(event.target.value));
                    }}
                  >
                    {OVERLAP_CHOICES.map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {apiClientLabel(messages.overlapChoices, String(seconds))}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
