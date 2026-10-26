'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/auth-form';
import { PageHeader } from '@/components/ui/page-header';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { getAuthMessages } from '@/i18n/auth-messages';
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales';
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

function ProfileSection({
  organizationId,
  organization,
  messages,
  permissions,
  locale,
  reload,
}: OrganizationShellState) {
  const auth = getAuthMessages(locale);
  const typeId = useId();
  const localeId = useId();

  const [displayName, setDisplayName] = useState(organization.displayName);
  const [legalName, setLegalName] = useState(organization.legalName);
  const [website, setWebsite] = useState(organization.website ?? '');
  const [type, setType] = useState<string>(organization.type);
  const [defaultLocale, setDefaultLocale] = useState<string>(organization.defaultLocale);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canEdit = permissions.has('organization:profile:update');

  useEffect(() => {
    setDisplayName(organization.displayName);
    setLegalName(organization.legalName);
    setWebsite(organization.website ?? '');
    setType(organization.type);
    setDefaultLocale(organization.defaultLocale);
  }, [organization]);

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      await organizationApi.update(organizationId, {
        displayName,
        legalName,
        type,
        defaultLocale,
        ...(website.trim() !== '' ? { website: website.trim() } : {}),
      });
      setNotice(messages.saved);
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? auth.genericError)
          : auth.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title={messages.profileTitle} />

      <FormError message={error} />
      <FormSuccess message={notice} />

      <section className="pc-card pc-form-card" aria-label={messages.profileTitle}>
        <form className="pc-form" onSubmit={onSave} noValidate>
          {/* Someone who may read the profile but not change it sees the
            values, not controls that would appear to do something. */}
          <fieldset className="pc-fieldset-plain" disabled={!canEdit}>
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
            />
            <Field
              label={messages.websiteOptional}
              type="text"
              name="url"
              value={website}
              onChange={setWebsite}
              autoComplete="url"
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
          </fieldset>
          {canEdit && (
            <SubmitButton
              label={messages.saveChanges}
              pendingLabel={auth.sending}
              pending={pending}
            />
          )}
        </form>
      </section>
    </>
  );
}

export default function OrganizationProfilePage() {
  return <OrganizationShell>{(state) => <ProfileSection {...state} />}</OrganizationShell>;
}
