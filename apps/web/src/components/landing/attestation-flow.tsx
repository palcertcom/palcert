import { BrandMark, Icon, type IconName } from '@/components/ui/icon';

export interface AttestationFlowLabels {
  readonly label: string;
  readonly certificate: string;
  readonly review: string;
  readonly attested: string;
  readonly verify: string;
}

const STAGES: readonly { key: Exclude<keyof AttestationFlowLabels, 'label'>; icon: IconName }[] = [
  { key: 'certificate', icon: 'document' },
  { key: 'review', icon: 'organization' },
  { key: 'attested', icon: 'certificate' },
  { key: 'verify', icon: 'qr' },
];

/**
 * The attestation path in four stages: a certificate, the institution's
 * review, the attested credential, and public verification.
 *
 * An ordered list, so the order is read out as well as drawn; every stage is
 * named in words and the icons are decoration. The attested stage carries the
 * PalCert seal. The connectors are CSS and follow the reading direction.
 */
export function AttestationFlow({
  labels,
  headingId,
}: {
  labels: AttestationFlowLabels;
  headingId?: string;
}) {
  return (
    <ol
      className="pc-att-flow"
      {...(headingId === undefined
        ? { 'aria-label': labels.label }
        : { 'aria-labelledby': headingId })}
    >
      {STAGES.map((stage, index) => (
        <li key={stage.key} className="pc-att-flow-stage" data-stage={stage.key}>
          <span className="pc-att-flow-mark" aria-hidden="true">
            {stage.key === 'attested' ? (
              <BrandMark size={30} />
            ) : (
              <Icon name={stage.icon} size={24} />
            )}
          </span>
          <span className="pc-att-flow-number" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="pc-att-flow-label">{labels[stage.key]}</span>
        </li>
      ))}
    </ol>
  );
}
