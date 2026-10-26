import { StatusBadge } from '@/components/ui/status-badge';
import { labelFor, type OrganizationMessages } from '@/i18n/organization-messages';

/**
 * Verification badge (§27).
 *
 * The tooltip states what verification actually means, so the badge cannot be
 * read as a claim about academic quality.
 */
export function VerificationBadge({
  status,
  messages,
}: {
  status: string;
  messages: OrganizationMessages;
}) {
  const verified = status === 'VERIFIED';
  return (
    <StatusBadge
      status={status}
      tone={verified ? 'success' : status === 'REJECTED' ? 'danger' : 'neutral'}
      label={verified ? messages.verifiedBadge : labelFor(messages.verificationLabels, status)}
      title={messages.verificationSemantics}
    />
  );
}
