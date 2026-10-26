import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExportStandardButton,
  ImportProvenanceCard,
  StandardImportWizard,
} from '../standard-transfer';
import { getStandardTransferMessages } from '@/i18n/standard-transfer-messages';
import type * as ApiClient from '@/lib/api-client';
import type { StandardImportPreviewResponse, StandardVersionResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/en/organizations/org-b/standards/import',
  useParams: () => ({ locale: 'en', organizationId: 'org-b' }),
  useSearchParams: () => new URLSearchParams(),
}));

const standards = vi.hoisted(() => ({
  exportVersion: vi.fn(),
  previewImport: vi.fn(),
  importStandard: vi.fn(),
}));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, standardsApi: standards };
});
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getStandardTransferMessages('en');
const ar = getStandardTransferMessages('ar');

function rule(code: string, number: number, index: number, valid = true) {
  return {
    index,
    ruleCode: code,
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    operator: 'EQUALS',
    unit: 'CENTIMETRE',
    tolerance: 0.1,
    severity: 'MAJOR',
    blocking: true,
    titleEn: `${code} title`,
    titleAr: 'عنوان',
    displayOrder: index,
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    expected: { type: 'NUMBER', number },
    valid,
    issues: valid ? [] : [{ path: 'unit', code: 'INVALID', message: 'unit is not a known unit.' }],
  };
}

function preview(
  overrides: Partial<StandardImportPreviewResponse> = {},
): StandardImportPreviewResponse {
  return {
    packageHash: `sha256:${'a'.repeat(64)}`,
    formatVersion: 1,
    exportedAt: '2026-09-30T00:00:00.000Z',
    integrity: 'VERIFIED',
    signatureCount: 0,
    source: {
      organizationName: 'Islamic University of Gaza',
      standardCode: 'IUG-PHD',
      standardNameEn: 'PhD Thesis Standard',
      standardNameAr: 'معيار رسائل الدكتوراه',
      versionLabel: '1.4',
      versionStatus: 'PUBLISHED',
    },
    standard: {
      code: 'IUG-PHD',
      nameEn: 'PhD Thesis Standard',
      nameAr: 'معيار رسائل الدكتوراه',
      descriptionEn: null,
      descriptionAr: null,
    },
    documentType: { systemCategory: 'THESIS', name: 'PhD Thesis' },
    version: { versionLabel: '1.4', effectiveFrom: null, effectiveUntil: null },
    schema: {
      sourceRuleSchemaVersion: 2,
      importRuleSchemaVersion: 2,
      upgraded: false,
      canonicalizationVersion: 1,
    },
    ruleCount: 3,
    validRuleCount: 3,
    invalidRuleCount: 0,
    rules: [rule('MARGINS.TOP', 3, 0), rule('MARGINS.LEFT', 3.5, 1), rule('HEADING1.SIZE', 14, 2)],
    destination: {
      existingStandardWithCode: null,
      documentTypes: [
        { id: 'dt-1', name: 'Doctoral thesis', systemCategory: 'THESIS', matchesCategory: true },
      ],
      standards: [
        {
          id: 'std-b',
          code: 'AQU-PHD',
          nameEn: 'Al-Aqsa PhD',
          nameAr: 'دكتوراه الأقصى',
          documentTypeCategory: 'THESIS',
          status: 'ACTIVE',
          compatible: true,
          versionLabels: ['1.0'],
          draftCount: 1,
        },
      ],
    },
    previousImports: [],
    warnings: [],
    canImport: true,
    ...overrides,
  } as StandardImportPreviewResponse;
}

