import {
  WITHDRAWAL_REJECTION_REASONS,
  WITHDRAWAL_SCOPES,
  type WithdrawalRejectionReason,
  type WithdrawalScope,
} from '@palcert/contracts';
import type { WithdrawalNotificationFacts } from '../templates/notification-templates';

/** Anything that can run a tagged raw query: the unscoped client or a scoped transaction. */
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * The typed facts for one withdrawal notification, read from the request
 * itself through the database's narrow doorway (ADR-0150).
 *
 * Like the manual top-up facts, the function answers only to the fan-out
 * system path or to the notification's own recipient. It returns no
 * destination detail at all — not even a masked one — so no email can carry
 * an IBAN, an account number or a phone number.
 */
export async function readWithdrawalFacts(
  client: RawQueryClient,
  eventId: string,
  recipientUserId: string,
): Promise<WithdrawalNotificationFacts | null> {
  const rows = await client.$queryRaw<
    Array<{
      request_id: string;
      scope: string;
      amount_minor: bigint;
      currency: string;
      beneficiary_name: string | null;
      organization_id: string | null;
      organization_name: string | null;
      requester_name: string | null;
      requester_email: string | null;
      rejection_reason: string | null;
      submitted_at: Date | null;
    }>
  >`SELECT * FROM app_withdrawal_notification_facts(${eventId}::uuid, ${recipientUserId}::uuid)`;

  const row = rows[0];
  if (row === undefined || !(WITHDRAWAL_SCOPES as readonly string[]).includes(row.scope)) {
    return null;
  }
  const reason =
    row.rejection_reason !== null &&
    (WITHDRAWAL_REJECTION_REASONS as readonly string[]).includes(row.rejection_reason)
      ? (row.rejection_reason as WithdrawalRejectionReason)
      : null;
  return {
    requestId: row.request_id,
    scope: row.scope as WithdrawalScope,
    amountMinor: row.amount_minor,
    currency: row.currency,
    beneficiaryName: row.beneficiary_name ?? '',
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    requesterName: row.requester_name ?? '',
    requesterEmail: row.requester_email ?? '',
    rejectionReason: reason,
    submittedAt: row.submitted_at,
  };
}
