import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditDocumentType, StandardManagement, VersionManagement } from '../standards-manage';
import TeamPage from '@/app/[locale]/organizations/[organizationId]/team/page';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import type * as ApiClient from '@/lib/api-client';
import type * as OrganizationMessages from '@/i18n/organization-messages';
import type {
  DocumentTypeResponse,
  OrganizationMemberResponse,
  StandardResponse,
  StandardVersionResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/organizations/org-1/team',
  useParams: () => ({ locale: 'en', organizationId: 'org-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

const standards = vi.hoisted(() => ({
  setCheckAvailability: vi.fn(),
  updateStandard: vi.fn(),
  archiveStandard: vi.fn(),
  restoreStandard: vi.fn(),
  updateVersion: vi.fn(),
  archiveVersion: vi.fn(),
  snapshot: vi.fn(),
  updateDocumentType: vi.fn(),
}));
const organization = vi.hoisted(() => ({
  members: vi.fn(),
  removeRole: vi.fn(),
  transferOwnership: vi.fn(),
  assignRole: vi.fn(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, standardsApi: standards, organizationApi: organization };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const shellPermissions = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock('@/components/organization-shell', async () => {
  const { getOrganizationMessages: messagesFor } = await vi.importActual<
    typeof OrganizationMessages
  >('@/i18n/organization-messages');
  return {
    OrganizationShell: ({ children }: { children: (state: unknown) => unknown }) =>
      children({
        organizationId: 'org-1',
        locale: 'en',
        permissions: shellPermissions.value,
        organization: {},
        messages: messagesFor('en'),
        reload: () => undefined,
      }),
  };
});

const en = getStandardsMessages('en');
const org = getOrganizationMessages('en');

const STANDARD: StandardResponse = {
  id: 'std-1',
  documentTypeId: 'dt-1',
  documentTypeName: 'Thesis',
  documentTypeCategory: 'ACADEMIC',
  code: 'THESIS',
  checkAvailability: 'PRIVATE',
  nameEn: 'Thesis format',
  nameAr: 'تنسيق الرسالة',
  descriptionEn: null,
  descriptionAr: null,
  status: 'ACTIVE',
  versionCount: 1,
  publishedVersionId: 'ver-1',
  publishedVersionLabel: '2026',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function version(status: string): StandardVersionResponse {
  return {
    id: 'ver-1',
    standardId: 'std-1',
    versionLabel: '2026 edition',
    status,
    effectiveFrom: null,
    effectiveUntil: null,
    ruleCount: 3,
    contentHash: null,
    canonicalizationVersion: null,
    ruleSchemaVersion: 1,
    revision: 2,
    publishedAt: null,
    publishedByUserId: null,
    archivedAt: null,
    clonedFromVersionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as StandardVersionResponse;
}

/** A field label, which may carry an "(optional)" suffix after it. */
function startsWith(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

function confirmInDialog(label: string): void {
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('standard management', () => {
  const onChanged = vi.fn().mockResolvedValue(undefined);

  it('publishes a standard to the check catalogue only after confirmation', async () => {
    standards.setCheckAvailability.mockResolvedValue(undefined);
    render(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={STANDARD}
        permissions={new Set(['standard:check-availability:manage'])}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText(en.manage.cataloguePrivate)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.manage.addToCatalogue }));
    expect(standards.setCheckAvailability).not.toHaveBeenCalled();
    confirmInDialog(en.manage.addToCatalogue);
    await waitFor(() => {
      expect(standards.setCheckAvailability).toHaveBeenCalledWith(
        'org-1',
        'std-1',
        'PUBLIC_CHECKABLE',
      );
    });
    expect(onChanged).toHaveBeenCalledWith(en.manage.catalogueChanged);
  });

  it('shows every control only for the permission behind it', () => {
    const { rerender } = render(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={STANDARD}
        permissions={new Set()}
        onChanged={onChanged}
      />,
    );
    // The state is visible to any reader; the actions are not.
    expect(screen.getByText(en.manage.cataloguePrivate)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.manage.addToCatalogue })).toBeNull();
    expect(screen.queryByRole('button', { name: en.manage.editStandard })).toBeNull();
    expect(screen.queryByRole('button', { name: en.manage.archiveStandard })).toBeNull();

    rerender(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={STANDARD}
        permissions={new Set(['standard:definition:update'])}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole('button', { name: en.manage.editStandard })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.manage.archiveStandard })).toBeNull();
  });

  it('sends only the fields that were filled in', async () => {
    standards.updateStandard.mockResolvedValue(undefined);
    render(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={STANDARD}
        permissions={new Set(['standard:definition:update'])}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.manage.editStandard }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(startsWith(en.nameEn)), {
      target: { value: '  Thesis layout  ' },
    });
    confirmInDialog(en.save);
    await waitFor(() => {
      expect(standards.updateStandard).toHaveBeenCalledWith('org-1', 'std-1', {
        nameEn: 'Thesis layout',
      });
    });
  });

  it('offers restore, not edit or catalogue changes, for an archived standard', () => {
    render(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={{ ...STANDARD, status: 'ARCHIVED' }}
        permissions={
          new Set([
            'standard:definition:update',
            'standard:definition:archive',
            'standard:check-availability:manage',
          ])
        }
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole('button', { name: en.manage.restoreStandard })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.manage.editStandard })).toBeNull();
    expect(screen.queryByRole('button', { name: en.manage.addToCatalogue })).toBeNull();
  });

  it('keeps a failure inside the dialog, in words', async () => {
    standards.setCheckAvailability.mockRejectedValue(new ApiError('SOMETHING_ODD', 'x', 409));
    render(
      <StandardManagement
        locale="en"
        organizationId="org-1"
        standard={{ ...STANDARD, checkAvailability: 'PUBLIC_CHECKABLE' }}
        permissions={new Set(['standard:check-availability:manage'])}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.manage.withdrawFromCatalogue }));
    confirmInDialog(en.manage.withdrawFromCatalogue);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).not.toContain('SOMETHING_ODD');
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('version management', () => {
  const onChanged = vi.fn().mockResolvedValue(undefined);

  it('edits a draft and never offers to archive it', () => {
    render(
      <VersionManagement
        locale="en"
        organizationId="org-1"
        standardId="std-1"
        version={version('DRAFT')}
        permissions={new Set(['standard:version:update', 'standard:version:archive'])}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole('button', { name: en.manage.editDraft })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.manage.archiveVersion })).toBeNull();
    expect(screen.queryByRole('button', { name: en.manage.downloadSnapshot })).toBeNull();
  });

  it('archives a published version and downloads exactly what was published', async () => {
    standards.snapshot.mockResolvedValue({ rules: [] });
    standards.archiveVersion.mockResolvedValue(undefined);
    const createObjectURL = vi.fn(() => 'blob:snapshot');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(
      <VersionManagement
        locale="en"
        organizationId="org-1"
        standardId="std-1"
        version={version('PUBLISHED')}
        permissions={new Set(['standard:version:archive'])}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.manage.downloadSnapshot }));
    await waitFor(() => {
      expect(standards.snapshot).toHaveBeenCalledWith('org-1', 'std-1', 'ver-1');
    });
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:snapshot');
    });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: en.manage.archiveVersion }));
    confirmInDialog(en.manage.archiveVersion);
    await waitFor(() => {
      expect(standards.archiveVersion).toHaveBeenCalledWith('org-1', 'std-1', 'ver-1');
    });
  });

  it('offers a superseded version for download but never for archiving', () => {
    render(
      <VersionManagement
        locale="en"
        organizationId="org-1"
        standardId="std-1"
        version={{
          ...version('SUPERSEDED'),
          publishedAt: '2026-01-02T00:00:00.000Z',
          supersededAt: '2026-02-01T00:00:00.000Z',
          supersededByVersionId: 'ver-2',
          supersededByVersionLabel: '1.2',
        }}
        permissions={new Set(['standard:version:update', 'standard:version:archive'])}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByRole('button', { name: en.manage.downloadSnapshot })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.manage.archiveVersion })).toBeNull();
    expect(screen.queryByRole('button', { name: en.manage.editDraft })).toBeNull();
  });

  it('renders nothing for a reader of a draft', () => {
    const { container } = render(
      <VersionManagement
        locale="en"
        organizationId="org-1"
        standardId="std-1"
        version={version('DRAFT')}
        permissions={new Set()}
        onChanged={onChanged}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('document types', () => {
  it('renames a document type', async () => {
    standards.updateDocumentType.mockResolvedValue(undefined);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <EditDocumentType
        locale="en"
        organizationId="org-1"
        documentType={{ id: 'dt-1', name: 'Thesis' } as DocumentTypeResponse}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.manage.editDocumentType }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText(`${en.documentTypeName} (${en.manage.optional})`),
      {
        target: { value: 'Master’s thesis' },
      },
    );
    confirmInDialog(en.save);
    await waitFor(() => {
      expect(standards.updateDocumentType).toHaveBeenCalledWith('org-1', 'dt-1', {
        name: 'Master’s thesis',
      });
    });
    expect(onChanged).toHaveBeenCalledWith(en.saved);
  });
});

describe('team: removing a role and handing over ownership', () => {
  const OWNER: OrganizationMemberResponse = {
    membershipId: 'm-owner',
    userId: 'u-owner',
    email: 'owner@example.com',
    displayName: 'Owner',
    status: 'ACTIVE',
    roles: ['ORGANIZATION_OWNER'],
    joinedAt: '2026-01-01T00:00:00.000Z',
    suspendedAt: null,
  };
  const REVIEWER: OrganizationMemberResponse = {
    membershipId: 'm-rev',
    userId: 'u-rev',
    email: 'reviewer@example.com',
    displayName: 'Reviewer',
    status: 'ACTIVE',
    roles: ['REVIEWER'],
    joinedAt: '2026-01-02T00:00:00.000Z',
    suspendedAt: null,
  };

  beforeEach(() => {
    organization.members.mockResolvedValue({ items: [OWNER, REVIEWER], nextCursor: null });
  });

  it('offers neither control to someone without the permissions', async () => {
    shellPermissions.value = new Set(['organization:member:read']);
    render(<TeamPage />);
    await screen.findByText('reviewer@example.com');
    expect(
      screen.queryByRole('button', { name: new RegExp(org.teamManage.removeRole) }),
    ).toBeNull();
    expect(screen.queryByText(org.teamManage.transferTitle)).toBeNull();
  });

  it('removes one role after confirmation', async () => {
    shellPermissions.value = new Set(['organization:member:read', 'organization:role:remove']);
    organization.removeRole.mockResolvedValue({ roles: [] });
    render(<TeamPage />);
    await screen.findByText('reviewer@example.com');
    const reviewerLabel = org.roleLabels['REVIEWER'] ?? 'REVIEWER';
    fireEvent.click(
      screen.getByRole('button', { name: `${org.teamManage.removeRole}: ${reviewerLabel}` }),
    );
    confirmInDialog(org.teamManage.removeRole);
    await waitFor(() => {
      expect(organization.removeRole).toHaveBeenCalledWith('org-1', 'm-rev', 'REVIEWER');
    });
    expect(await screen.findByText(org.teamManage.roleRemoved)).toBeInTheDocument();
  });

  it('hands ownership only to an active non-owner, and asks for a fresh sign-in when needed', async () => {
    shellPermissions.value = new Set([
      'organization:member:read',
      'organization:ownership:transfer',
    ]);
    organization.transferOwnership.mockRejectedValueOnce(
      new ApiError('REAUTHENTICATION_REQUIRED', 'sign in again', 403),
    );
    render(<TeamPage />);
    await screen.findByText('reviewer@example.com');
    fireEvent.click(screen.getByRole('button', { name: org.teamManage.transfer }));
    const dialog = screen.getByRole('dialog');
    const select = within(dialog).getByLabelText(startsWith(org.teamManage.transferTo));
    const options = within(select).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('value'))).toEqual(['m-rev']);

    confirmInDialog(org.teamManage.transfer);
    await waitFor(() => {
      expect(organization.transferOwnership).toHaveBeenCalledWith('org-1', 'm-rev', true);
    });
    expect(await within(dialog).findByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining('/en/login?next='),
    );
  });
});
