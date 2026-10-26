import { Injectable } from '@nestjs/common';
import {
  AppError,
  CONFIGURATION_TEST_TEMPLATE,
  EmailDeliveryCategory,
  EmailDeliveryStatus,
  EmailProviderKind,
  EmailSettingsWarning,
  OutboundEmailFailure,
  PAGINATION_DEFAULT_LIMIT,
  PalCertErrorCode,
  addressMatchesDomain,
  apiKeyDisplayHint,
  decodeCursor,
  encodeCursor,
  isPlausibleResendApiKey,
  isPlausibleWebhookSecret,
  isValidEmailAddress,
  isValidFromName,
  isValidSendingDomain,
  outboundFailureSummary,
  webhookSecretDisplayHint,
  type EmailDeliveryView,
  type EmailSettingsView,
  type OutboundEmailFailure as OutboundEmailFailureCode,
  type Page,
  type SendTestEmailResult,
} from '@palcert/contracts';
import type { EmailDelivery, Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { EmailDeliveryRecorder } from '../../../infrastructure/email/email-delivery-recorder';
import { EmailSecretPurpose } from '../../../infrastructure/email/email-secret-keyring';
import {
  EMAIL_SETTINGS_ID,
  EmailSettingsService,
  type EmailSettingsSnapshot,
} from '../../../infrastructure/email/email-settings.service';
import { OutboundEmailError } from '../../../infrastructure/email/outbound-email';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type {
  EmailDeliveryListQueryDto,
  SendTestEmailDto,
  UpdateEmailSettingsDto,
} from './email-settings.dto';
import { renderTestEmail } from './test-email-template';

export const EmailAuditAction = {
  SETTINGS_UPDATED: 'EMAIL_SETTINGS_UPDATED',
  PROVIDER_ENABLED: 'EMAIL_PROVIDER_ENABLED',
  PROVIDER_DISABLED: 'EMAIL_PROVIDER_DISABLED',
  SECRET_REPLACED: 'EMAIL_PROVIDER_SECRET_REPLACED',
  TEST_REQUESTED: 'EMAIL_TEST_REQUESTED',
} as const;

const TARGET_TYPE = 'PLATFORM_EMAIL_SETTINGS';
const TARGET_ID = 'platform';

/**
 * The platform email configuration, as administrators manage it (ADR-0146).
 *
 * Secrets go in one direction only: from the request, through the keyring,
 * into ciphertext columns. Nothing here returns, logs or audits a secret; the
 * audit trail records *that* a key was replaced and nothing about it.
 */
@Injectable()
export class AdminEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: EmailSettingsService,
    private readonly recorder: EmailDeliveryRecorder,
    private readonly events: SecurityEventService,
    private readonly throttle: AuthThrottleService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminEmailService.name);
  }

  async view(): Promise<EmailSettingsView> {
    this.settings.invalidate();
    return this.toView(await this.settings.snapshot());
  }

  async update(
    actorUserId: string,
    body: UpdateEmailSettingsDto,
    requestId: string | null,
  ): Promise<EmailSettingsView> {
    const ring = this.settings.keyring();
    const sendingDomain = body.sendingDomain.trim().toLowerCase();
    const fromEmail = body.fromEmail.trim();
    const fromName = body.fromName.trim();
    const replyTo = (body.replyToEmail ?? '').trim() || null;
    const newApiKey = (body.apiKey ?? '').trim() || null;
    const newWebhookSecret = (body.webhookSecret ?? '').trim() || null;

    const problems: string[] = [];
    if (!isValidSendingDomain(sendingDomain)) problems.push('sendingDomain');
    if (!isValidEmailAddress(fromEmail)) problems.push('fromEmail');
    if (!isValidFromName(fromName)) problems.push('fromName');
    if (replyTo !== null && !isValidEmailAddress(replyTo)) problems.push('replyToEmail');
    if (newApiKey !== null && !isPlausibleResendApiKey(newApiKey)) problems.push('apiKey');
    if (newWebhookSecret !== null && !isPlausibleWebhookSecret(newWebhookSecret)) {
      problems.push('webhookSecret');
    }
    if (problems.length > 0) {
      throw new AppError(PalCertErrorCode.EMAIL_SETTINGS_INVALID, {
        message: 'Some email settings are not valid.',
        details: { fields: problems },
      });
    }

    if ((newApiKey !== null || newWebhookSecret !== null) && ring === null) {
      throw new AppError(PalCertErrorCode.EMAIL_ENCRYPTION_UNAVAILABLE, {
        message:
          'Secure configuration is unavailable: this deployment has no email settings encryption key, so a credential cannot be stored.',
      });
    }

    const before = await this.currentSnapshot();
    const wantsActive = body.provider === EmailProviderKind.RESEND && body.enabled;
    if (wantsActive) {
      if (newApiKey === null && before.apiKey === null) {
        throw new AppError(PalCertErrorCode.EMAIL_SETTINGS_INVALID, {
          message: 'Resend cannot be enabled without an API key.',
          details: { fields: ['apiKey'] },
        });
      }
      // A stored key this process cannot open would make every send fail.
      if (
        newApiKey === null &&
        before.apiKey !== null &&
        (ring === null || !ring.has(before.apiKey.kid))
      ) {
        throw new AppError(PalCertErrorCode.EMAIL_ENCRYPTION_UNAVAILABLE, {
          message:
            'The stored API key was sealed with an encryption key this deployment does not hold. Enter the key again.',
        });
      }
    }

    const sealedKey =
      newApiKey !== null && ring !== null
        ? ring.seal(newApiKey, {
            purpose: EmailSecretPurpose.API_KEY,
            provider: EmailProviderKind.RESEND,
          })
        : null;
    const sealedWebhook =
      newWebhookSecret !== null && ring !== null
        ? ring.seal(newWebhookSecret, {
            purpose: EmailSecretPurpose.WEBHOOK_SECRET,
            provider: EmailProviderKind.RESEND,
          })
        : null;

    const data: Prisma.PlatformEmailSettingsUncheckedUpdateInput = {
      provider: body.provider,
      enabled: body.enabled,
      sendingDomain,
      fromEmail,
      fromName,
      replyToEmail: replyTo,
      authVerificationEnabled: body.authVerificationEnabled,
      authPasswordResetEnabled: body.authPasswordResetEnabled,
      authInvitationEnabled: body.authInvitationEnabled,
      workflowEmailEnabled: body.workflowEmailEnabled,
      deliveryTrackingEnabled: body.deliveryTrackingEnabled,
      updatedByUserId: actorUserId,
      ...(sealedKey !== null && newApiKey !== null
        ? {
            apiKeyCiphertext: sealedKey.ciphertext,
            apiKeyIv: sealedKey.iv,
            apiKeyAuthTag: sealedKey.authTag,
            apiKeyKid: sealedKey.kid,
            apiKeyDisplayHint: apiKeyDisplayHint(newApiKey),
          }
        : {}),
      ...(sealedWebhook !== null && newWebhookSecret !== null
        ? {
            webhookSecretCiphertext: sealedWebhook.ciphertext,
            webhookSecretIv: sealedWebhook.iv,
            webhookSecretAuthTag: sealedWebhook.authTag,
            webhookSecretKid: sealedWebhook.kid,
            webhookSecretDisplayHint: webhookSecretDisplayHint(newWebhookSecret),
          }
        : body.clearWebhookSecret === true
          ? {
              webhookSecretCiphertext: null,
              webhookSecretIv: null,
              webhookSecretAuthTag: null,
              webhookSecretKid: null,
              webhookSecretDisplayHint: null,
            }
          : {}),
    };

    const wasActive = before.provider === EmailProviderKind.RESEND && before.enabled;
    await this.prisma.$transaction(async (tx) => {
      // Update-or-create rather than upsert: a native upsert makes PostgreSQL
      // check the insert candidate too, and that row (without the stored key)
      // would fail the "enabled needs a key" constraint.
      const updated = await tx.platformEmailSettings.updateMany({
        where: { id: EMAIL_SETTINGS_ID },
        data: data as Prisma.PlatformEmailSettingsUncheckedUpdateManyInput,
      });
      if (updated.count === 0) {
        await tx.platformEmailSettings.create({
          data: {
            id: EMAIL_SETTINGS_ID,
            ...(data as Prisma.PlatformEmailSettingsUncheckedCreateInput),
          },
        });
      }

      const after = {
        ...publicState(before),
        provider: body.provider,
        enabled: body.enabled,
        sendingDomain,
        fromEmail,
        fromName,
        replyToEmail: replyTo,
        authVerificationEnabled: body.authVerificationEnabled,
        authPasswordResetEnabled: body.authPasswordResetEnabled,
        authInvitationEnabled: body.authInvitationEnabled,
        workflowEmailEnabled: body.workflowEmailEnabled,
        deliveryTrackingEnabled: body.deliveryTrackingEnabled,
        apiKeyConfigured: sealedKey !== null || before.apiKey !== null,
        webhookSecretConfigured:
          sealedWebhook !== null ||
          (before.webhookSecret !== null && body.clearWebhookSecret !== true),
      };
      const audit = { actorUserId, targetType: TARGET_TYPE, targetId: TARGET_ID, requestId };
      await this.events.auditWithin(tx, {
        ...audit,
        action: EmailAuditAction.SETTINGS_UPDATED,
        beforeState: publicState(before),
        afterState: after,
      });
      if (wantsActive !== wasActive) {
        await this.events.auditWithin(tx, {
          ...audit,
          action: wantsActive
            ? EmailAuditAction.PROVIDER_ENABLED
            : EmailAuditAction.PROVIDER_DISABLED,
          afterState: { provider: body.provider },
        });
      }
      if (sealedKey !== null) {
        await this.events.auditWithin(tx, {
          ...audit,
          action: EmailAuditAction.SECRET_REPLACED,
          afterState: { provider: 'RESEND', apiKeyChanged: true },
        });
      }
      if (
        sealedWebhook !== null ||
        (body.clearWebhookSecret === true && before.webhookSecret !== null)
      ) {
        await this.events.auditWithin(tx, {
          ...audit,
          action: EmailAuditAction.SECRET_REPLACED,
          afterState: { provider: 'RESEND', webhookSecretChanged: true },
        });
      }
    });

    this.settings.invalidate();
    return this.toView(await this.settings.snapshot());
  }

  async sendTest(
    actorUserId: string,
    body: SendTestEmailDto,
    requestId: string | null,
  ): Promise<SendTestEmailResult> {
    const recipient = body.recipient.trim();
    if (!isValidEmailAddress(recipient)) {
      throw new AppError(PalCertErrorCode.EMAIL_SETTINGS_INVALID, {
        message: 'The test recipient is not a valid email address.',
        details: { fields: ['recipient'] },
      });
    }
    // Per administrator and platform-wide: the test endpoint must never be a
    // relay, however many administrators there are.
    await this.throttle.consume(ThrottleScope.EMAIL_TEST_ADMIN, actorUserId);
    await this.throttle.consume(ThrottleScope.EMAIL_TEST_GLOBAL, 'platform');

    this.settings.invalidate();
    const decision = await this.settings.transportFor({ category: 'TEST' });
    if (decision.kind === 'LEGACY') {
      throw new AppError(PalCertErrorCode.EMAIL_PROVIDER_NOT_CONFIGURED, {
        message: 'Choose Resend and save an API key before sending a test email.',
      });
    }

    const base = {
      category: EmailDeliveryCategory.TEST,
      template: CONFIGURATION_TEST_TEMPLATE,
      recipient,
      requestedByUserId: actorUserId,
    };

    let result: SendTestEmailResult;
    if (decision.kind === 'SKIP') {
      const row = await this.recorder.queued({ ...base, provider: decision.providerName });
      await this.recorder.failed(
        row.id,
        OutboundEmailFailure.CONFIGURATION_ERROR,
        true,
        new Date(),
      );
      result = failureResult(row.id, OutboundEmailFailure.CONFIGURATION_ERROR);
    } else {
      const row = await this.recorder.queued({ ...base, provider: decision.provider.name });
      const rendered = renderTestEmail({
        locale: body.locale,
        environment: this.environmentLabel(),
        sender: `${decision.sender.name} <${decision.sender.email}>`,
        sentAt: new Date(),
      });
      await this.recorder.attemptStarted(row.id);
      try {
        const sent = await decision.provider.send({
          from: decision.sender,
          replyTo: decision.replyTo,
          to: recipient,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          idempotencyKey: `palcert-email-${row.id}`,
          tags: [{ name: 'category', value: 'test' }],
        });
        await this.recorder.accepted(row.id, sent.providerMessageId, new Date());
        result = {
          deliveryId: row.id,
          accepted: true,
          status: EmailDeliveryStatus.ACCEPTED,
          failure: null,
          failureSummary: null,
        };
      } catch (error) {
        const failure =
          error instanceof OutboundEmailError ? error.failure : OutboundEmailFailure.UNKNOWN;
        await this.recorder.failed(row.id, failure, true, new Date());
        result = failureResult(row.id, failure);
      }
    }

    await this.events.audit({
      action: EmailAuditAction.TEST_REQUESTED,
      actorUserId,
      targetType: TARGET_TYPE,
      targetId: TARGET_ID,
      requestId,
      afterState: {
        deliveryId: result.deliveryId,
        locale: body.locale,
        recipientDomain: recipient.split('@')[1]?.toLowerCase() ?? null,
        accepted: result.accepted,
        failure: result.failure,
      },
    });
    return result;
  }

  async listDeliveries(query: EmailDeliveryListQueryDto): Promise<Page<EmailDeliveryView>> {
    const limit = Math.min(query.limit ?? PAGINATION_DEFAULT_LIMIT, 100);
    const where: Prisma.EmailDeliveryWhereInput = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      ...(query.template !== undefined ? { template: query.template } : {}),
      ...(query.provider !== undefined ? { provider: query.provider } : {}),
      ...(query.from !== undefined || query.to !== undefined
        ? {
            createdAt: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    let cursorWhere: Prisma.EmailDeliveryWhereInput = {};
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      const at = decoded === null ? null : new Date(decoded.sortValue);
      if (decoded === null || at === null || Number.isNaN(at.getTime())) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
      }
      cursorWhere = {
        OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: decoded.id } }],
      };
    }

    const rows = await this.prisma.emailDelivery.findMany({
      where: { AND: [where, cursorWhere] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDeliveryView),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async getDelivery(id: string): Promise<EmailDeliveryView> {
    const row = await this.prisma.emailDelivery.findUnique({ where: { id } });
    if (row === null) {
      throw new AppError(PalCertErrorCode.EMAIL_DELIVERY_NOT_FOUND, {
        message: 'No email delivery with that id.',
      });
    }
    return toDeliveryView(row);
  }

  private async currentSnapshot(): Promise<EmailSettingsSnapshot> {
    this.settings.invalidate();
    return this.settings.snapshot();
  }

  private environmentLabel(): string {
    let host = '';
    try {
      host = new URL(this.config.publicWebUrl).host;
    } catch {
      host = '';
    }
    return host.length > 0 ? `${this.config.nodeEnv} (${host})` : this.config.nodeEnv;
  }

  private toView(s: EmailSettingsSnapshot): EmailSettingsView {
    const warnings: EmailSettingsWarning[] = [];
    if (s.provider === EmailProviderKind.RESEND) {
      if (s.sendingDomain.trim().length === 0) warnings.push(EmailSettingsWarning.DOMAIN_MISSING);
      if (s.sendingDomain.length > 0 && !addressMatchesDomain(s.fromEmail, s.sendingDomain)) {
        warnings.push(EmailSettingsWarning.FROM_OUTSIDE_DOMAIN);
      }
      if (s.apiKey === null) warnings.push(EmailSettingsWarning.API_KEY_MISSING);
      if (s.deliveryTrackingEnabled && s.webhookSecret === null) {
        warnings.push(EmailSettingsWarning.WEBHOOK_SECRET_MISSING);
      }
    }
    if (!this.settings.encryptionAvailable)
      warnings.push(EmailSettingsWarning.ENCRYPTION_UNAVAILABLE);
    return {
      provider: s.provider,
      enabled: s.enabled,
      sendingDomain: s.sendingDomain,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      replyToEmail: s.replyToEmail,
      authVerificationEnabled: s.authVerificationEnabled,
      authPasswordResetEnabled: s.authPasswordResetEnabled,
      authInvitationEnabled: s.authInvitationEnabled,
      workflowEmailEnabled: s.workflowEmailEnabled,
      deliveryTrackingEnabled: s.deliveryTrackingEnabled,
      apiKeyConfigured: s.apiKey !== null,
      apiKeyDisplayHint: s.apiKeyDisplayHint,
      webhookSecretConfigured: s.webhookSecret !== null,
      webhookSecretDisplayHint: s.webhookSecretDisplayHint,
      encryptionAvailable: this.settings.encryptionAvailable,
      isDefault: !s.saved,
      warnings,
      environment: this.environmentLabel(),
      updatedAt: s.updatedAt?.toISOString() ?? null,
      updatedByUserId: s.updatedByUserId,
    };
  }
}

/** The audit-safe projection: every non-secret field, and booleans for the secrets. */
function publicState(s: EmailSettingsSnapshot): Record<string, unknown> {
  return {
    provider: s.provider,
    enabled: s.enabled,
    sendingDomain: s.sendingDomain,
    fromEmail: s.fromEmail,
    fromName: s.fromName,
    replyToEmail: s.replyToEmail,
    authVerificationEnabled: s.authVerificationEnabled,
    authPasswordResetEnabled: s.authPasswordResetEnabled,
    authInvitationEnabled: s.authInvitationEnabled,
    workflowEmailEnabled: s.workflowEmailEnabled,
    deliveryTrackingEnabled: s.deliveryTrackingEnabled,
    apiKeyConfigured: s.apiKey !== null,
    webhookSecretConfigured: s.webhookSecret !== null,
  };
}

function failureResult(deliveryId: string, failure: OutboundEmailFailureCode): SendTestEmailResult {
  return {
    deliveryId,
    accepted: false,
    status: EmailDeliveryStatus.FAILED,
    failure,
    failureSummary: outboundFailureSummary(failure),
  };
}

export function toDeliveryView(row: EmailDelivery): EmailDeliveryView {
  return {
    id: row.id,
    category: row.category as EmailDeliveryView['category'],
    template: row.template,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    recipient: row.recipient,
    status: row.status as EmailDeliveryView['status'],
    failureCode: row.failureCode as EmailDeliveryView['failureCode'],
    failureSummary: row.failureSummary,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
  };
}
