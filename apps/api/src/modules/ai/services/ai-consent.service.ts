import { Injectable } from '@nestjs/common';
import {
  AI_CONSENT_VERSION,
  AIProviderCategory,
  AppError,
  PalCertErrorCode,
  type AIConsentView,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { RequestContext } from '../../documents/services/document.service';

/**
 * Consent to external AI processing (§14, §63, §68).
 *
 * PalCert does not send a user's unpublished research to a third party because
 * a feature flag is on. It sends it because that person read what would happen
 * and agreed — and the record of that agreement names the version of the
 * notice they read, so changing the notice cannot silently inherit agreement
 * given to an older one.
 *
 * Consent is user-scoped, always. An organization whose standard is being
 * checked against has no way to grant it, no matter how convenient the data
 * would be to them.
 */
@Injectable()
export class AIConsentService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AIConsentService.name);
  }

  async view(userId: string): Promise<AIConsentView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.aIConsent.findUnique({ where: { ownerUserId: userId } }),
    );

    if (row === null || row.withdrawnAt !== null) {
      return {
        granted: false,
        consentVersion: null,
        consentedAt: null,
        providerCategory: null,
        renewalRequired: false,
      };
    }

    return {
      granted: true,
      consentVersion: row.consentVersion,
      consentedAt: row.consentedAt.toISOString(),
      providerCategory: row.providerCategory,
      // A newer notice means the user has not yet seen what they would now be
      // agreeing to, so the old agreement does not carry over.
      renewalRequired: row.consentVersion !== AI_CONSENT_VERSION,
    };
  }

  async grant(userId: string, request: RequestContext): Promise<AIConsentView> {
    const now = this.clock.now();
    await this.tenant.withUser(userId, (tx) =>
      tx.aIConsent.upsert({
        where: { ownerUserId: userId },
        create: {
          ownerUserId: userId,
          consentVersion: AI_CONSENT_VERSION,
          providerCategory: AIProviderCategory.EXTERNAL_AI_PROVIDER,
          consentedAt: now,
        },
        update: {
          consentVersion: AI_CONSENT_VERSION,
          providerCategory: AIProviderCategory.EXTERNAL_AI_PROVIDER,
          consentedAt: now,
          withdrawnAt: null,
        },
      }),
    );

    await this.events.audit({
      action: 'AI_CONSENT_GRANTED',
      actorUserId: userId,
      targetType: 'AIConsent',
      targetId: userId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        consentVersion: AI_CONSENT_VERSION,
        providerCategory: AIProviderCategory.EXTERNAL_AI_PROVIDER,
      },
    });

    return this.view(userId);
  }

  async withdraw(userId: string, request: RequestContext): Promise<AIConsentView> {
    const now = this.clock.now();
    // The row survives withdrawal: "agreed once and then withdrew" is a
    // different fact from "never agreed", and both matter.
    await this.tenant.withUser(userId, (tx) =>
      tx.aIConsent.updateMany({
        where: { ownerUserId: userId, withdrawnAt: null },
        data: { withdrawnAt: now },
      }),
    );

    await this.events.audit({
      action: 'AI_CONSENT_WITHDRAWN',
      actorUserId: userId,
      targetType: 'AIConsent',
      targetId: userId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return this.view(userId);
  }

  /** Refuse the work rather than proceed without agreement (§14, §84). */
  async assertGranted(userId: string): Promise<void> {
    const consent = await this.view(userId);
    if (!consent.granted || consent.renewalRequired) {
      throw new AppError(PalCertErrorCode.AI_CONSENT_REQUIRED, {
        message:
          'AI review sends parts of your document to an external AI provider. It runs only after you agree.',
        details: { requiredConsentVersion: AI_CONSENT_VERSION },
      });
    }
  }
}
