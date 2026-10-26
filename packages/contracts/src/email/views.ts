import type {
  EmailDeliveryCategory,
  EmailDeliveryStatus,
  EmailProviderKind,
  EmailSettingsWarning,
  OutboundEmailFailure,
} from './email.js';

/**
 * What `GET /admin/email-settings` returns.
 *
 * The provider credential is represented by two fields only: whether one is
 * configured, and a display hint (`re_••••••••7XQ`). The plaintext, the
 * ciphertext, the IV, the authentication tag and the key id never leave the
 * server — not to administrators, not to auditors, not in error messages.
 */
export interface EmailSettingsView {
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
  readonly apiKeyConfigured: boolean;
  readonly apiKeyDisplayHint: string | null;
  readonly webhookSecretConfigured: boolean;
  readonly webhookSecretDisplayHint: string | null;
  /** False when the server has no root key: secrets cannot be saved or used. */
  readonly encryptionAvailable: boolean;
  /** True until an administrator has saved settings for the first time. */
  readonly isDefault: boolean;
  readonly warnings: readonly EmailSettingsWarning[];
  /** The deployment's environment label, for the test-mail banner. */
  readonly environment: string;
  readonly updatedAt: string | null;
  readonly updatedByUserId: string | null;
}

/**
 * What `PUT /admin/email-settings` accepts.
 *
 * `apiKey` / `webhookSecret`: omitted, null or blank keeps the stored value.
 * `clearWebhookSecret` removes the webhook secret explicitly; there is no way
 * to clear the API key other than replacing it or disabling the provider,
 * because a blank field must never mean "erase".
 */
export interface UpdateEmailSettingsRequest {
  readonly provider: EmailProviderKind;
  readonly enabled: boolean;
  readonly sendingDomain: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly replyToEmail?: string | null;
  readonly authVerificationEnabled: boolean;
  readonly authPasswordResetEnabled: boolean;
  readonly authInvitationEnabled: boolean;
  readonly workflowEmailEnabled: boolean;
  readonly deliveryTrackingEnabled: boolean;
  readonly apiKey?: string | null;
  readonly webhookSecret?: string | null;
  readonly clearWebhookSecret?: boolean;
}

export interface SendTestEmailRequest {
  readonly recipient: string;
  readonly locale: 'en' | 'ar';
}

/** The outcome of a test send. Never echoes provider text. */
export interface SendTestEmailResult {
  readonly deliveryId: string;
  readonly accepted: boolean;
  readonly status: EmailDeliveryStatus;
  readonly failure: OutboundEmailFailure | null;
  readonly failureSummary: string | null;
}

/**
 * One row of the delivery console. Metadata only: no body, no subject line
 * containing a token, no headers, no provider signatures, no credential.
 */
export interface EmailDeliveryView {
  readonly id: string;
  readonly category: EmailDeliveryCategory;
  readonly template: string;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly recipient: string;
  readonly status: EmailDeliveryStatus;
  readonly failureCode: OutboundEmailFailure | null;
  readonly failureSummary: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt: string | null;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  readonly lastEventAt: string | null;
}

export interface EmailDeliveryListQuery {
  readonly status?: EmailDeliveryStatus;
  readonly template?: string;
  readonly provider?: string;
  readonly category?: EmailDeliveryCategory;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}
