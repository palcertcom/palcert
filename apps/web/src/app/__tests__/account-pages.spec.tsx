import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AcceptInvitationPage from '../[locale]/invitations/accept/page';
import ProfilePage from '../[locale]/profile/page';
import VerifyEmailPage from '../[locale]/verify-email/page';
import { AUTH_MESSAGES } from '@/i18n/auth-messages';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import type * as ApiClient from '@/lib/api-client';
import type { UserProfileResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/en/profile',
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams('token=bad'),
}));

const api = vi.hoisted(() => ({
  me: vi.fn(),
  preview: vi.fn(),
  verifyEmail: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      me: api.me,
      verifyEmail: api.verifyEmail,
      changePassword: api.changePassword,
    },
    organizationApi: { ...actual.organizationApi, previewInvitation: api.preview },
  };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

function profile(overrides: Partial<UserProfileResponse> = {}): UserProfileResponse {
  return {
    id: 'u-1',
    email: 'lina@example.test',
    displayName: 'Lina',
    preferredLocale: 'en',
    status: 'ACTIVE',
    mfaEnrolled: false,
    emailVerified: true,
    roles: ['SERVICE_USER'],
    permissions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  } as UserProfileResponse;
}

beforeEach(() => vi.clearAllMocks());

describe('links that are not valid', () => {
  it('calls a malformed invitation link invalid, not a generic failure', async () => {
    api.preview.mockRejectedValue(new ApiError('VALIDATION_FAILED', 'bad', 400));
    render(<AcceptInvitationPage />);
    expect(
      await screen.findByText(getOrganizationMessages('en').errors.INVITATION_NOT_FOUND!),
    ).toBeInTheDocument();
  });

  it('calls a malformed email-confirmation link invalid', async () => {
    api.verifyEmail.mockRejectedValue(new ApiError('VALIDATION_FAILED', 'bad', 400));
    render(<VerifyEmailPage />);
    expect(
      await screen.findByText(AUTH_MESSAGES.en.errors.VERIFICATION_TOKEN_INVALID!),
    ).toBeInTheDocument();
  });
});

describe('ProfilePage', () => {
  it('names roles and status in words, and offers two-step sign-in while it is off', async () => {
    api.me.mockResolvedValue(profile());
    render(<ProfilePage />);
    const en = AUTH_MESSAGES.en;
    expect(await screen.findByText(en.accountRoleLabels.SERVICE_USER!)).toBeInTheDocument();
    expect(screen.getByText(en.accountStatusLabels.ACTIVE!)).toBeInTheDocument();
    expect(screen.queryByText('SERVICE_USER')).toBeNull();
    expect(screen.getByRole('link', { name: en.profileMfaSetUp })).toHaveAttribute(
      'href',
      '/en/mfa/enroll',
    );
  });

  it('does not offer enrollment once two-step sign-in is on', async () => {
    api.me.mockResolvedValue(profile({ mfaEnrolled: true }));
    render(<ProfilePage />);
    await screen.findByText(AUTH_MESSAGES.en.profileMfaOn);
    expect(screen.queryByRole('link', { name: AUTH_MESSAGES.en.profileMfaSetUp })).toBeNull();
  });
});

describe('ProfilePage — change password', () => {
  const en = AUTH_MESSAGES.en;

  async function openForm() {
    api.me.mockResolvedValue(profile({ permissions: ['password:change:self'] }));
    render(<ProfilePage />);
    await screen.findByRole('heading', { name: en.passwordChangeTitle });
    const fill = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    return {
      fill,
      submit: () => fireEvent.click(screen.getByRole('button', { name: en.passwordChangeTitle })),
    };
  }

  it('is offered only to an account allowed to change its password', async () => {
    api.me.mockResolvedValue(profile({ permissions: [] }));
    render(<ProfilePage />);
    await screen.findByText(en.accountRoleLabels.SERVICE_USER!);
    expect(screen.queryByRole('heading', { name: en.passwordChangeTitle })).toBeNull();
  });

  it('catches a mismatch before sending anything', async () => {
    const form = await openForm();
    form.fill(en.currentPassword, 'old-password-123');
    form.fill(en.newPassword, 'new-password-456');
    form.fill(en.confirmPassword, 'new-password-789');
    form.submit();
    expect(await screen.findByText(en.passwordMismatch)).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('says the current password is wrong, not the email address', async () => {
    api.changePassword.mockRejectedValue(new ApiError('AUTHENTICATION_FAILED', 'no', 401));
    const form = await openForm();
    form.fill(en.currentPassword, 'wrong-password-1');
    form.fill(en.newPassword, 'new-password-456');
    form.fill(en.confirmPassword, 'new-password-456');
    form.submit();
    expect(await screen.findByText(en.currentPasswordWrong)).toBeInTheDocument();
  });

  it('changes it, clears the fields and says what happened to other sessions', async () => {
    api.changePassword.mockResolvedValue({ acknowledged: true });
    const form = await openForm();
    form.fill(en.currentPassword, 'old-password-123');
    form.fill(en.newPassword, 'new-password-456');
    form.fill(en.confirmPassword, 'new-password-456');
    form.submit();
    expect(await screen.findByText(en.passwordChanged)).toBeInTheDocument();
    expect(api.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-password-123',
      newPassword: 'new-password-456',
    });
    expect(screen.getByLabelText(en.newPassword)).toHaveValue('');
  });
});
