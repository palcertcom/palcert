import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { RoleCode, RoleScope, SecurityEventType, UserStatus } from '@palcert/contracts';
import { AppModule } from '../app.module';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RbacService } from '../modules/rbac/rbac.service';
import { PasswordService, PASSWORD_ALGORITHM } from '../modules/auth/services/password.service';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { normalizeEmail } from '../common/crypto/email-normalizer';

/**
 * PalCert administrator bootstrap (ADR-0015).
 *
 * Run deliberately by an operator, never reachable over HTTP:
 *
 *     PALCERT_BOOTSTRAP_ADMIN_EMAIL=ops@palcert.com \
 *     PALCERT_BOOTSTRAP_ADMIN_PASSWORD=... \
 *     node dist/cli/bootstrap-admin.js
 *
 * Properties this command guarantees:
 *
 *  - **Idempotent.** Re-running promotes the existing account rather than
 *    failing or creating a duplicate, so it is safe in a deploy pipeline.
 *  - **Never prints a secret.** The password is read from the environment and
 *    is not echoed; no generated credential is written to stdout or to the log.
 *  - **Never weakens an account.** An existing password is left untouched.
 *  - **MFA still required.** The created administrator holds PALCERT_ADMIN,
 *    which requires MFA, so the first sign-in must enroll a second factor
 *    before the account can do anything.
 */
const EMAIL_VAR = 'PALCERT_BOOTSTRAP_ADMIN_EMAIL';
const PASSWORD_VAR = 'PALCERT_BOOTSTRAP_ADMIN_PASSWORD';

export async function bootstrapAdmin(): Promise<void> {
  const email = process.env[EMAIL_VAR];
  const password = process.env[PASSWORD_VAR];

  if (email === undefined || email.trim() === '') {
    throw new Error(`${EMAIL_VAR} is required`);
  }
  if (password === undefined || password === '') {
    throw new Error(`${PASSWORD_VAR} is required`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const prisma = app.get(PrismaService);
    const passwords = app.get(PasswordService);
    const rbac = app.get(RbacService);
    const events = app.get(SecurityEventService);

    const normalizedEmail = normalizeEmail(email);
    const existing = await prisma.user.findUnique({ where: { normalizedEmail } });

    let userId: string;
    let created = false;

    if (existing === null) {
      await passwords.assertMeetsPolicy(password);
      const role = await prisma.role.findUnique({ where: { code: RoleCode.PALCERT_ADMIN } });
      if (role === null) {
        throw new Error('Role catalogue is missing — run database migrations first');
      }

      const user = await prisma.user.create({
        data: {
          email: email.trim(),
          normalizedEmail,
          passwordHash: await passwords.hash(password),
          passwordAlgorithm: PASSWORD_ALGORITHM,
          // The bootstrap operator controls this mailbox by definition, so the
          // account starts verified and usable.
          emailVerifiedAt: new Date(),
          status: UserStatus.ACTIVE,
          preferredLocale: 'en',
          roles: { create: { roleId: role.id, organizationId: null, scope: RoleScope.GLOBAL } },
        },
      });
      userId = user.id;
      created = true;
    } else {
      // Existing account: grant the role, change nothing else. In particular
      // the password is NOT reset — that would let anyone who can run the
      // command take over an existing administrator account.
      userId = existing.id;
      await rbac.assignGlobalRole({
        userId,
        roleCode: RoleCode.PALCERT_ADMIN,
        grantedByUserId: userId,
      });
    }

    await events.audit({
      action: 'ADMIN_BOOTSTRAP',
      actorUserId: userId,
      targetType: 'User',
      targetId: userId,
      afterState: { role: RoleCode.PALCERT_ADMIN, created },
    });
    await events.record({
      type: SecurityEventType.ROLE_ASSIGNED,
      userId,
      actorUserId: userId,
      metadata: { role: RoleCode.PALCERT_ADMIN, via: 'BOOTSTRAP_CLI' },
    });

    // Deliberately reports the address only — never the password, never a token.
    process.stdout.write(
      `${created ? 'Created' : 'Promoted'} PalCert administrator: ${email.trim()}\n` +
        'Multi-factor authentication must be enrolled at first sign-in.\n',
    );
  } finally {
    await app.close();
  }
}

// Only run when executed directly, so tests can import the function.
if (require.main === module) {
  bootstrapAdmin()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`Admin bootstrap failed: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
