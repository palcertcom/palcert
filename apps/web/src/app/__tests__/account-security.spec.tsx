import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '../[locale]/login/page';
import ProfilePage from '../[locale]/profile/page';
import RegisterPage from '../[locale]/register/page';
import VerifyEmailPage from '../[locale]/verify-email/page';
import { ResendVerification, RESEND_COOLDOWN_MS } from '@/components/resend-verification';
import { AI_MESSAGES } from '@/i18n/ai-messages';
import { AUTH_MESSAGES } from '@/i18n/auth-messages';
import type * as ApiClient from '@/lib/api-client';
import type { AIConsentResponse, UserProfileResponse } from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/en/profile',
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams('token=expired'),
}));

const api = vi.hoisted(() => ({
  me: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  disableMfa: vi.fn(),
  consent: vi.fn(),
  withdrawConsent: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      me: api.me,
      login: api.login,
      register: api.register,
      verifyEmail: api.verifyEmail,
      resendVerification: api.resendVerification,
      disableMfa: api.disableMfa,
    },
    aiApi: { ...actual.aiApi, consent: api.consent, withdrawConsent: api.withdrawConsent },
  };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');
const en = AUTH_MESSAGES.en;
const ai = AI_MESSAGES.en;

function profile(overrides: Partial<UserProfileResponse> = {}): UserProfileResponse {
  return {
    id: 'u-1',
    email: 'lina@example.test',
    displayName: 'Lina',
    preferredLocale: 'en',
    status: 'ACTIVE',
    emailVerified: true,
    mfaEnrolled: true,
    mfaRequired: false,
    roles: ['STUDENT'],
    permissions: ['profile:read:self', 'mfa:manage:self'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

const NO_CONSENT: AIConsentResponse = {
  granted: false,
  consentVersion: null,
  consentedAt: null,
  providerCategory: null,
  renewalRequired: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.consent.mockResolvedValue(NO_CONSENT);
  api.resendVerification.mockResolvedValue({ acknowledged: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resending the confirmation link', () => {
  it('sends once, answers generically, and rests before another send', async () => {
    render(<ResendVerification locale="en" email="lina@example.test" />);
    const button = screen.getByRole('button', { name: en.resendVerification });

    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(new RegExp(en.resendSent.slice(0, 20)));
    expect(api.resendVerification).toHaveBeenCalledTimes(1);
    expect(api.resendVerification).toHaveBeenCalledWith('lina@example.test');
    expect(screen.getByRole('button', { name: en.resendVerification })).toBeDisabled();
    expect(screen.getByRole('status').textContent).toContain(en.resendCooldown);
  });

  it('lets the button rest only for the cooldown', async () => {
    vi.useFakeTimers();
    render(<ResendVerification locale="en" email="lina@example.test" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.resendVerification }));
      // Let the resolved send settle and the cooldown effect start.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: en.resendVerification })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(RESEND_COOLDOWN_MS - 1_000);
    });
    expect(screen.getByRole('button', { name: en.resendVerification })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole('button', { name: en.resendVerification })).toBeEnabled();
  });

  it('says so when the server limits the address', async () => {
    api.resendVerification.mockRejectedValue(new ApiError('RATE_LIMITED', 'slow down', 429));
    render(<ResendVerification locale="en" email="lina@example.test" />);
    fireEvent.click(screen.getByRole('button', { name: en.resendVerification }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.RATE_LIMITED);
    // A refused send does not start the cooldown: the person may try again.
    expect(screen.getByRole('button', { name: en.resendVerification })).toBeEnabled();
  });

  it('asks for the address when it is not known', async () => {
    render(<ResendVerification locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: en.resendVerification }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.requiredField);
    expect(api.resendVerification).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(en.email), { target: { value: ' a@b.test ' } });
    fireEvent.click(screen.getByRole('button', { name: en.resendVerification }));
    await waitFor(() => expect(api.resendVerification).toHaveBeenCalledWith('a@b.test'));
  });

  it('is offered after signing in with an unconfirmed address, and not otherwise', async () => {
    api.login.mockRejectedValueOnce(new ApiError('AUTHENTICATION_FAILED', 'no', 401));
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText(en.email), { target: { value: 'lina@example.test' } });
    fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: en.signIn }));
    await screen.findByText(en.errors.AUTHENTICATION_FAILED!);
    expect(screen.queryByRole('button', { name: en.resendVerification })).toBeNull();

    api.login.mockRejectedValueOnce(new ApiError('EMAIL_NOT_VERIFIED', 'confirm', 403));
    fireEvent.click(screen.getByRole('button', { name: en.signIn }));
    fireEvent.click(await screen.findByRole('button', { name: en.resendVerification }));
    await waitFor(() => expect(api.resendVerification).toHaveBeenCalledWith('lina@example.test'));
  });

  it('is offered after registering, for the address just registered', async () => {
    api.register.mockResolvedValue({ acknowledged: true });
    render(<RegisterPage />);
    fireEvent.change(screen.getByLabelText(en.email), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText(en.password), {
      target: { value: 'a long enough password' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.register }));
    fireEvent.click(await screen.findByRole('button', { name: en.resendVerification }));
    await waitFor(() => expect(api.resendVerification).toHaveBeenCalledWith('new@example.test'));
  });

  it('is offered when a confirmation link no longer works', async () => {
    api.verifyEmail.mockRejectedValue(new ApiError('VERIFICATION_TOKEN_INVALID', 'old', 400));
    render(<VerifyEmailPage />);
    expect(await screen.findByRole('button', { name: en.resendVerification })).toBeTruthy();
    expect(screen.getByLabelText(en.email)).toBeTruthy();
  });

  it('shows the profile banner only while the address is unconfirmed', async () => {
    api.me.mockResolvedValue(profile({ emailVerified: false }));
    const { unmount } = render(<ProfilePage />);
    expect(await screen.findByText(en.emailUnconfirmed)).toBeTruthy();
    unmount();

    api.me.mockResolvedValue(profile({ emailVerified: true }));
    render(<ProfilePage />);
    await screen.findByText(en.profileSecurity);
    expect(screen.queryByText(en.emailUnconfirmed)).toBeNull();
  });
});

