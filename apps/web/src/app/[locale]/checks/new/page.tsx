'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { CheckPurchasePanel } from '@/components/check-billing';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { StepProgress } from '@/components/ui/step-progress';
import { getBillingMessages } from '@/i18n/billing-messages';
import { getChecksMessages } from '@/i18n/checks-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  catalogueApi,
  checksApi,
  documentsApi,
  type CatalogueDocumentTypeResponse,
  type CatalogueOrganizationResponse,
  type CatalogueStandardResponse,
  type DocumentResponse,
} from '@/lib/api-client';

/**
 * Start a check (§73).
 *
 * Four choices, narrowed one at a time: a document of the user's own, then the
 * institution, the document type and the standard. The catalogue is the only
 * source of what is selectable, so a standard that was never published simply
 * is not on the page — the form cannot offer something the API would refuse.
 *
 * Presented as the original design's numbered steps: one decision per screen,
 * the choices so far always visible, and the price shown only on the last
 * step, where the check is actually bought. Moving between steps changes
 * nothing on the server; only the final confirmation does.
 */
const STEP_COUNT = 4;
export default function NewCheckPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getChecksMessages(locale);
  const router = useRouter();

  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [organizations, setOrganizations] = useState<CatalogueOrganizationResponse[]>([]);
  const [documentTypes, setDocumentTypes] = useState<CatalogueDocumentTypeResponse[]>([]);
  const [standards, setStandards] = useState<CatalogueStandardResponse[]>([]);

  const [documentId, setDocumentId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [standardId, setStandardId] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const movedStep = useRef(false);

  // After a step change, put focus on the new step's heading so a keyboard or
  // screen-reader user starts reading where the new content begins.
  useEffect(() => {
    if (!movedStep.current) return;
    stepHeading.current?.focus();
  }, [step]);

  function goTo(next: number): void {
    movedStep.current = true;
    setError(null);
    setStep(Math.max(0, Math.min(STEP_COUNT - 1, next)));
  }
  // Stable for the life of this form, so a double submit or a flaky network
  // retry produces one check rather than two (§61).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  // Billing has its own vocabulary, and a price failure explained in check
  // words would tell the customer nothing about their money.
  const billing = getBillingMessages(locale);
  const describeBilling = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (billing.errors[caught.code] ?? messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [billing, messages],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [page, orgs] = await Promise.all([
          documentsApi.list({ limit: 100 }),
          catalogueApi.organizations(),
        ]);
        // Only a version that finished processing can be checked (§25).
        setDocuments(page.items.filter((item) => item.latestVersion?.status === 'READY'));
        setOrganizations(orgs);
        setLoaded(true);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/${locale}/unauthorized`);
          return;
        }
        setError(describe(caught));
      }
    })();
  }, [describe, locale, router]);

  useEffect(() => {
    setDocumentTypes([]);
    setDocumentTypeId('');
    setStandards([]);
    setStandardId('');
    if (organizationId === '') return;
    void (async () => {
      try {
        setDocumentTypes(await catalogueApi.documentTypes(organizationId));
      } catch (caught) {
        setError(describe(caught));
      }
    })();
  }, [describe, organizationId]);

  useEffect(() => {
    setStandards([]);
    setStandardId('');
    if (documentTypeId === '') return;
    void (async () => {
      try {
        setStandards(await catalogueApi.standards(documentTypeId));
      } catch (caught) {
        setError(describe(caught));
      }
    })();
  }, [describe, documentTypeId]);

  const selected = documents.find((item) => item.id === documentId);

  /**
   * Buy and start the check (Phase 11 §53).
   *
   * Called from the price confirmation rather than from the form's submit, so
   * a customer cannot start a check without having been shown what it costs
   * and what "reserved" means.
   */
  async function confirm(priceQuoteId: string): Promise<void> {
    const versionId = selected?.latestVersion?.id;
    if (versionId === undefined || standardId === '') return;

    setStarting(true);
    setError(null);
    try {
      const check = await checksApi.create(versionId, standardId, priceQuoteId, idempotencyKey);
      router.push(`/${locale}/checks/${check.id}`);
    } catch (caught) {
      setError(describeBilling(caught));
      setStarting(false);
    }
  }

  const organization = organizations.find((item) => item.id === organizationId);
  const documentType = documentTypes.find((item) => item.id === documentTypeId);
  const standard = standards.find((item) => item.id === standardId);
  const standardName = (item: CatalogueStandardResponse): string =>
    `${locale === 'ar' ? item.nameAr : item.nameEn} ${item.versionLabel}`;
  const documentTypeName = (item: CatalogueDocumentTypeResponse): string =>
    locale === 'ar' ? (item.nameAr ?? item.name) : item.name;

  const steps = [
    messages.stepDocument,
    messages.stepInstitution,
    messages.stepStandard,
    messages.stepConfirm,
  ];
  const canContinue =
    step === 0
      ? documentId !== ''
      : step === 1
        ? organizationId !== '' && documentTypeId !== ''
        : step === 2
          ? standardId !== ''
          : false;

  return (
    <main className="pc-page pc-wizard">
      <p className="pc-back-link">
        <Link href={`/${locale}/checks`}>{messages.backToChecks}</Link>
      </p>
      <PageHeader title={messages.newCheck} description={messages.notApproval} />

      <StepProgress
        steps={steps}
        current={step}
        label={messages.wizardLabel}
        stateLabels={messages.stepStates}
      />

      <FormError message={error} />

      <form
        className="pc-card pc-wizard-step"
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue) goTo(step + 1);
        }}
        aria-labelledby="wizard-step-heading"
      >
        <h2 id="wizard-step-heading" ref={stepHeading} tabIndex={-1} className="pc-card-title">
          {steps[step]}
        </h2>

        {step === 0 &&
          (loaded && documents.length === 0 ? (
            <EmptyState
              icon="document"
              title={messages.noReadyDocuments}
              description={messages.noReadyDocumentsHint}
              headingLevel={3}
              action={
                <Link className="pc-btn pc-btn-secondary" href={`/${locale}/documents`}>
                  {messages.goToDocuments}
                </Link>
              }
            />
          ) : (
            <div className="pc-field">
              <label htmlFor="document">{messages.chooseDocument}</label>
              <select
                id="document"
                value={documentId}
                onChange={(event) => setDocumentId(event.target.value)}
                required
              >
                <option value="">—</option>
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.displayName}
                  </option>
                ))}
              </select>
            </div>
          ))}

        {step === 1 && (
          <>
            <div className="pc-field">
              <label htmlFor="organization">{messages.chooseOrganization}</label>
              <select
                id="organization"
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
                required
              >
                <option value="">—</option>
                {organizations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div className="pc-field">
              <label htmlFor="documentType">{messages.chooseDocumentType}</label>
              <select
                id="documentType"
                value={documentTypeId}
                onChange={(event) => setDocumentTypeId(event.target.value)}
                disabled={documentTypes.length === 0}
                required
              >
                <option value="">—</option>
                {documentTypes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {documentTypeName(item)}
                  </option>
                ))}
              </select>
            </div>

            {organizations.length === 0 && (
              <p className="pc-hint">
                {messages.noCheckableStandards} {messages.noCheckableStandardsHint}
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <div className="pc-field">
            <label htmlFor="standard">{messages.chooseStandard}</label>
            <select
              id="standard"
              value={standardId}
              onChange={(event) => setStandardId(event.target.value)}
              disabled={standards.length === 0}
              required
            >
              <option value="">—</option>
              {standards.map((item) => (
                <option key={item.id} value={item.id}>
                  {`${standardName(item)} — ${messages.standardRuleCount(item.ruleCount)}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {step === 3 && (
          <section aria-labelledby="wizard-review-heading">
            <h3 id="wizard-review-heading" className="pc-visually-hidden">
              {messages.reviewHeading}
            </h3>
            <dl className="pc-summary pc-wizard-review">
              <dt>{messages.chooseDocument}</dt>
              <dd>
                <bdi>{selected?.displayName}</bdi>{' '}
                <button type="button" className="pc-button-quiet" onClick={() => goTo(0)}>
                  {messages.change}
                  <span className="pc-visually-hidden">: {messages.chooseDocument}</span>
                </button>
              </dd>
              <dt>{messages.chooseOrganization}</dt>
              <dd>
                <bdi>{organization?.displayName}</bdi>{' '}
                <button type="button" className="pc-button-quiet" onClick={() => goTo(1)}>
                  {messages.change}
                  <span className="pc-visually-hidden">: {messages.chooseOrganization}</span>
                </button>
              </dd>
              <dt>{messages.chooseDocumentType}</dt>
              <dd>
                <bdi>{documentType === undefined ? '' : documentTypeName(documentType)}</bdi>
              </dd>
              <dt>{messages.chooseStandard}</dt>
              <dd>
                <bdi>{standard === undefined ? '' : standardName(standard)}</bdi>{' '}
                <button type="button" className="pc-button-quiet" onClick={() => goTo(2)}>
                  {messages.change}
                  <span className="pc-visually-hidden">: {messages.chooseStandard}</span>
                </button>
              </dd>
            </dl>
          </section>
        )}

        {step < STEP_COUNT - 1 && (
          <div className="pc-wizard-nav">
            {step > 0 ? (
              <button type="button" className="secondary" onClick={() => goTo(step - 1)}>
                {messages.back}
              </button>
            ) : (
              <span />
            )}
            <button type="submit" disabled={!canContinue}>
              {messages.next}
            </button>
          </div>
        )}
        {step === STEP_COUNT - 1 && (
          <div className="pc-wizard-nav">
            <button type="button" className="secondary" onClick={() => goTo(step - 1)}>
              {messages.back}
            </button>
          </div>
        )}
      </form>

      {/* The price, the balance and what "reserved" means — shown on the last
          step, after the document and the standard are chosen, because until
          then there is nothing to price (§53). */}
      {step === STEP_COUNT - 1 &&
        standardId !== '' &&
        selected?.latestVersion?.id !== undefined && (
          <CheckPurchasePanel
            locale={locale}
            starting={starting}
            onConfirm={(priceQuoteId) => void confirm(priceQuoteId)}
          />
        )}
    </main>
  );
}
