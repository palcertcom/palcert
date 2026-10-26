import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VersionEditorPage from '@/app/[locale]/organizations/[organizationId]/standards/[standardId]/versions/[versionId]/page';
import { getStandardsMessages } from '@/i18n/standards-messages';
import type * as ApiClient from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/organizations/org-1/standards/std-1/versions/ver-1',
  useParams: () => ({
    locale: 'en',
    organizationId: 'org-1',
    standardId: 'std-1',
    versionId: 'ver-1',
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const standards = vi.hoisted(() => ({
  version: vi.fn(),
  rules: vi.fn(),
  ruleSchema: vi.fn(),
  validateVersion: vi.fn(),
  publishVersion: vi.fn(),
  deleteRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  reorderRules: vi.fn(),
}));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, standardsApi: standards };
});

const permissions = vi.hoisted(() => ({
  value: new Set(['standard:definition:read', 'standard:version:publish', 'standard:rule:write']),
}));
vi.mock('@/components/organization-shell', () => ({
  OrganizationShell: ({ children }: { children: (state: unknown) => unknown }) =>
    children({
      organizationId: 'org-1',
      locale: 'en',
      permissions: permissions.value,
      organization: {},
      messages: {},
      reload: () => undefined,
    }),
}));

const en = getStandardsMessages('en');

function version(ruleCount: number) {
  return {
    id: 'ver-1',
    standardId: 'std-1',
    versionLabel: '2026',
    status: 'DRAFT',
    effectiveFrom: null,
    effectiveUntil: null,
    ruleCount,
    contentHash: null,
    canonicalizationVersion: null,
    ruleSchemaVersion: 2,
    revision: 3,
    publishedAt: null,
    publishedByUserId: null,
    archivedAt: null,
    clonedFromVersionId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

const RULE = {
  id: 'rule-1',
  ruleCode: 'MARGIN.LEFT',
  category: 'PAGE_LAYOUT',
  evaluationMode: 'DETERMINISTIC',
  scope: { kind: 'DOCUMENT' },
  operator: 'EQUALS',
  expected: { type: 'NUMBER', value: 30 },
  unit: 'MILLIMETRE',
  tolerance: null,
  severity: 'MAJOR',
  blocking: true,
  autofix: 'NONE',
  origin: 'MANUAL',
  originReference: null,
  titleEn: 'Left margin',
  titleAr: 'الهامش الأيسر',
  descriptionEn: null,
  descriptionAr: null,
  guidanceEn: null,
  guidanceAr: null,
  displayOrder: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  standards.ruleSchema.mockResolvedValue({ versions: [], current: 2 });
});

describe('the draft’s publish verdict', () => {
  it('does not keep saying "ready to publish" once the draft has changed', async () => {
    standards.version.mockResolvedValue(version(1));
    standards.rules.mockResolvedValue({ items: [RULE], nextCursor: null });
    standards.validateVersion.mockResolvedValue({ valid: true, ruleCount: 1, issues: [] });
    render(<VersionEditorPage />);

    fireEvent.click(await screen.findByRole('button', { name: en.validate }));
    expect(await screen.findByText(en.validationPassed)).toBeInTheDocument();

    // The only rule is deleted: the page reloads with none.
    standards.version.mockResolvedValue(version(0));
    standards.rules.mockResolvedValue({ items: [], nextCursor: null });
    standards.deleteRule.mockResolvedValue({ etag: '"4"' });
    fireEvent.click(screen.getByRole('button', { name: en.deleteRule }));

    await waitFor(() => {
      expect(standards.deleteRule).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText(en.validationPassed)).toBeNull();
    });
  });

  it('shows the empty draft as not ready, in the reader’s language', async () => {
    standards.version.mockResolvedValue(version(0));
    standards.rules.mockResolvedValue({ items: [], nextCursor: null });
    standards.validateVersion.mockResolvedValue({
      valid: false,
      ruleCount: 0,
      issues: [
        {
          ruleCode: null,
          path: 'rules',
          code: 'STANDARD_VERSION_EMPTY',
          message: 'A standard version must contain at least one rule before it can be published.',
        },
      ],
    });
    render(<VersionEditorPage />);

    fireEvent.click(await screen.findByRole('button', { name: en.validate }));
    expect(await screen.findByText(en.validationFailed)).toBeInTheDocument();
    expect(
      screen.getByText(en.errors['STANDARD_VERSION_EMPTY']!, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(en.validationPassed)).toBeNull();
  });
});