describe('turning off two-step sign-in', () => {
  async function openDialog() {
    render(<ProfilePage />);
    fireEvent.click(await screen.findByRole('button', { name: en.mfaDisable }));
    return screen.getByRole('dialog');
  }

  function fill(dialog: HTMLElement, password: string, code: string): void {
    fireEvent.change(within(dialog).getByLabelText(en.currentPassword), {
      target: { value: password },
    });
    fireEvent.change(within(dialog).getByLabelText(en.mfaCode), { target: { value: code } });
  }

  function security(): HTMLElement {
    return screen.getByTestId('profile-security');
  }

  it('shows the state as a badge and offers set-up while off', async () => {
    api.me.mockResolvedValue(profile({ mfaEnrolled: false }));
    render(<ProfilePage />);
    const setUp = await screen.findByRole('link', { name: en.profileMfaSetUp });
    expect(setUp.textContent).toBe(en.profileMfaSetUpShort);
    expect(setUp.getAttribute('href')).toBe('/en/mfa/enroll');
    expect(within(security()).getByText(en.profileMfa)).toBeTruthy();
    expect(within(security()).getByText(en.profileMfaOff)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.mfaDisable })).toBeNull();
  });

  it('offers turn-off to an ordinary account while on', async () => {
    api.me.mockResolvedValue(profile({ mfaEnrolled: true, roles: ['SERVICE_USER'] }));
    render(<ProfilePage />);
    const turnOff = await screen.findByRole('button', { name: en.mfaDisable });
    // The visible label is short; the accessible name says what it turns off
    // and still contains the visible words (WCAG 2.5.3).
    expect(turnOff.textContent).toBe(en.profileMfaTurnOff);
    expect(en.mfaDisable).toContain(en.profileMfaTurnOff);
    expect(within(security()).getByText(en.profileMfaOn)).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.profileMfaSetUp })).toBeNull();
    expect(screen.queryByTestId('mfa-required-note')).toBeNull();
  });

  it.each(['PALCERT_ADMIN', 'PALCERT_FINANCE', 'PALCERT_AUDITOR'])(
    'never offers it to a %s, whose role requires a second factor',
    async (role) => {
      api.me.mockResolvedValue(profile({ mfaRequired: true, roles: [role] }));
      render(<ProfilePage />);
      expect((await screen.findByTestId('mfa-required-note')).textContent).toBe(
        en.mfaRequiredByRoleNote,
      );
      expect(within(security()).getByText(en.profileMfaOn)).toBeTruthy();
      expect(screen.queryByRole('button', { name: en.mfaDisable })).toBeNull();
      expect(screen.queryByRole('button', { name: en.profileMfaTurnOff })).toBeNull();
    },
  );

  it('explains an administrator override without blaming a role', async () => {
    api.me.mockResolvedValue(profile({ mfaRequired: true, roles: ['SERVICE_USER'] }));
    render(<ProfilePage />);
    expect((await screen.findByTestId('mfa-required-note')).textContent).toBe(en.mfaRequiredNote);
    expect(screen.queryByRole('button', { name: en.mfaDisable })).toBeNull();
  });

  it('trusts the account over the role list: a support user may turn it off', async () => {
    // PALCERT_SUPPORT is staff but its role does not require a second factor.
    api.me.mockResolvedValue(profile({ mfaRequired: false, roles: ['PALCERT_SUPPORT'] }));
    render(<ProfilePage />);
    expect(await screen.findByRole('button', { name: en.mfaDisable })).toBeTruthy();
  });

  it('sends the password and the code, then shows it off at once', async () => {
    api.me.mockResolvedValueOnce(profile()).mockResolvedValueOnce(profile({ mfaEnrolled: false }));
    api.disableMfa.mockResolvedValue({ acknowledged: true });
    const dialog = await openDialog();

    fill(dialog, 'my password', ' 123456 ');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));

    await waitFor(() =>
      expect(api.disableMfa).toHaveBeenCalledWith({ password: 'my password', code: '123456' }),
    );
    expect((await screen.findByRole('status')).textContent).toBe(en.mfaDisabled);
    expect(en.mfaDisabled).toBe('Two-step sign-in has been turned off.');
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('link', { name: en.profileMfaSetUp })).toBeTruthy();
    expect(within(security()).getByText(en.profileMfaOff)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.mfaDisable })).toBeNull();
    // Focus is not lost with the button that opened the dialog.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: en.profileSecurity }),
      ),
    );
  });

  it('announces success only once the badge already says off', async () => {
    let answer: (value: UserProfileResponse) => void = () => undefined;
    api.me
      .mockResolvedValueOnce(profile())
      .mockReturnValueOnce(new Promise<UserProfileResponse>((resolve) => (answer = resolve)));
    api.disableMfa.mockResolvedValue({ acknowledged: true });
    const dialog = await openDialog();
    fill(dialog, 'my password', '123456');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));

    // The account is being read again: no message yet, so it cannot
    // contradict the badge.
    await waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(en.mfaDisabled)).toBeNull();

    await act(async () => answer(profile({ mfaEnrolled: false })));
    expect((await screen.findByRole('status')).textContent).toBe(en.mfaDisabled);
    expect(within(security()).getByText(en.profileMfaOff)).toBeTruthy();
  });

  it('still says it worked when the re-read fails, without guessing the state', async () => {
    api.me
      .mockResolvedValueOnce(profile())
      .mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'down', 0));
    api.disableMfa.mockResolvedValue({ acknowledged: true });
    const dialog = await openDialog();
    fill(dialog, 'my password', '123456');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));
    expect((await screen.findByRole('status')).textContent).toBe(en.mfaDisabled);
    expect(screen.getByRole('alert').textContent).toBe(en.genericError);
  });

  it('requires both fields before asking the server', async () => {
    api.me.mockResolvedValue(profile());
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.requiredField);
    fill(dialog, 'pw', '   ');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.requiredField);
    expect(api.disableMfa).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong password', 'AUTHENTICATION_FAILED', 401, () => en.currentPasswordWrong],
    ['a wrong or expired code', 'MFA_INVALID', 401, () => en.errors.MFA_INVALID!],
    ['a refusal by policy', 'PERMISSION_DENIED', 403, () => en.mfaRequiredNote],
    ['a failed CSRF check', 'CSRF_INVALID', 403, () => en.errors.CSRF_INVALID!],
    ['throttling', 'RATE_LIMITED', 429, () => en.errors.RATE_LIMITED!],
  ])('explains %s and keeps the factor on', async (_case, code, status, expected) => {
    api.me.mockResolvedValue(profile());
    api.disableMfa.mockRejectedValue(new ApiError(code, 'no', status));
    const dialog = await openDialog();
    fill(dialog, 'pw', '000000');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(expected());
    // The code field is cleared for the next attempt; the password is kept;
    // the badge still says on, and the account was not read again.
    expect((within(dialog).getByLabelText(en.mfaCode) as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText(en.currentPassword) as HTMLInputElement).value).toBe(
      'pw',
    );
    expect(within(security()).getByText(en.profileMfaOn)).toBeTruthy();
    expect(within(dialog).queryByRole('link', { name: en.signInAgain })).toBeNull();
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SESSION_EXPIRED', () => en.errors.SESSION_EXPIRED!],
    ['UNAUTHENTICATED', () => en.errors.UNAUTHENTICATED!],
    ['SESSION_REVOKED', () => en.errors.SESSION_REVOKED!],
    ['REAUTHENTICATION_REQUIRED', () => en.errors.REAUTHENTICATION_REQUIRED!],
  ])('after %s, says so and offers to sign in again, back to the profile', async (code, text) => {
    api.me.mockResolvedValue(profile());
    api.disableMfa.mockRejectedValue(new ApiError(code, 'no', 401));
    const dialog = await openDialog();
    fill(dialog, 'pw', '123456');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(text());
    const again = within(dialog).getByRole('link', { name: en.signInAgain });
    expect(again.getAttribute('href')).toBe(`/en/login?next=${encodeURIComponent('/en/profile')}`);
    expect(within(security()).getByText(en.profileMfaOn)).toBeTruthy();
  });

  it('never logs the password or the code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    api.me.mockResolvedValue(profile());
    api.disableMfa.mockRejectedValue(new ApiError('MFA_INVALID', 'no', 401));
    const dialog = await openDialog();
    fill(dialog, 'hunter2-secret', '654321');
    fireEvent.click(within(dialog).getByRole('button', { name: en.mfaDisable }));
    await within(dialog).findByRole('alert');
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain('hunter2-secret');
    expect(logged).not.toContain('654321');
    spies.forEach((spy) => spy.mockRestore());
  });

  it('is a named, described modal whose fields are labelled, focused first, and closed by Escape', async () => {
    api.me.mockResolvedValue(profile());
    render(<ProfilePage />);
    const trigger = await screen.findByRole('button', { name: en.mfaDisable });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: en.mfaDisable });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText(en.mfaDisableIntro)).toBeTruthy();

    const password = within(dialog).getByLabelText(en.currentPassword) as HTMLInputElement;
    const code = within(dialog).getByLabelText(en.mfaCode) as HTMLInputElement;
    expect(document.activeElement).toBe(password);
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect(code.autocomplete).toBe('one-time-code');
    expect(code.inputMode).toBe('numeric');

    // Enter in a field submits the form (the submit button is a real one).
    fill(dialog, '', '');
    fireEvent.submit(code.form!);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.requiredField);

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(api.disableMfa).not.toHaveBeenCalled();
  });

  it('closes on cancel without sending anything, and forgets what was typed', async () => {
    api.me.mockResolvedValue(profile());
    let dialog = await openDialog();
    fill(dialog, 'typed', '111111');
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.disableMfa).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: en.mfaDisable }));
    dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText(en.currentPassword) as HTMLInputElement).value).toBe('');
  });
});

