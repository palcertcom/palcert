/**
 * The gold wave that closes a page in the original design, redrawn as a few
 * scalable curves rather than an image. Purely decorative.
 */
export function Wave({ className = 'pc-wave' }: { className?: string }) {
  const lines = Array.from({ length: 14 }, (_, index) => index);
  return (
    <svg
      className={className}
      viewBox="0 0 1440 220"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke">
        {lines.map((index) => {
          const lift = index * 6;
          return (
            <path
              key={index}
              opacity={0.18 + index * 0.035}
              d={`M0 ${150 - lift * 0.6} C 200 ${40 + lift}, 360 ${20 + lift * 1.4}, 560 ${
                150 - lift * 0.2
              } S 980 ${215 - lift * 0.4}, 1180 ${190 - lift * 0.8} S 1400 ${
                70 + lift * 1.6
              }, 1440 ${10 + lift * 1.8}`}
            />
          );
        })}
      </g>
    </svg>
  );
}
