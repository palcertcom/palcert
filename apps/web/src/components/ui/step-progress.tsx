/**
 * The numbered step band from the original Graduate flow: 01 … 0n, a filled
 * marker for each step reached, a solid rule behind you and a dashed one for
 * the step in hand.
 *
 * It reports progress; it is not a navigation control. `aria-current="step"`
 * marks where the user is, and every step's state is written out for screen
 * readers rather than left to the marker colour.
 */
export function StepProgress({
  steps,
  current,
  label,
  stateLabels,
}: {
  steps: readonly string[];
  /** Zero-based index of the step in hand. */
  current: number;
  label: string;
  stateLabels: { done: string; current: string; upcoming: string };
}) {
  return (
    <ol className="pc-steps" aria-label={label}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
        return (
          <li
            key={step}
            className="pc-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="pc-step-number" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="pc-step-marker" aria-hidden="true">
              {state === 'done' ? (
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path
                    d="M2.5 6.2 5 8.5l4.5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </span>
            <span className="pc-step-label">
              {step}
              <span className="pc-visually-hidden"> — {stateLabels[state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
