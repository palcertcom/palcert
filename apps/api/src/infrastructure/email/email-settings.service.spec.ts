import { AuthEmailTemplate, EmailProviderKind, EmailSkipReason } from '@palcert/contracts';
import {
  DEFAULT_EMAIL_SETTINGS,
  decideEmailRoute,
  type EmailSettingsSnapshot,
} from './email-settings.service';

const sealed = { kid: 'k1', ciphertext: 'c', iv: 'i', authTag: 't' };
const active: EmailSettingsSnapshot = {
  ...DEFAULT_EMAIL_SETTINGS,
  saved: true,
  provider: EmailProviderKind.RESEND,
  enabled: true,
  apiKey: sealed,
};
const auth = (template: AuthEmailTemplate) => ({ category: 'AUTH' as const, template });

describe('decideEmailRoute', () => {
  it('never-configured behaves exactly as before: everything is LEGACY', () => {
    for (const t of Object.values(AuthEmailTemplate)) {
      expect(decideEmailRoute(DEFAULT_EMAIL_SETTINGS, auth(t))).toBe('LEGACY');
    }
    expect(decideEmailRoute(DEFAULT_EMAIL_SETTINGS, { category: 'WORKFLOW' })).toBe('LEGACY');
    expect(decideEmailRoute(DEFAULT_EMAIL_SETTINGS, { category: 'TEST' })).toBe('NOT_CONFIGURED');
  });

  it('Resend chosen but not enabled is still LEGACY for real mail, but testable', () => {
    const configured = { ...active, enabled: false };
    expect(decideEmailRoute(configured, { category: 'WORKFLOW' })).toBe('LEGACY');
    expect(decideEmailRoute(configured, auth(AuthEmailTemplate.PASSWORD_RESET))).toBe('LEGACY');
    expect(decideEmailRoute(configured, { category: 'TEST' })).toBe('SEND');
  });

  it('enabled Resend sends, honouring each switch', () => {
    expect(decideEmailRoute(active, auth(AuthEmailTemplate.EMAIL_VERIFICATION))).toBe('SEND');
    expect(
      decideEmailRoute(
        { ...active, authVerificationEnabled: false },
        auth(AuthEmailTemplate.EMAIL_VERIFICATION),
      ),
    ).toBe(EmailSkipReason.CATEGORY_DISABLED);
    expect(
      decideEmailRoute(
        { ...active, authPasswordResetEnabled: false },
        auth(AuthEmailTemplate.PASSWORD_RESET),
      ),
    ).toBe(EmailSkipReason.CATEGORY_DISABLED);
    expect(
      decideEmailRoute(
        { ...active, authInvitationEnabled: false },
        auth(AuthEmailTemplate.ORGANIZATION_INVITATION),
      ),
    ).toBe(EmailSkipReason.CATEGORY_DISABLED);
    expect(
      decideEmailRoute({ ...active, workflowEmailEnabled: false }, { category: 'WORKFLOW' }),
    ).toBe(EmailSkipReason.CATEGORY_DISABLED);
    // The password-changed notice follows the provider, not a switch.
    expect(
      decideEmailRoute(
        { ...active, authPasswordResetEnabled: false },
        auth(AuthEmailTemplate.PASSWORD_CHANGED),
      ),
    ).toBe('SEND');
  });

  it('a disabled provider choice is LEGACY even with a stored key', () => {
    expect(
      decideEmailRoute(
        { ...active, provider: EmailProviderKind.DISABLED },
        { category: 'WORKFLOW' },
      ),
    ).toBe('LEGACY');
  });
});
