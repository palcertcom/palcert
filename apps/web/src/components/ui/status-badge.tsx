import { toneForStatus, type StatusTone } from '@/lib/status-tone';

/**
 * A status pill. The label is always shown — colour is never the only signal.
 *
 * Pass the backend `status` to derive the tone, or an explicit `tone` when the
 * meaning depends on context the status alone does not carry.
 */
export function StatusBadge({
  label,
  status,
  tone,
  title,
}: {
  label: string;
  status?: string | null;
  tone?: StatusTone;
  /** What the status means, where the label alone could be misread. */
  title?: string;
}) {
  const resolved = tone ?? toneForStatus(status);
  return (
    <span
      className="pc-status"
      data-tone={resolved}
      data-status={status ?? undefined}
      title={title}
    >
      <span className="pc-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
