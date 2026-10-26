import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewCheckPage from '@/app/[locale]/checks/new/page';
import { getChecksMessages } from '@/i18n/checks-messages';
import type * as ApiClient from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/checks/new',
  useParams: () => ({ locale: 'en' }),
}));

// The purchase panel has its own suite (check-billing.spec); here it only has
// to appear at the right moment.
vi.mock('@/components/check-billing', () => ({
  CheckPurchasePanel: () => <div data-testid="purchase-panel" />,
}));

const api = vi.hoisted(() => ({
  documents: vi.fn(),
  organizations: vi.fn(),
  documentTypes: vi.fn(),
  standards: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    documentsApi: { ...actual.documentsApi, list: api.documents },
    catalogueApi: {
      organizations: api.organizations,
      documentTypes: api.documentTypes,
      standards: api.standards,
    },
  };
});

const en = getChecksMessages('en');

function next() {
  return screen.getByRole('button', { name: en.next });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.documents.mockResolvedValue({
    items: [
      {
        id: 'd-1',
        displayName: 'Thesis — final',
        status: 'ACTIVE',
        latestVersion: { id: 'v-1', status: 'READY', versionNumber: 1 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'd-2',
        displayName: 'Still processing',
        status: 'ACTIVE',
        latestVersion: { id: 'v-2', status: 'PROCESSING', versionNumber: 1 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  });
  api.organizations.mockResolvedValue([
    {
      id: 'o-1',
      displayName: 'Birzeit University',
      slug: 'bzu',
      verificationStatus: 'VERIFIED',
      standardCount: 1,
    },
  ]);
  api.documentTypes.mockResolvedValue([
    {
      id: 't-1',
      organizationId: 'o-1',
      name: 'Thesis',
      nameAr: 'رسالة',
      systemCategory: 'THESIS',
      standardCount: 1,
    },
  ]);
  api.standards.mockResolvedValue([
    {
      id: 's-1',
      organizationId: 'o-1',
      organizationName: 'Birzeit University',
      documentTypeId: 't-1',
      documentTypeName: 'Thesis',
      code: 'BZU-THESIS',
      nameEn: 'Thesis format',
      nameAr: 'تنسيق الرسالة',
      versionLabel: '2026.1',
      ruleCount: 12,
    },
  ]);
});

describe('New check, step by step', () => {
  it('offers only documents that finished processing, and waits for a choice', async () => {
    render(<NewCheckPage />);
    const select = await screen.findByLabelText(en.chooseDocument);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Thesis — final' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('option', { name: 'Still processing' })).toBeNull();
    expect(next()).toBeDisabled();
    fireEvent.change(select, { target: { value: 'd-1' } });
    expect(next()).toBeEnabled();
  });

  it('walks through institution and standard, shows the choices, then the price', async () => {
    render(<NewCheckPage />);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Thesis — final' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(en.chooseDocument), { target: { value: 'd-1' } });
    fireEvent.click(next());

    expect(screen.getByRole('heading', { level: 2, name: en.stepInstitution })).toHaveFocus();
    expect(screen.queryByTestId('purchase-panel')).toBeNull();
    fireEvent.change(screen.getByLabelText(en.chooseOrganization), { target: { value: 'o-1' } });
    await waitFor(() => expect(api.documentTypes).toHaveBeenCalledWith('o-1'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Thesis' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.chooseDocumentType), { target: { value: 't-1' } });
    fireEvent.click(next());

    await waitFor(() => expect(api.standards).toHaveBeenCalledWith('t-1'));
    await waitFor(() => expect(screen.getByLabelText(en.chooseStandard)).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(en.chooseStandard), { target: { value: 's-1' } });
    fireEvent.click(next());

    expect(screen.getByRole('heading', { level: 2, name: en.stepConfirm })).toBeInTheDocument();
    expect(screen.getByText('Thesis — final')).toBeInTheDocument();
    expect(screen.getByText('Birzeit University')).toBeInTheDocument();
    expect(screen.getByText('Thesis format 2026.1')).toBeInTheDocument();
    expect(screen.getByTestId('purchase-panel')).toBeInTheDocument();
  });

  it('lets a choice be changed from the review, and says what is being changed', async () => {
    render(<NewCheckPage />);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Thesis — final' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(en.chooseDocument), { target: { value: 'd-1' } });
    fireEvent.click(next());
    fireEvent.change(screen.getByLabelText(en.chooseOrganization), { target: { value: 'o-1' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Thesis' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.chooseDocumentType), { target: { value: 't-1' } });
    fireEvent.click(next());
    await waitFor(() => expect(screen.getByLabelText(en.chooseStandard)).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(en.chooseStandard), { target: { value: 's-1' } });
    fireEvent.click(next());

    const changeDocument = screen
      .getAllByRole('button')
      .find((button) => button.textContent === `${en.change}: ${en.chooseDocument}`);
    expect(changeDocument).toBeDefined();
    fireEvent.click(changeDocument!);
    expect(screen.getByRole('heading', { level: 2, name: en.stepDocument })).toHaveFocus();
    expect(screen.getByLabelText(en.chooseDocument)).toHaveValue('d-1');
  });

  it('says plainly when no document is ready, and where to go', async () => {
    api.documents.mockResolvedValue({ items: [], nextCursor: null });
    render(<NewCheckPage />);
    expect(await screen.findByText(en.noReadyDocuments)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.goToDocuments })).toHaveAttribute(
      'href',
      '/en/documents',
    );
    expect(next()).toBeDisabled();
  });
});
