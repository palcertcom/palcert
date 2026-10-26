import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatCompatibility, PdfDocumentNotes } from '../format-compatibility';
import { getPdfMessages } from '@/i18n/pdf-messages';
import type * as ApiClient from '@/lib/api-client';
import type { StandardCompatibilityResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const compatibility = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, catalogueApi: { ...actual.catalogueApi, compatibility } };
});

const en = getPdfMessages('en');
const ar = getPdfMessages('ar');

function preview(
  overrides: Partial<StandardCompatibilityResponse> = {},
): StandardCompatibilityResponse {
  return {
    format: 'PDF',
    level: 'PARTIAL',
    totalRules: 3,
    supportedRules: 2,
    unsupportedRules: 1,
    rules: [
      {
        ruleCode: 'PAGE.COUNT.MIN',
        property: 'pageCount',
        support: 'EXACT',
        note: 'read from the page tree',
      },
      {
        ruleCode: 'FONT.SIZE.MIN',
        property: 'fontSize',
        support: 'EXACT',
        note: 'read from the text state',
      },
      {
        ruleCode: 'MARGIN.TOP.MIN',
        property: 'marginTop',
        support: 'UNSUPPORTED',
        note: 'a PDF stores no authoring margin; PalCert measures where ink starts instead',
      },
    ],
    unsupportedProperties: ['marginTop'],
    ...overrides,
  };
}

beforeEach(() => {
  compatibility.mockReset();
});

describe('Format compatibility preview', () => {
  it('says how much of the standard can be checked', async () => {
    compatibility.mockResolvedValue(preview());
    render(<FormatCompatibility standardId="s1" documentVersionId="v1" locale="en" />);

    await waitFor(() => {
      expect(screen.getByText(en.coverageLevels.PARTIAL!)).toBeInTheDocument();
    });
    expect(screen.getByText(en.coverageCounts(2, 3))).toBeInTheDocument();
  });

  it('names each requirement it cannot check, with a reason', async () => {
    compatibility.mockResolvedValue(preview());
    render(<FormatCompatibility standardId="s1" documentVersionId="v1" locale="en" />);

    await waitFor(() => {
      expect(screen.getByText('MARGIN.TOP.MIN')).toBeInTheDocument();
    });
    expect(screen.getByText(/measures where ink starts/)).toBeInTheDocument();
    // The requirements it *can* check are not listed as problems.
    expect(screen.queryByText('PAGE.COUNT.MIN')).not.toBeInTheDocument();
  });

  it('never lets a supported requirement read as a promised verdict', async () => {
    compatibility.mockResolvedValue(
      preview({ level: 'FULL', supportedRules: 3, unsupportedRules: 0, unsupportedProperties: [] }),
    );
    render(<FormatCompatibility standardId="s1" documentVersionId="v1" locale="en" />);

    await waitFor(() => {
      expect(screen.getByText(en.coverageLevels.FULL!)).toBeInTheDocument();
    });
    expect(screen.getByText(en.coverageNotAPromise)).toBeInTheDocument();
  });

  it('explains a refusal rather than showing an empty table', async () => {
    compatibility.mockResolvedValue(
      preview({ level: 'NONE', supportedRules: 0, unsupportedRules: 3 }),
    );
    render(<FormatCompatibility standardId="s1" documentVersionId="v1" locale="en" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(en.coverageNone);
    });
  });

  it('renders in Arabic for an Arabic reader', async () => {
    compatibility.mockResolvedValue(preview());
    render(<FormatCompatibility standardId="s1" documentVersionId="v1" locale="ar" />);

    await waitFor(() => {
      expect(screen.getByText(ar.coverageLevels.PARTIAL!)).toBeInTheDocument();
    });
    expect(screen.getByText(ar.coverageIntro)).toBeInTheDocument();
  });
});

describe('PDF document notes', () => {
  it('tells a user with a scan that nothing was read and what to do', () => {
    render(
      <PdfDocumentNotes
        locale="en"
        textLayer="IMAGE_ONLY"
        tagged={false}
        scannedPages={12}
        totalPages={12}
      />,
    );

    expect(screen.getByText(en.textLayers.IMAGE_ONLY!)).toBeInTheDocument();
    expect(screen.getByText(en.textLayerHints.IMAGE_ONLY!)).toBeInTheDocument();
    expect(screen.getByText(en.scannedAdvice)).toBeInTheDocument();
  });

  it('says how many pages of a hybrid document have no text', () => {
    render(
      <PdfDocumentNotes
        locale="en"
        textLayer="HYBRID"
        tagged={false}
        scannedPages={3}
        totalPages={40}
      />,
    );
    expect(screen.getByText(en.hybridPages(3, 40))).toBeInTheDocument();
  });

  it('does not nag a searchable document about scanning', () => {
    render(
      <PdfDocumentNotes
        locale="en"
        textLayer="NATIVE_TEXT"
        tagged
        scannedPages={0}
        totalPages={40}
      />,
    );
    expect(screen.queryByText(en.scannedAdvice)).not.toBeInTheDocument();
    expect(screen.getByText(en.tagged)).toBeInTheDocument();
    expect(screen.queryByText(en.untaggedExplanation)).not.toBeInTheDocument();
  });

  it('explains an untagged PDF instead of silently checking nothing', () => {
    render(
      <PdfDocumentNotes
        locale="en"
        textLayer="NATIVE_TEXT"
        tagged={false}
        scannedPages={0}
        totalPages={40}
      />,
    );
    expect(screen.getByText(en.untagged)).toBeInTheDocument();
    expect(screen.getByText(en.untaggedExplanation)).toBeInTheDocument();
  });

  it('says plainly that PalCert does not correct PDFs, in both languages', () => {
    const { unmount } = render(
      <PdfDocumentNotes
        locale="en"
        textLayer="NATIVE_TEXT"
        tagged
        scannedPages={0}
        totalPages={1}
      />,
    );
    expect(screen.getByText(en.smartFixUnavailable)).toBeInTheDocument();
    expect(screen.getByText(en.smartFixAdvice)).toBeInTheDocument();
    unmount();

    render(
      <PdfDocumentNotes
        locale="ar"
        textLayer="NATIVE_TEXT"
        tagged
        scannedPages={0}
        totalPages={1}
      />,
    );
    expect(screen.getByText(ar.smartFixUnavailable)).toBeInTheDocument();
    expect(screen.getByText(ar.smartFixAdvice)).toBeInTheDocument();
  });
});
