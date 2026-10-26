'use client';

import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { WebhookSecretPanel } from '@/components/webhook-secret';
import { getWebhooksMessages, webhookLabel } from '@/i18n/webhooks-messages';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import {
  ApiError,
  webhooksApi,
  type WebhookEndpointResponse,
  type WebhookSecretResponse,
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
 * An organization's webhook endpoints.
 *
 * The list distinguishes what is live from what is merely saved, everywhere:
 * an endpoint that has never verified shows no destination at all rather than
 * showing the URL somebody typed, because an administrator who reads their new
 * URL on this screen stops watching the old one.
 */
export default function WebhooksPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) => (
        <WebhooksSection
          organizationId={organizationId}
          locale={locale}
          canManage={permissions.has('integration:webhook:manage')}
        />
      )}
    </OrganizationShell>
  );
}

function WebhooksSection({
  organizationId,
  locale,
  canManage,
}: {
  organizationId: string;
  locale: 'en' | 'ar';
  canManage: boolean;
}) {
  const messages = getWebhooksMessages(locale);
  // One key for this create, reused if the user presses the button again after
  // an uncertain outcome, replaced the moment they change what they are asking
  // for, and discarded once it has succeeded.
  const idempotency = useIdempotencyKey();

  const [endpoints, setEndpoints] = useState<WebhookEndpointResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  // Held in component state and nowhere else. Storing it would outlive the
  // page, and a secret that outlives the page is one nobody decided to keep.
  const [secret, setSecret] = useState<WebhookSecretResponse | null>(null);

  function describe(caught: unknown): string {
    if (caught instanceof ApiError) return messages.errors[caught.code] ?? messages.genericError;
    return messages.genericError;
  }

  async function load(): Promise<void> {
    try {
      setEndpoints(await webhooksApi.listEndpoints(organizationId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  useEffect(() => {
    void load();
    // Keyed on the ids the load actually depends on; `load` itself is
    // recreated every render and would refetch on each one.
  }, [organizationId]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const key = idempotency.keyFor(
        JSON.stringify({ description, url, eventTypes: [...chosen].sort() }),
      );
      setSecret(
        await webhooksApi.createEndpoint(
          organizationId,
          { description, url, eventTypes: chosen },
          key,
        ),
      );
      idempotency.reset();
      setDescription('');
      setUrl('');
      setChosen([]);
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title={messages.title} description={messages.intro} />
      {error !== null && <FormError message={error} />}

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

      <div className={canManage ? 'pc-detail-grid' : undefined}>
        <section className="pc-detail-main" aria-label={messages.title}>
          {endpoints === null ? (
            <LoadingState label={messages.loading} />
          ) : endpoints.length === 0 ? (
            <EmptyState icon="webhook" title={messages.empty} headingLevel={2} />
          ) : (
            <ul className="pc-integration-list">
              {endpoints.map((endpoint) => (
                <li key={endpoint.id} className="pc-card pc-integration-card">
                  <div className="pc-integration-head">
                    <h2 className="pc-card-title">
                      <Link
                        href={`/${locale}/organizations/${organizationId}/webhooks/${endpoint.id}`}
                      >
                        <bdi>{endpoint.description}</bdi>
                      </Link>
                    </h2>
                    <span data-testid={`status-${endpoint.id}`}>
                      <StatusBadge
                        status={endpoint.status}
                        label={webhookLabel(messages.endpointStatuses, endpoint.status)}
                      />
                    </span>
                  </div>
                  <p className="pc-integration-destination">
                    <Icon name="webhook" size={16} />
                    {endpoint.destination === '' ? (
                      <span>{messages.noDestination}</span>
                    ) : (
                      <span dir="ltr" className="pc-ltr">
                        {endpoint.destination}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && (
          <section className="pc-card" aria-labelledby="webhook-create-heading">
            <h2 id="webhook-create-heading" className="pc-card-title">
              {messages.createTitle}
            </h2>
            <form className="pc-form" onSubmit={create}>
              <p className="pc-hint">{messages.createIntro}</p>

              <div className="pc-field">
                <label htmlFor="webhook-description">{messages.descriptionLabel}</label>
                <input
                  id="webhook-description"
                  value={description}
                  maxLength={200}
                  required
                  onChange={(event) => {
                    setDescription(event.target.value);
                  }}
                />
              </div>

              <div className="pc-field">
                <label htmlFor="webhook-url">{messages.urlLabel}</label>
                <input
                  id="webhook-url"
                  type="url"
                  value={url}
                  required
                  onChange={(event) => {
                    setUrl(event.target.value);
                  }}
                />
                <p className="pc-hint">{messages.urlHint}</p>
              </div>

              <fieldset className="pc-scope-list">
                <legend>{messages.eventTypesLabel}</legend>
                <p className="pc-hint">{messages.eventTypesHint}</p>
                {EVENT_TYPES.map((eventType) => (
                  <label key={eventType} htmlFor={`event-${eventType}`} className="pc-scope">
                    <input
                      id={`event-${eventType}`}
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

              <button type="submit" disabled={pending}>
                {pending ? messages.creating : messages.create}
              </button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
