'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Field, FormError, SubmitButton } from '@/components/auth-form';
import { PageHeader } from '@/components/ui/page-header';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { LOCALES, LOCALE_LABELS, resolveLocale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { ApiError, organizationApi } from '@/lib/api-client';

const TYPES = [
  'UNIVERSITY',
  'SCIENTIFIC_JOURNAL',
  'PUBLISHER',
  'RESEARCH_INSTITUTION',
  'GOVERNMENT',
  'COMPANY',
  'OTHER',
] as const;

/** A short list for the Phase 2 form; a full ISO picker can replace it later. */
const COUNTRIES = ['PS', 'JO', 'EG', 'SA', 'AE', 'LB', 'TR', 'GB', 'US', 'DE', 'FR'] as const;
const TIMEZONES = [
  'Asia/Hebron',
  'Asia/Gaza',
  'Asia/Amman',
  'Africa/Cairo',
  'Asia/Riyadh',
  'Europe/London',
  'Europe/Berlin',
  'UTC',
] as const;

export default function CreateOrganizationPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getOrganizationMessages(locale);
  const auth = getAuthMessages(locale);
  const router = useRouter();

  const typeId = useId();
  const countryId = useId();
  const timezoneId = useId();
  const localeId = useId();

  const [type, setType] = useState<string>('UNIVERSITY');
  const [displayName, setDisplayName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [slug, setSlug] = useState('');
  const [countryCode, setCountryCode] = useState<string>('PS');
  const [timezone, setTimezone] = useState<string>('Asia/Hebron');
  const [website, setWebsite] = useState('');
  const [defaultLocale, setDefaultLocale] = useState<string>(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const created = await organizationApi.create({
        type,
        displayName,
        legalName: legalName.trim() === '' ? displayName : legalName,
        countryCode,
        timezone,
        defaultLocale,
        ...(slug.trim() !== '' ? { slug: slug.trim() } : {}),
        ...(website.trim() !== '' ? { website: website.trim() } : {}),
      });
      router.push(`/${locale}/organizations/${created.id}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? messageForErrorCode(auth, caught.code))
          : auth.genericError,
      );
      setPending(false);
    }
  }

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/organizations`}>{messages.organizations}</Link>
      </p>
      <PageHeader title={messages.createTitle} description={messages.createSubtitle} />
      <section className="pc-card pc-form-card" aria-label={messages.createTitle}>
        <form className="pc-form" onSubmit={onSubmit} noValidate>
          <FormError message={error} />

          <Field
            label={messages.displayName}
            type="text"
            name="organization"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="organization"
          />

          <Field
            label={messages.legalName}
            type="text"
            name="legal-name"
            value={legalName}
            onChange={setLegalName}
            autoComplete="off"
            required={false}
          />

          <div className="pc-field">
            <label htmlFor={typeId}>{messages.organizationType}</label>
            <select id={typeId} value={type} onChange={(event) => setType(event.target.value)}>
              {TYPES.map((value) => (
                <option key={value} value={value}>
                  {messages.typeLabels[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="pc-field">
            <label htmlFor={countryId}>{messages.country}</label>
            <select
              id={countryId}
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value)}
            >
              {COUNTRIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="pc-field">
            <label htmlFor={timezoneId}>{messages.timezone}</label>
            <select
              id={timezoneId}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {TIMEZONES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div className="pc-field">
            <label htmlFor={localeId}>{messages.defaultLanguage}</label>
            <select
              id={localeId}
              value={defaultLocale}
              onChange={(event) => setDefaultLocale(event.target.value)}
            >
              {LOCALES.map((value) => (
                <option key={value} value={value}>
                  {LOCALE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <Field
            label={messages.websiteOptional}
            type="text"
            name="url"
            value={website}
            onChange={setWebsite}
            autoComplete="url"
            required={false}
          />

          <Field
            label={messages.handle}
            type="text"
            name="handle"
            value={slug}
            onChange={setSlug}
            autoComplete="off"
            required={false}
            hint={messages.handleHint}
          />

          <SubmitButton label={messages.create} pendingLabel={auth.sending} pending={pending} />
        </form>
      </section>
    </main>
  );
}
