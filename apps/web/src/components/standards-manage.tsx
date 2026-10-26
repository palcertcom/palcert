'use client';

import { useState } from 'react';
import { ConfirmAction, type ConfirmField } from '@/components/ui/confirm-action';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAuthMessages } from '@/i18n/auth-messages';
import type { Locale } from '@/i18n/locales';
import { getStandardsMessages, type StandardsMessages } from '@/i18n/standards-messages';
import {
  ApiError,
  standardsApi,
  type DocumentTypeResponse,
  type StandardResponse,
  type StandardVersionResponse,
} from '@/lib/api-client';

function useConfirmProps(locale: Locale) {
  const messages = getStandardsMessages(locale);
  return {
    labels: {
      cancel: messages.cancel,
      close: messages.manage.close,
      optional: messages.manage.optional,
      pending: messages.manage.working,
      invalid: messages.manage.required,
    },
    describeError: (caught: unknown) => ({
      message:
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? getAuthMessages(locale).genericError)
          : getAuthMessages(locale).genericError,
      reauth: false,
    }),
  };
}

/** Only fields that were filled in are sent: an empty box is "leave as is". */
function changed(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value !== ''),
  );
}

/**
 * A standard's own settings: whether the public may check against it, its
 * names, and whether it is archived. Each control appears for the permission
 * behind it; publishing to the catalogue is an administration permission,
 * not an authoring one, because it makes the institution's standard visible
 * to the world.
 */