async function upload(text = '{"format":"PALCERT_STANDARD"}') {
  const input = screen.getByLabelText(en.chooseFile);
  const file = new File([text], 'IUG-PHD-1.4.palcert.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByTestId('import-summary');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('import wizard', () => {
  it('previews before creating anything, then imports exactly what was previewed as a draft', async () => {
    standards.previewImport.mockResolvedValue(preview());
    standards.importStandard.mockResolvedValue({ standardId: 'new-std', versionId: 'new-ver' });
    render(<StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />);
    await upload('{"exact":"text"}');

    expect(standards.previewImport).toHaveBeenCalledWith('org-b', '{"exact":"text"}');
    expect(standards.importStandard).not.toHaveBeenCalled();
    const summary = screen.getByTestId('import-summary');
    expect(within(summary).getByText('Islamic University of Gaza')).toBeInTheDocument();
    expect(within(summary).getByText(`✓ ${en.integrityVerified}`)).toBeInTheDocument();
    expect(screen.getByTestId('import-rule-count')).toHaveTextContent(
      '3 rules found · 3 valid · 0 need attention',
    );
    expect(screen.getByText('3.5 cm ±0.1')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(en.documentType), { target: { value: 'dt-1' } });
    fireEvent.click(screen.getByRole('button', { name: en.importButton }));
    await waitFor(() => {
      expect(standards.importStandard).toHaveBeenCalledWith('org-b', {
        package: '{"exact":"text"}',
        packageHash: `sha256:${'a'.repeat(64)}`,
        mode: 'NEW_STANDARD',
        versionLabel: '1.4',
        code: 'IUG-PHD',
        nameEn: 'PhD Thesis Standard',
        nameAr: 'معيار رسائل الدكتوراه',
        documentTypeId: 'dt-1',
      });
    });
    expect(push).toHaveBeenCalledWith('/en/organizations/org-b/standards/new-std/versions/new-ver');
  });

  it('filters rules and shows a rule’s issues in its details row', async () => {
    standards.previewImport.mockResolvedValue(
      preview({
        rules: [rule('MARGINS.TOP', 3, 0), rule('BAD.UNIT', 1, 1, false)],
        ruleCount: 2,
        validRuleCount: 1,
        invalidRuleCount: 1,
        canImport: false,
      }),
    );
    render(<StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />);
    await upload();

    fireEvent.click(screen.getByLabelText(en.invalidOnly));
    expect(screen.queryByText('MARGINS.TOP')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.details }));
    expect(screen.getByText(/unit is not a known unit/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(en.invalidOnly));
    fireEvent.change(screen.getByLabelText(en.search), { target: { value: 'margins.top' } });
    expect(screen.getByText('MARGINS.TOP')).toBeInTheDocument();
    expect(screen.queryByText('BAD.UNIT')).toBeNull();

    // Invalid rules block the import outright.
    expect(screen.getByText(en.invalidBlocks)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.importButton })).toBeDisabled();
  });

  it('never overwrites a standard with the same code: change it, or import as a version', async () => {
    const existing = preview().destination.standards[0]!;
    standards.previewImport.mockResolvedValue(
      preview({
        destination: {
          ...preview().destination,
          existingStandardWithCode: { ...existing, id: 'std-same', code: 'IUG-PHD' },
          standards: [{ ...existing, id: 'std-same', code: 'IUG-PHD' }],
        },
      }),
    );
    render(<StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />);
    await upload();

    expect(screen.getByText(en.codeTakenTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.importButton })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: en.importAsVersion }));
    expect(screen.getByLabelText(en.existingStandard)).toHaveValue('std-same');
    expect(screen.getByText(en.draftsAlready(1))).toBeInTheDocument();
  });

  it('requires a deliberate choice to import the same package again', async () => {
    standards.previewImport.mockResolvedValue(
      preview({
        previousImports: [
          {
            importedAt: '2026-09-29T10:00:00.000Z',
            standardId: 's',
            standardCode: 'IUG-PHD',
            versionId: 'v',
            versionLabel: '1.4',
          },
        ],
      }),
    );
    standards.importStandard.mockResolvedValue({ standardId: 's2', versionId: 'v2' });
    render(<StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />);
    await upload();
    fireEvent.change(screen.getByLabelText(en.documentType), { target: { value: 'dt-1' } });

    expect(screen.getByText(en.duplicateTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.importButton })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(en.acknowledgeDuplicate));
    fireEvent.click(screen.getByRole('button', { name: en.importButton }));
    await waitFor(() => {
      expect(standards.importStandard).toHaveBeenCalledWith(
        'org-b',
        expect.objectContaining({ acknowledgeDuplicate: true }),
      );
    });
  });

  it('shows a refused file in words, and in Arabic too', async () => {
    standards.previewImport.mockRejectedValue(
      new ApiError('STANDARD_IMPORT_INTEGRITY_FAILED', 'integrity', 422),
    );
    const { unmount } = render(
      <StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />,
    );
    const input = screen.getByLabelText(en.chooseFile);
    const file = new File(['{}'], 'x.palcert.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') });
    fireEvent.change(input, { target: { files: [file] } });
    expect(
      await screen.findByText(en.errors.STANDARD_IMPORT_INTEGRITY_FAILED!),
    ).toBeInTheDocument();
    unmount();

    standards.previewImport.mockResolvedValue(preview());
    render(<StandardImportWizard organizationId="org-b" locale="ar" canCreateStandard />);
    const arInput = screen.getByLabelText(ar.chooseFile);
    const arFile = new File(['{}'], 'x.palcert.json');
    Object.defineProperty(arFile, 'text', { value: () => Promise.resolve('{}') });
    fireEvent.change(arInput, { target: { files: [arFile] } });
    await screen.findByTestId('import-summary');
    expect(screen.getByRole('button', { name: ar.importButton })).toBeInTheDocument();
    expect(screen.getByText(ar.draftOnly)).toBeInTheDocument();
  });

  it('refuses an oversized file before uploading it', async () => {
    render(<StandardImportWizard organizationId="org-b" locale="en" canCreateStandard />);
    const file = new File(['x'], 'big.palcert.json');
    Object.defineProperty(file, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText(en.chooseFile), { target: { files: [file] } });
    expect(await screen.findByText(en.fileTooLarge(5))).toBeInTheDocument();
    expect(standards.previewImport).not.toHaveBeenCalled();
  });
});

