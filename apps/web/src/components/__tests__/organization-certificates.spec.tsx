import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationCertificatesPage from '@/app/[locale]/organizations/[organizationId]/certificates/page';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import type * as ApiClient from '@/lib/api-client';
import type { OrganizationCertificateListEntryResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/organizations/org-1/certificates',
  useParams: () => ({ locale: 'en', organizationId: 'org-1' }),
}));

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), download: vi.fn() }));
const shell = vi.hoisted(() => ({
  permissions: new Set<string>(['certificate:record:read']),
  locale: 'en' as 'en' | 'ar',
}));

vi.mock('@/components/organization-shell', () => ({
  OrganizationShell: ({ children }: { children: (state: unknown) => unknown }) =>
    children({
      organizationId: 'org-1',
      locale: shell.locale,
      permissions: shell.permissions,
      organization: {},
      messages: {},
      reload: () => undefined,
    }),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, certificateReviewApi: api };
});

const en = getCertificatesMessages('en');

const ISSUED: OrganizationCertificateListEntryResponse = {
  id: 'cert-1',
  certificateNumber: 'PC-DK279DEX-VTXKM84W-8GKG8ERZ-EBV2FJCC',
  issuanceStatus: 'ISSUED',
  submissionId: 'sub-1',
  holder: { displayName: 'Layla Haddad', email: 'layla@example.com' },
  documentTypeName: 'Master’s thesis',
  documentFormat: 'DOCX',
  standardCode: 'IUG.THESIS',
  standardName: 'Thesis formatting',
  standardVersionLabel: '2.0',
  issuedAt: '2026-09-01T10:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  createdAt: '2026-09-01T09:59:00.000Z',
};

const REVOKED: OrganizationCertificateListEntryResponse = {
  ...ISSUED,
  id: 'cert-2',
  certificateNumber: 'PC-AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD',
  issuanceStatus: 'REVOKED',
  holder: null,
  revokedAt: '2026-09-10T10:00:00.000Z',
  revocationReason: 'ISSUED_IN_ERROR',
};

beforeEach(() => {
  vi.clearAllMocks();
  shell.permissions = new Set(['certificate:record:read']);
  shell.locale = 'en';
  api.list.mockResolvedValue({ items: [ISSUED, REVOKED], nextCursor: null });
});

describe('Organization certificates', () => {
  it('downloads an issued certificate, and offers nothing for a revoked one', async () => {
    api.download.mockResolvedValue({
      method: 'GET',
      url: 'https://storage.test/cert-signed',
      expiresAt: '2026-09-01T10:05:00.000Z',
      filename: 'certificate.pdf',
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    try {
      render(<OrganizationCertificatesPage />);
      const button = await screen.findByRole('button', {
        name: `${en.download}: ${ISSUED.certificateNumber}`,
      });
      expect(
        screen.queryByRole('button', { name: `${en.download}: ${REVOKED.certificateNumber}` }),
      ).toBeNull();
      fireEvent.click(button);
      await waitFor(() => {
        expect(api.download).toHaveBeenCalledWith('org-1', 'cert-1');
      });
      await waitFor(() => {
        expect(assign).toHaveBeenCalledWith('https://storage.test/cert-signed');
      });
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true });
    }
  });

  it('lists each certificate with its number, holder, status and submission', async () => {
    render(<OrganizationCertificatesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: en.register.title })).toBeTruthy();

    const table = await screen.findByRole('table');
    const number = within(table).getByRole('link', { name: ISSUED.certificateNumber! });
    expect(number.getAttribute('href')).toBe('/en/organizations/org-1/certificates/cert-1');
    expect(within(table).getByText('Layla Haddad')).toBeTruthy();
    expect(within(table).getByText(en.register.holderUnknown)).toBeTruthy();
    expect(within(table).getByText(en.issuanceStatuses['REVOKED']!)).toBeTruthy();
    const submissions = within(table).getAllByRole('link', { name: en.register.openSubmission });
    expect(submissions[0]!.getAttribute('href')).toBe('/en/organizations/org-1/submissions/sub-1');

    expect(api.list).toHaveBeenCalledWith('org-1', { limit: 25 });
  });

  it('searches and filters through the API, not in the browser', async () => {
    render(<OrganizationCertificatesPage />);
    await screen.findByRole('table');

    fireEvent.change(screen.getByLabelText(en.register.searchLabel), {
      target: { value: '  pc-dk279dex  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.register.search }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith('org-1', { q: 'pc-dk279dex', limit: 25 }),
    );

    fireEvent.click(screen.getByRole('button', { name: en.register.filters['REVOKED']! }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith('org-1', {
        status: 'REVOKED',
        q: 'pc-dk279dex',
        limit: 25,
      }),
    );
    expect(
      screen
        .getByRole('button', { name: en.register.filters['REVOKED']! })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('pages with the cursor the API returned', async () => {
    api.list.mockResolvedValueOnce({ items: [ISSUED], nextCursor: 'cursor-2' });
    api.list.mockResolvedValueOnce({ items: [REVOKED], nextCursor: null });
    render(<OrganizationCertificatesPage />);

    fireEvent.click(await screen.findByRole('button', { name: en.register.loadMore }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(api.list).toHaveBeenLastCalledWith('org-1', { cursor: 'cursor-2', limit: 25 });
    expect(screen.queryByRole('button', { name: en.register.loadMore })).toBeNull();
  });

  it('distinguishes an empty register from a search with no matches', async () => {
    api.list.mockResolvedValue({ items: [], nextCursor: null });
    render(<OrganizationCertificatesPage />);
    expect(await screen.findByText(en.register.emptyTitle)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.register.filters['FAILED']! }));
    expect(await screen.findByText(en.register.noMatches)).toBeTruthy();
  });

  it('reports an API failure instead of an empty list', async () => {
    const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');
    api.list.mockRejectedValue(new ApiError('ORGANIZATION_ACCESS_DENIED', 'no', 403));
    render(<OrganizationCertificatesPage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission/i);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not call the API for a member without certificate:record:read', async () => {
    shell.permissions = new Set(['standard:definition:read']);
    render(<OrganizationCertificatesPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('renders in Arabic with the number kept left to right', async () => {
    shell.locale = 'ar';
    const ar = getCertificatesMessages('ar');
    render(<OrganizationCertificatesPage />);
    expect(await screen.findByRole('heading', { level: 1, name: ar.register.title })).toBeTruthy();
    const code = (await screen.findByText(ISSUED.certificateNumber!)).closest('code');
    expect(code?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: ar.register.filters['ISSUED']! })).toBeTruthy();
  });
});
