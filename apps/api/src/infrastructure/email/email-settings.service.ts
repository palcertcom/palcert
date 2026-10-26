import { Injectable, type OnModuleInit } from '@nestjs/common';
import { parseWebhookKeyring } from '@palcert/config';
import {
  AuthEmailTemplate,
  DEFAULT_FROM_EMAIL,
  DEFAULT_FROM_NAME,
  DEFAULT_SENDING_DOMAIN,
  EmailProviderKind,
  EmailSkipReason,
} from '@palcert/contracts';
import type { PlatformEmailSettings } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../config/api-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  EmailSecretKeyring,
  EmailSecretPurpose,
  type SealedEmailSecret,
} from './email-secret-keyring';
import type { OutboundEmailProvider } from './outbound-email';
import { ResendEmailProvider } from './resend-email-provider';

/** The singleton row's fixed key. */
export const EMAIL_SETTINGS_ID = 1;

/**
 * The platform's email configuration as one process last read it.
 *
 * Holds sealed secrets, never opened ones: a decrypted credential exists only
 * for the duration of one send, in the provider instance built for it.
 */
export interface EmailSettingsSnapshot {
  /** False until an administrator has saved settings for the first time. */
  readonly saved: boolean;
  readonly provider: EmailProviderKind;
  readonly enabled: boolean;
  readonly sendingDomain: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly replyToEmail: string | null;
  readonly authVerificationEnabled: boolean;
  readonly authPasswordResetEnabled: boolean;
  readonly authInvitationEnabled: boolean;
  readonly workflowEmailEnabled: boolean;
  readonly deliveryTrackingEnabled: boolean;
  readonly apiKey: SealedEmailSecret | null;
  readonly apiKeyDisplayHint: string | null;
  readonly webhookSecret: SealedEmailSecret | null;
  readonly webhookSecretDisplayHint: string | null;
  readonly updatedAt: Date | null;
  readonly updatedByUserId: string | null;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettingsSnapshot = {
  saved: false,
  provider: EmailProviderKind.DISABLED,
  enabled: false,
  sendingDomain: DEFAULT_SENDING_DOMAIN,
  fromEmail: DEFAULT_FROM_EMAIL,
  fromName: DEFAULT_FROM_NAME,
  replyToEmail: null,
  authVerificationEnabled: true,
  authPasswordResetEnabled: true,
  authInvitationEnabled: true,
  workflowEmailEnabled: true,
  deliveryTrackingEnabled: true,
  apiKey: null,
  apiKeyDisplayHint: null,
  webhookSecret: null,
  webhookSecretDisplayHint: null,
  updatedAt: null,
  updatedByUserId: null,
};

export type EmailSendPurpose =
  | { readonly category: 'AUTH'; readonly template: AuthEmailTemplate }
  | { readonly category: 'WORKFLOW' }
  | { readonly category: 'TEST' };

/**
 * What a producer should do with one message.
 *
 *   LEGACY  the admin-managed provider is not in force: behave exactly as
 *           before the feature (auth → logging adapter, workflow → the
 *           environment-configured provider)
 *   SKIP    the admin-managed provider is in force but this message is not to
 *           be sent through it, for the stated reason
 *   READY   send through `provider`, from `sender`
 */
export type EmailTransportDecision =
  | { readonly kind: 'LEGACY' }
  | { readonly kind: 'SKIP'; readonly reason: EmailSkipReason; readonly providerName: string }
  | {
      readonly kind: 'READY';
      readonly provider: OutboundEmailProvider;
      readonly sender: { readonly email: string; readonly name: string };
      readonly replyTo: string | null;
    };

/** The pure part of the decision, so it can be tested without a database. */
export function decideEmailRoute(
  settings: EmailSettingsSnapshot,
  purpose: EmailSendPurpose,
): 'LEGACY' | 'NOT_CONFIGURED' | EmailSkipReason | 'SEND' {
  const resend = settings.provider === EmailProviderKind.RESEND;
  if (purpose.category === 'TEST') {
    // A test may run before the provider is switched on: that is how an
    // administrator validates a key without routing real mail through it.
    if (!resend || settings.apiKey === null) return 'NOT_CONFIGURED';
    return 'SEND';
  }
  if (!resend || !settings.enabled) return 'LEGACY';
  if (purpose.category === 'WORKFLOW') {
    return settings.workflowEmailEnabled ? 'SEND' : EmailSkipReason.CATEGORY_DISABLED;
  }
  switch (purpose.template) {
    case AuthEmailTemplate.EMAIL_VERIFICATION:
      if (!settings.authVerificationEnabled) return EmailSkipReason.CATEGORY_DISABLED;
      break;
    case AuthEmailTemplate.PASSWORD_RESET:
      if (!settings.authPasswordResetEnabled) return EmailSkipReason.CATEGORY_DISABLED;
      break;
    case AuthEmailTemplate.ORGANIZATION_INVITATION:
      if (!settings.authInvitationEnabled) return EmailSkipReason.CATEGORY_DISABLED;
      break;
    case AuthEmailTemplate.PASSWORD_CHANGED:
      // A security notice: it follows the provider, not a switch.
      break;
  }
  return 'SEND';
}

/**
 * The platform email configuration, as every process sees it (ADR-0146).
 *
 * Read from the database and cached for a few seconds, so an administrator's
 * change reaches the API and the worker without a restart or rebuild; the
 * process that saved it invalidates its own cache immediately. Only sealed
 * material is cached. The credential is opened for each send and dropped.
 */
@Injectable()
export class EmailSettingsService implements OnModuleInit {
  private readonly ring: EmailSecretKeyring | null;
  private cached: { readonly at: number; readonly value: EmailSettingsSnapshot } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmailSettingsService.name);
    this.ring = buildKeyring(config);
  }

  /**
   * Report, never refuse. A deployment whose stored credential names a key
   * this process does not hold still boots; mail through the admin-managed
   * provider fails closed as CONFIGURATION_ERROR and the dashboard says why.
   */
  async onModuleInit(): Promise<void> {
    try {
      const settings = await this.snapshot();
      for (const sealed of [settings.apiKey, settings.webhookSecret]) {
        if (sealed !== null && (this.ring === null || !this.ring.has(sealed.kid))) {
          this.logger.warn(
            { kid: sealed.kid },
            'stored email provider secret names an encryption key this process does not hold',
          );
        }
      }
    } catch {
      // The table may not exist yet in a process started before migration;
      // the migration check, not this, is what guards that.
    }
  }

  get encryptionAvailable(): boolean {
    return this.ring !== null;
  }

  /** The ring, for the settings writer. Null when no root key is configured. */
  keyring(): EmailSecretKeyring | null {
    return this.ring;
  }

  invalidate(): void {
    this.cached = null;
  }

  async snapshot(): Promise<EmailSettingsSnapshot> {
    const now = Date.now();
    const ttl = this.config.emailSettingsCacheMs;
    if (this.cached !== null && ttl > 0 && now - this.cached.at < ttl) {
      return this.cached.value;
    }
    const row = await this.prisma.platformEmailSettings.findUnique({
      where: { id: EMAIL_SETTINGS_ID },
    });
    const value = row === null ? DEFAULT_EMAIL_SETTINGS : toSnapshot(row);
    this.cached = { at: now, value };
    return value;
  }

  /** Decide, and when the answer is "send", build the provider with the opened key. */
  async transportFor(purpose: EmailSendPurpose): Promise<EmailTransportDecision> {
    const settings = await this.snapshot();
    const route = decideEmailRoute(settings, purpose);
    if (route === 'LEGACY' || route === 'NOT_CONFIGURED') return { kind: 'LEGACY' };
    if (route !== 'SEND') return { kind: 'SKIP', reason: route, providerName: 'resend' };

    const apiKey = this.openSecret(settings.apiKey, EmailSecretPurpose.API_KEY);
    if (apiKey === null) {
      return {
        kind: 'SKIP',
        reason: EmailSkipReason.CREDENTIAL_UNAVAILABLE,
        providerName: 'resend',
      };
    }
    return {
      kind: 'READY',
      provider: new ResendEmailProvider(apiKey, this.config.resend),
      sender: { email: settings.fromEmail, name: settings.fromName },
      replyTo: settings.replyToEmail,
    };
  }

  /** The webhook signing secret, opened for one verification. */
  async openWebhookSecret(): Promise<string | null> {
    const settings = await this.snapshot();
    if (settings.provider !== EmailProviderKind.RESEND) return null;
    return this.openSecret(settings.webhookSecret, EmailSecretPurpose.WEBHOOK_SECRET);
  }

  private openSecret(sealed: SealedEmailSecret | null, purpose: EmailSecretPurpose): string | null {
    if (sealed === null || this.ring === null) return null;
    try {
      return this.ring.open(sealed, { purpose, provider: EmailProviderKind.RESEND });
    } catch (error) {
      // The error names a key id at most. Never the material.
      this.logger.error(
        { kid: sealed.kid, purpose, error: error instanceof Error ? error.name : 'unknown' },
        'email provider secret could not be opened',
      );
      return null;
    }
  }
}