describe('reading the profile', () => {
  it('shows an error, not a crash, when the account read comes back empty', async () => {
    // Firefox resolves a read cut short by a navigation with no body.
    api.me.mockResolvedValue(undefined);
    render(<ProfilePage />);
    expect((await screen.findByRole('alert')).textContent).toBe(en.genericError);
    expect(screen.queryByTestId('profile-security')).toBeNull();
  });
});

describe('two-step sign-in in Arabic', () => {
  const ar = AUTH_MESSAGES.ar;

  it('uses the agreed terms', () => {
    expect(ar.profileMfa).toBe('التحقق بخطوتين');
    expect(ar.profileMfaOn).toBe('مفعّل');
    expect(ar.profileMfaOff).toBe('غير مفعّل');
    expect(ar.mfaDisable).toBe('إيقاف التحقق بخطوتين');
    expect(ar.currentPassword).toBe('كلمة المرور الحالية');
    expect(ar.mfaCode).toBe('رمز التحقق');
    expect(ar.mfaDisabled).toBe('تم إيقاف التحقق بخطوتين.');
    expect(ar.mfaRequiredByRoleNote).toBe('التحقق بخطوتين إلزامي لهذا الدور ولا يمكن إيقافه.');
  });

  it('has every English key, and none left in English', () => {
    const keys = [
      'profileMfa',
      'profileMfaOn',
      'profileMfaOff',
      'profileMfaSetUp',
      'profileMfaSetUpShort',
      'profileMfaTurnOff',
      'mfaDisable',
      'mfaDisableIntro',
      'mfaDisabled',
      'mfaRequiredNote',
      'mfaRequiredByRoleNote',
      'signInAgain',
      'currentPassword',
      'mfaCode',
    ] as const;
    for (const key of keys) {
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], key).not.toBe(en[key]);
      expect(ar[key], key).toMatch(/[\u0600-\u06FF]/);
    }
    expect(ar.mfaDisable).toContain(ar.profileMfaTurnOff);
  });
});

describe('withdrawing agreement to external AI processing', () => {
  const GRANTED: AIConsentResponse = {
    granted: true,
    consentVersion: 'v1',
    consentedAt: '2026-05-01T10:00:00.000Z',
    providerCategory: 'EXTERNAL',
    renewalRequired: false,
  };

  it('confirms first, then shows the agreement as withdrawn', async () => {
    api.me.mockResolvedValue(profile());
    api.consent.mockResolvedValue(GRANTED);
    api.withdrawConsent.mockResolvedValue(NO_CONSENT);
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole('button', { name: ai.consentWithdraw }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(ai.consentWithdrawIntro)).toBeTruthy();
    expect(api.withdrawConsent).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: ai.consentWithdraw }));
    expect(await screen.findByText(ai.consentWithdrawn)).toBeTruthy();
    expect(screen.getByText(ai.consentNone)).toBeTruthy();
    expect(api.withdrawConsent).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the account cannot use AI review', async () => {
    api.me.mockResolvedValue(profile());
    api.consent.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'no', 403));
    render(<ProfilePage />);
    await screen.findByText(en.profileSecurity);
    expect(screen.queryByText(ai.consentSettingsTitle)).toBeNull();
  });
});