describe('export and provenance', () => {
  const version = {
    id: 'ver-1',
    standardId: 'std-1',
    versionLabel: '1.2',
    status: 'DRAFT',
    publishedAt: null,
    importProvenance: {
      importId: 'imp-1',
      importedAt: '2026-09-30T08:00:00.000Z',
      importedByUserId: 'user-1',
      packageHash: `sha256:${'b'.repeat(64)}`,
      formatVersion: 1,
      sourceOrganizationName: 'Islamic University of Gaza',
      sourceStandardCode: 'IUG-PHD',
      sourceStandardNameEn: 'PhD Thesis Standard',
      sourceStandardNameAr: 'معيار رسائل الدكتوراه',
      sourceVersionLabel: '1.4',
      sourceVersionStatus: 'PUBLISHED',
      sourceRuleSchemaVersion: 2,
      importRuleSchemaVersion: 2,
      ruleCount: 47,
      createdStandard: true,
    },
  } as unknown as StandardVersionResponse;

  it('downloads the file the server named', async () => {
    standards.exportVersion.mockResolvedValue({ fileName: 'IUG-PHD-1.2.palcert.json', text: '{}' });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(
      <ExportStandardButton
        organizationId="org-a"
        standardId="std-1"
        version={version}
        locale="en"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.exportStandard }));
    await waitFor(() => {
      expect(standards.exportVersion).toHaveBeenCalledWith('org-a', 'std-1', 'ver-1');
    });
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1);
    });
    click.mockRestore();
  });

  it('shows where a draft came from, and that it is not adopted until published', () => {
    render(<ImportProvenanceCard version={version} locale="en" />);
    expect(screen.getByText(en.provenanceTitle)).toBeInTheDocument();
    expect(screen.getByText('Islamic University of Gaza')).toBeInTheDocument();
    expect(screen.getByText('1.4')).toBeInTheDocument();
    expect(screen.getByText(en.provenanceNotice)).toBeInTheDocument();
  });

  it('says nothing for a version that was not imported', () => {
    const { container } = render(
      <ImportProvenanceCard version={{ ...version, importProvenance: null }} locale="ar" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