function buildKeyring(config: ApiConfigService): EmailSecretKeyring | null {
  const settings = config.emailSettingsEncryption;
  if (settings === null) return null;
  const parsed = parseWebhookKeyring(settings.keys);
  if (parsed.errors.length > 0) {
    // Validated at boot; reaching here means configuration changed underneath.
    throw new Error(`email settings keyring is invalid: ${parsed.errors.join('; ')}`);
  }
  return new EmailSecretKeyring(
    parsed.entries.map((entry) => ({ kid: entry.kid, key: entry.key })),
    settings.activeKid,
  );
}

function sealed(
  ciphertext: string | null,
  iv: string | null,
  authTag: string | null,
  kid: string | null,
): SealedEmailSecret | null {
  if (ciphertext === null || iv === null || authTag === null || kid === null) return null;
  return { ciphertext, iv, authTag, kid };
}

export function toSnapshot(row: PlatformEmailSettings): EmailSettingsSnapshot {
  return {
    saved: true,
    provider:
      row.provider === EmailProviderKind.RESEND
        ? EmailProviderKind.RESEND
        : EmailProviderKind.DISABLED,
    enabled: row.enabled,
    sendingDomain: row.sendingDomain,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyToEmail: row.replyToEmail,
    authVerificationEnabled: row.authVerificationEnabled,
    authPasswordResetEnabled: row.authPasswordResetEnabled,
    authInvitationEnabled: row.authInvitationEnabled,
    workflowEmailEnabled: row.workflowEmailEnabled,
    deliveryTrackingEnabled: row.deliveryTrackingEnabled,
    apiKey: sealed(row.apiKeyCiphertext, row.apiKeyIv, row.apiKeyAuthTag, row.apiKeyKid),
    apiKeyDisplayHint: row.apiKeyDisplayHint,
    webhookSecret: sealed(
      row.webhookSecretCiphertext,
      row.webhookSecretIv,
      row.webhookSecretAuthTag,
      row.webhookSecretKid,
    ),
    webhookSecretDisplayHint: row.webhookSecretDisplayHint,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  };
}
