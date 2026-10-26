import { Injectable } from '@nestjs/common';
import {
  AppError,
  ORGANIZATION_AI_CONSENT_VERSION,
  OrganizationAIProviderCategory,
  PalCertErrorCode,
  type OrganizationAIConsentView,
} from '@palcert/contracts';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { scopeOf, type SourceRequestContext } from './standard-source.service';

/**
 * The organization's agreement to external AI processing (§15, §16, §17, §104).
 *
 * Deliberately not the Phase 8 personal consent, and the separation is the
 * point rather than tidiness. A student agreeing that their thesis may be read
 * by a provider has said nothing about an institution's guidelines, and an
 * institution agreeing on its own behalf has said nothing about anybody's
 * thesis. Sharing one record between the two would make each of those
 * agreements mean something the person who gave it never agreed to.
 *
 * Without it: uploading a source is allowed, writing rules by hand is allowed,
 * and AI extraction is refused (§17).
 */
@Injectable()
export class OrganizationAIConsentService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async view(context: TenantContext): Promise<OrganizationAIConsentView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.organizationAIConsent.findUnique({
        where: { organizationId: context.organizationId },
      }),
    );

    if (row === null || row.revokedAt !== null) {
      return {
        granted: false,
        consentVersion: null,
        providerCategory: null,
        acceptedAt: null,
        acceptedByUserId: null,
        renewalRequired: false,
      };
    }

    return {
      granted: true,
      consentVersion: row.consentVersion,
      providerCategory: row.providerCategory,
      acceptedAt: row.acceptedAt.toISOString(),
      acceptedByUserId: row.acceptedByUserId,
      // A newer notice means nobody at the organization has yet seen what they
      // would now be agreeing to, so the old agreement does not carry over.
      renewalRequired: row.consentVersion !== ORGANIZATION_AI_CONSENT_VERSION,
    };
  }

  async accept(
    context: TenantContext,
    request: SourceRequestContext,
  ): Promise<OrganizationAIConsentView> {
    const now = this.clock.now();
    await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.organizationAIConsent.upsert({
        where: { organizationId: context.organizationId },
        create: {
          organizationId: context.organizationId,
          consentVersion: ORGANIZATION_AI_CONSENT_VERSION,
          providerCategory: OrganizationAIProviderCategory.EXTERNAL_AI_PROVIDER,
          acceptedAt: now,
          acceptedByUserId: context.userId,
        },
        update: {
          consentVersion: ORGANIZATION_AI_CONSENT_VERSION,
          providerCategory: OrganizationAIProviderCategory.EXTERNAL_AI_PROVIDER,
          acceptedAt: now,
          acceptedByUserId: context.userId,
          revokedAt: null,
          revokedByUserId: null,
        },
      }),
    );

    // Named actor, always: "the organization agreed" is not an auditable fact,
    // and someone will eventually need to know who.
    await this.events.audit({
      action: 'ORGANIZATION_AI_CONSENT_ACCEPTED',
      actorUserId: context.userId,
      targetType: 'OrganizationAIConsent',
      targetId: context.organizationId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        consentVersion: ORGANIZATION_AI_CONSENT_VERSION,
        providerCategory: OrganizationAIProviderCategory.EXTERNAL_AI_PROVIDER,
      },
    });

    return this.view(context);
  }

  async revoke(
    context: TenantContext,
    request: SourceRequestContext,
  ): Promise<OrganizationAIConsentView> {
    const now = this.clock.now();
    // The row survives revocation: "agreed once and then withdrew" is a
    // different fact from "never agreed", and both matter to an auditor.
    await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.organizationAIConsent.updateMany({
        where: { organizationId: context.organizationId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: context.userId },
      }),
    );

    await this.events.audit({
      action: 'ORGANIZATION_AI_CONSENT_REVOKED',
      actorUserId: context.userId,
      targetType: 'OrganizationAIConsent',
      targetId: context.organizationId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return this.view(context);
  }

  /** Refuse the work rather than proceed without agreement (§17). */
  async assertGranted(context: TenantContext): Promise<void> {
    const consent = await this.view(context);
    if (consent.granted && !consent.renewalRequired) return;
    throw new AppError(PalCertErrorCode.ORGANIZATION_AI_CONSENT_REQUIRED, {
      message:
        'Rule extraction sends selected parts of your guideline documents to an external AI ' +
        'provider. An organization owner or administrator must agree before it can run.',
    });
  }
}
