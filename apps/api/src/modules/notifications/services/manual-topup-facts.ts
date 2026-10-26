import {
  MANUAL_TOPUP_REJECTION_REASONS,
  type ManualTopUpRejectionReason,
} from '@palcert/contracts';
import type { ManualTopUpNotificationFacts } from '../templates/notification-templates';

/** Anything that can run a tagged raw query: the unscoped client or a scoped transaction. */
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * The typed facts for one manual top-up notification, read from the request
 * itself through the database's narrow doorway.
 *
 * The function answers only to the fan-out system path or to the
 * notification's own recipient, and returns only the allow-listed columns.
 * Null when the event is not a manual top-up or the request lacks a reported
 * amount (which a submitted request never does).
 */
export async function readManualTopUpFacts(
  client: RawQueryClient,
  eventId: string,
  recipientUserId: string,
): Promise<ManualTopUpNotificationFacts | null> {
  const rows = await client.$queryRaw<
    Array<{
      amount_minor: bigint | null;
      currency: string;
      method_name_en: string | null;
      method_name_ar: string | null;
      reference: string | null;
      rejection_reason: string | null;
      submitted_at: Date | null;
    }>
  >`SELECT * FROM app_manual_topup_notification_facts(${eventId}::uuid, ${recipientUserId}::uuid)`;

  const row = rows[0];
  if (
    row === undefined ||
    row.amount_minor === null ||
    row.method_name_en === null ||
    row.method_name_ar === null ||
    row.reference === null
  ) {
    return null;
  }
  const reason =
    row.rejection_reason !== null &&
    (MANUAL_TOPUP_REJECTION_REASONS as readonly string[]).includes(row.rejection_reason)
      ? (row.rejection_reason as ManualTopUpRejectionReason)
      : null;
  return {
    amountMinor: row.amount_minor,
    currency: row.currency,
    methodNameEn: row.method_name_en,
    methodNameAr: row.method_name_ar,
    reference: row.reference,
    rejectionReason: reason,
    submittedAt: row.submitted_at,
  };
}