export function StandardManagement({
  locale,
  organizationId,
  standard,
  permissions,
  onChanged,
}: {
  locale: Locale;
  organizationId: string;
  standard: StandardResponse;
  permissions: ReadonlySet<string>;
  onChanged: (message: string) => Promise<void>;
}) {
  const messages = getStandardsMessages(locale);
  const confirm = useConfirmProps(locale);
  const m = messages.manage;
  const isPublic = standard.checkAvailability === 'PUBLIC_CHECKABLE';
  const archived = standard.status === 'ARCHIVED';

  const editFields: ConfirmField[] = [
    { name: 'nameEn', label: messages.nameEn, maxLength: 200 },
    { name: 'nameAr', label: messages.nameAr, maxLength: 200 },
    { name: 'descriptionEn', label: m.descriptionLabel, maxLength: 2000, multiline: true },
    { name: 'descriptionAr', label: m.descriptionArLabel, maxLength: 2000, multiline: true },
  ];

  return (
    <>
      <section className="pc-card" aria-labelledby="standard-catalogue-heading">
        <h2 id="standard-catalogue-heading" className="pc-card-title">
          {m.catalogueTitle}
        </h2>
        <p>
          <StatusBadge
            tone={isPublic ? 'success' : 'neutral'}
            label={isPublic ? m.cataloguePublic : m.cataloguePrivate}
          />
        </p>
        <p className="pc-hint">{m.catalogueHint}</p>
        {permissions.has('standard:check-availability:manage') && !archived ? (
          <div className="pc-actions">
            {isPublic ? (
              <ConfirmAction
                {...confirm}
                label={m.withdrawFromCatalogue}
                title={m.withdrawFromCatalogue}
                intro={m.withdrawFromCatalogueIntro}
                danger
                onConfirm={async () => {
                  await standardsApi.setCheckAvailability(organizationId, standard.id, 'PRIVATE');
                  await onChanged(m.catalogueChanged);
                }}
              />
            ) : (
              <ConfirmAction
                {...confirm}
                label={m.addToCatalogue}
                title={m.addToCatalogue}
                intro={m.addToCatalogueIntro}
                onConfirm={async () => {
                  await standardsApi.setCheckAvailability(
                    organizationId,
                    standard.id,
                    'PUBLIC_CHECKABLE',
                  );
                  await onChanged(m.catalogueChanged);
                }}
              />
            )}
          </div>
        ) : null}
      </section>

      {permissions.has('standard:definition:update') ||
      permissions.has('standard:definition:archive') ? (
        <section className="pc-card" aria-labelledby="standard-manage-heading">
          <h2 id="standard-manage-heading" className="pc-card-title">
            {m.editStandard}
          </h2>
          {archived ? <p className="pc-hint">{m.archivedNotice}</p> : null}
          <div className="pc-actions">
            {permissions.has('standard:definition:update') && !archived ? (
              <ConfirmAction
                {...confirm}
                label={m.editStandard}
                title={m.editStandard}
                intro={m.editStandardIntro}
                confirmLabel={messages.save}
                fields={editFields}
                onConfirm={async (values) => {
                  const body = changed(values);
                  if (Object.keys(body).length === 0) return;
                  await standardsApi.updateStandard(organizationId, standard.id, body);
                  await onChanged(messages.saved);
                }}
              />
            ) : null}
            {permissions.has('standard:definition:archive') ? (
              archived ? (
                <ConfirmAction
                  {...confirm}
                  label={m.restoreStandard}
                  title={m.restoreStandard}
                  intro={m.restoreStandardIntro}
                  onConfirm={async () => {
                    await standardsApi.restoreStandard(organizationId, standard.id);
                    await onChanged(messages.saved);
                  }}
                />
              ) : (
                <ConfirmAction
                  {...confirm}
                  label={m.archiveStandard}
                  title={m.archiveStandard}
                  intro={m.archiveStandardIntro}
                  danger
                  onConfirm={async () => {
                    await standardsApi.archiveStandard(organizationId, standard.id);
                    await onChanged(messages.saved);
                  }}
                />
              )
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * What can be done to one version beyond its rules: edit a draft's label and
 * dates, archive it, and download exactly what was published.
 */
export function VersionManagement({
  locale,
  organizationId,
  standardId,
  version,
  permissions,
  onChanged,
}: {
  locale: Locale;
  organizationId: string;
  standardId: string;
  version: StandardVersionResponse;
  permissions: ReadonlySet<string>;
  onChanged: (message: string) => Promise<void>;
}) {
  const messages = getStandardsMessages(locale);
  const confirm = useConfirmProps(locale);
  const m = messages.manage;
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const isDraft = version.status === 'DRAFT';
  // Anything that was ever published has a snapshot worth downloading,
  // including a version that has since been superseded or archived.
  const hasSnapshot =
    version.status === 'PUBLISHED' ||
    version.status === 'SUPERSEDED' ||
    version.publishedAt !== null;

  async function downloadSnapshot(): Promise<void> {
    setDownloadError(null);
    try {
      const snapshot = await standardsApi.snapshot(organizationId, standardId, version.id);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `standard-${version.versionLabel.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setDownloadError(confirm.describeError(caught).message);
    }
  }

  const canEdit = isDraft && permissions.has('standard:version:update');
  // Only the version in force can be retired from here. A superseded version is
  // already history, and archiving it would overwrite "replaced by" with a
  // retirement nobody decided on; a draft is abandoned on its own page.
  const canArchive = version.status === 'PUBLISHED' && permissions.has('standard:version:archive');
  if (!canEdit && !canArchive && !hasSnapshot) return null;

  return (
    <div className="pc-actions">
      {canEdit ? (
        <ConfirmAction
          {...confirm}
          label={m.editDraft}
          title={m.editDraft}
          intro={m.editDraftIntro}
          confirmLabel={messages.save}
          fields={[
            { name: 'versionLabel', label: messages.versionLabel, maxLength: 40 },
            {
              name: 'effectiveFrom',
              label: messages.effectiveFrom,
              hint: m.effectiveHint,
              maxLength: 10,
              ltr: true,
            },
            {
              name: 'effectiveUntil',
              label: messages.effectiveUntil,
              hint: m.effectiveHint,
              maxLength: 10,
              ltr: true,
            },
          ]}
          onConfirm={async (values) => {
            const body = changed(values);
            if (Object.keys(body).length === 0) return;
            await standardsApi.updateVersion(organizationId, standardId, version.id, body);
            await onChanged(messages.saved);
          }}
        />
      ) : null}
      {canArchive ? (
        <ConfirmAction
          {...confirm}
          label={m.archiveVersion}
          title={m.archiveVersion}
          intro={m.archiveVersionIntro}
          danger
          onConfirm={async () => {
            await standardsApi.archiveVersion(organizationId, standardId, version.id);
            await onChanged(messages.saved);
          }}
        />
      ) : null}
      {hasSnapshot ? (
        <button
          type="button"
          className="pc-btn pc-btn-secondary"
          title={m.snapshotHint}
          onClick={() => void downloadSnapshot()}
        >
          {m.downloadSnapshot}
        </button>
      ) : null}
      {downloadError === null ? null : (
        <p className="pc-alert pc-alert-error" role="alert">
          {downloadError}
        </p>
      )}
    </div>
  );
}

/** Renaming a document type, and describing it, for people who submit. */
export function EditDocumentType({
  locale,
  organizationId,
  documentType,
  onChanged,
}: {
  locale: Locale;
  organizationId: string;
  documentType: DocumentTypeResponse;
  onChanged: (message: string) => Promise<void>;
}) {
  const messages: StandardsMessages = getStandardsMessages(locale);
  const confirm = useConfirmProps(locale);
  return (
    <ConfirmAction
      {...confirm}
      label={messages.manage.editDocumentType}
      title={`${messages.manage.editDocumentType}: ${documentType.name}`}
      intro={messages.manage.editDocumentTypeIntro}
      confirmLabel={messages.save}
      buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
      fields={[
        { name: 'name', label: messages.documentTypeName, maxLength: 120 },
        { name: 'nameAr', label: messages.documentTypeNameAr, maxLength: 120 },
        {
          name: 'description',
          label: messages.manage.descriptionLabel,
          maxLength: 1000,
          multiline: true,
        },
        {
          name: 'descriptionAr',
          label: messages.manage.descriptionArLabel,
          maxLength: 1000,
          multiline: true,
        },
      ]}
      onConfirm={async (values) => {
        const body = changed(values);
        if (Object.keys(body).length === 0) return;
        await standardsApi.updateDocumentType(organizationId, documentType.id, body);
        await onChanged(messages.saved);
      }}
    />
  );
}
