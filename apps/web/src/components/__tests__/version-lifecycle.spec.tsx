import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishVersionButton, VersionHistoryNote, VersionRecordCard } from '../version-lifecycle';
import { getStandardsMessages } from '@/i18n/standards-messages';
import type * as ApiClient from '@/lib/api-client';
import type { StandardResponse, StandardVersionResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/organizations/org-1/standards/std-1',
  useParams: () => ({ locale: 'en', organizationId: 'org-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

const standards = vi.hoisted(() => ({
  standard: vi.fn(),
  publishVersion: vi.fn(),
  versionUsage: vi.fn(),
}));
const organization = vi.hoisted(() => ({ members: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, standardsApi: standards, organizationApi: organization };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getStandardsMessages('en');
const ar = getStandardsMessages('ar');

function version(overrides: Partial<StandardVersionResponse> = {}): StandardVersionResponse {
  return {
    id: 'ver-12',
    standardId: 'std-1',
    versionLabel: '1.2',
    status: 'DRAFT',
    effectiveFrom: null,
    effectiveUntil: null,
    ruleCount: 3,
    contentHash: null,
    canonicalizationVersion: null,
    ruleSchemaVersion: 2,
    revision: 4,
    publishedAt: null,
    publishedByUserId: null,
    archivedAt: null,
    supersededAt: null,
    supersededByVersionId: null,
    supersededByVersionLabel: null,
    clonedFromVersionId: null,
    importProvenance: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function standardWith(inForce: { id: string; label: string } | null): StandardResponse {
  return {
    id: 'std-1',
    publishedVersionId: inForce?.id ?? null,
    publishedVersionLabel: inForce?.label ?? null,
  } as StandardResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publishing over the version in force', () => {
  it('asks first, names both versions, and sends the one the author confirmed', async () => {
    standards.standard.mockResolvedValue(standardWith({ id: 'ver-10', label: '1.0' }));
    standards.publishVersion.mockResolvedValue(version({ status: 'PUBLISHED' }));
    const onPublished = vi.fn().mockResolvedValue(undefined);

    render(
      <PublishVersionButton
        organizationId="org-1"
        standardId="std-1"
        version={version()}
        locale="en"
        onPublished={onPublished}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.publish }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Publish version 1.2?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Version 1.0 is currently in force. Publishing 1.2 will make 1.2 the active version and ' +
          'retain 1.0 as a superseded historical version.',
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/archive it first/i);
    // Nothing is sent before the author confirms.
    expect(standards.publishVersion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish and replace 1.0' }));
    await waitFor(() => {
      expect(standards.publishVersion).toHaveBeenCalledWith('org-1', 'std-1', 'ver-12', 'ver-10');
    });
    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith(en.lifecycle.publishedReplacing('1.2', '1.0'));
    });
  });

  it('cancels without publishing anything', async () => {
    standards.standard.mockResolvedValue(standardWith({ id: 'ver-10', label: '1.0' }));
    render(
      <PublishVersionButton
        organizationId="org-1"
        standardId="std-1"
        version={version()}
        locale="en"
        onPublished={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.publish }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(standards.publishVersion).not.toHaveBeenCalled();
  });

  it('publishes a first version straight away, expecting nothing in force', async () => {
    standards.standard.mockResolvedValue(standardWith(null));
    standards.publishVersion.mockResolvedValue(version({ status: 'PUBLISHED' }));
    const onPublished = vi.fn().mockResolvedValue(undefined);
    render(
      <PublishVersionButton
        organizationId="org-1"
        standardId="std-1"
        version={version()}
        locale="en"
        onPublished={onPublished}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.publish }));
    await waitFor(() => {
      expect(standards.publishVersion).toHaveBeenCalledWith('org-1', 'std-1', 'ver-12', null);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(onPublished).toHaveBeenCalledWith(en.published);
    });
  });

  it('hands a conflict back to the page instead of swallowing it', async () => {
    standards.standard.mockResolvedValue(standardWith({ id: 'ver-10', label: '1.0' }));
    const conflict = new ApiError('CONFLICT', 'Version 1.1 is now the version in force.', 409);
    standards.publishVersion.mockRejectedValue(conflict);
    const onError = vi.fn();
    render(
      <PublishVersionButton
        organizationId="org-1"
        standardId="std-1"
        version={version()}
        locale="en"
        onPublished={vi.fn()}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.publish }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish and replace 1.0' }));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(conflict);
    });
  });

  it('asks in Arabic too', async () => {
    standards.standard.mockResolvedValue(standardWith({ id: 'ver-10', label: '1.0' }));
    render(
      <PublishVersionButton
        organizationId="org-1"
        standardId="std-1"
        version={version()}
        locale="ar"
        onPublished={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: ar.publish }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ar.lifecycle.confirmTitle('1.2'))).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: ar.lifecycle.confirmReplace('1.0') }),
    ).toBeInTheDocument();
  });
});

describe('version history', () => {
  it('says what replaced a superseded version and when', () => {
    render(
      <VersionHistoryNote
        locale="en"
        version={version({
          versionLabel: '1.0',
          status: 'SUPERSEDED',
          publishedAt: '2026-01-01T09:00:00.000Z',
          supersededAt: '2026-09-28T10:30:00.000Z',
          supersededByVersionId: 'ver-12',
          supersededByVersionLabel: '1.2',
        })}
      />,
    );
    expect(screen.getByText(/^Superseded by version 1\.2 on /)).toBeInTheDocument();
  });

  it('labels every lifecycle state distinctly in both languages', () => {
    for (const messages of [en, ar]) {
      const labels = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'].map(
        (status) => messages.versionStatuses[status],
      );
      expect(labels.every((label) => typeof label === 'string' && label.length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(4);
    }
    expect(en.versionStatuses.PUBLISHED).toMatch(/in force/i);
    expect(en.errors.STANDARD_VERSION_SUPERSEDED).toMatch(/clone/i);
    expect(ar.errors.STANDARD_VERSION_SUPERSEDED).toBeTruthy();
  });

  it('shows the record of a superseded version: publisher, successor and what relies on it', async () => {
    standards.versionUsage.mockResolvedValue({
      standardVersionId: 'ver-10',
      submissionCount: 3,
      certificateCount: 2,
    });
    organization.members.mockResolvedValue({
      items: [{ userId: 'user-1', displayName: 'Registrar', email: 'registrar@iug.test' }],
      nextCursor: null,
    });
    render(
      <VersionRecordCard
        organizationId="org-1"
        standardId="std-1"
        locale="en"
        canReadMembers
        version={version({
          id: 'ver-10',
          versionLabel: '1.0',
          status: 'SUPERSEDED',
          publishedAt: '2026-01-01T09:00:00.000Z',
          publishedByUserId: 'user-1',
          supersededAt: '2026-09-28T10:30:00.000Z',
          supersededByVersionId: 'ver-12',
          supersededByVersionLabel: '1.2',
        })}
      />,
    );

    expect(await screen.findByText('Registrar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1.2' })).toHaveAttribute(
      'href',
      '/en/organizations/org-1/standards/std-1/versions/ver-12',
    );
    const usage = await screen.findByTestId('version-usage');
    expect(within(usage).getByText('3')).toBeInTheDocument();
    expect(within(usage).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.lifecycle.viewCertificates })).toBeInTheDocument();
  });
});
