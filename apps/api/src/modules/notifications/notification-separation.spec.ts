import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The boundary between credential mail and workflow mail, asserted in source.
 *
 * Phase 1's `MailDeliveryPort` carries verification, reset and invitation
 * tokens: the token *is* the authority those messages grant. Phase 16 sends
 * mail too, and the whole reason it has its own port is that a shared one is
 * how a reset token ends up in a notification template — not by anybody
 * deciding to put it there, but by a shared `variables` bag and a template
 * registry both paths reach.
 *
 * A type boundary is only a boundary while nobody reaches across it. This is
 * the test that notices if somebody does.
 */
const NOTIFICATION_DIRECTORIES = [
  join(__dirname),
  join(__dirname, '..', '..', 'infrastructure', 'notifications'),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const FILES = NOTIFICATION_DIRECTORIES.flatMap(sourceFiles);

describe('Notifications — separation from credential mail', () => {
  it('finds the Phase 16 source to check', () => {
    // A test that silently checked nothing would be worse than no test.
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('never reaches for the authentication mail port', () => {
    const offenders = FILES.filter((file) => {
      // This file names the forbidden symbols in order to forbid them.
      if (file.endsWith('notification-separation.spec.ts')) return false;
      const source = readFileSync(file, 'utf8');
      return (
        source.includes('MailDeliveryPort') ||
        source.includes('auth/ports/mail.port') ||
        source.includes('InMemoryMailOutbox')
      );
    });
    expect(offenders).toEqual([]);
  });

  it('never names a credential of any kind', () => {
    // Not a guess at what a leak would look like: these are the exact names
    // Phase 1 and Phase 2 give the things that must not travel this way.
    const forbidden =
      /\b(EmailVerificationToken|PasswordResetToken|OrganizationInvitation|rawToken|resetToken|verificationToken|invitationToken|passwordHash|sessionToken)\b/;

    const offenders = FILES.filter(
      (file) => !file.endsWith('.spec.ts') && forbidden.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('renders templates from fixed text, never from a caller’s values', () => {
    // The templates take a type, a locale and a route. There is no variables
    // bag, so there is nothing for a token to be passed as.
    const templates = readFileSync(
      join(__dirname, 'templates', 'notification-templates.ts'),
      'utf8',
    );
    expect(templates).not.toMatch(/variables|Record<string, string>/);
  });

  // ADR-0146: the shared transport layer beneath both ports. It may be used
  // by authentication mail, but it must never know about it: nothing in it
  // imports the auth port, takes a variables bag, or names a credential, so
  // no workflow path can reach a token through it.
  describe('the shared email transport layer', () => {
    const SHARED = sourceFiles(join(__dirname, '..', '..', 'infrastructure', 'email')).filter(
      (file) => !file.endsWith('.spec.ts'),
    );

    it('finds the shared layer to check', () => {
      expect(SHARED.length).toBeGreaterThan(5);
    });

    it('never imports authentication code or the auth mail port', () => {
      const offenders = SHARED.filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          source.includes('MailDeliveryPort') ||
          source.includes('modules/auth') ||
          source.includes('InMemoryMailOutbox') ||
          /\bvariables\b/.test(source)
        );
      });
      expect(offenders).toEqual([]);
    });

    it('never names a credential token', () => {
      const forbidden =
        /\b(EmailVerificationToken|PasswordResetToken|rawToken|resetToken|verificationToken|invitationToken|passwordHash|sessionToken)\b/;
      expect(SHARED.filter((file) => forbidden.test(readFileSync(file, 'utf8')))).toEqual([]);
    });
  });
});
