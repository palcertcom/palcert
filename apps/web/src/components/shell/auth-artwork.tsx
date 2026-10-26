/**
 * The sign-in illustration: an original line drawing, not a copy of the
 * original design's raster art. A diploma and a transcript under review, a
 * check mark and a seal: documents being checked and certified. Drawn in the
 * brand's gold and charcoal with thin strokes so it stays quiet beside the
 * form, and it reads the same in either direction.
 */
export function AuthArtwork({ label }: { label: string }) {
  return (
    <svg
      className="pc-auth-art"
      viewBox="0 0 480 360"
      role="img"
      aria-label={label}
      focusable="false"
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {/* Soft ground */}
        <ellipse cx="240" cy="318" rx="190" ry="16" fill="var(--pc-cream)" />
        <path
          d="M70 220c-20-70 30-150 120-170 60-14 120 4 160 40 50 44 70 110 40 170"
          stroke="var(--pc-gold-line)"
          strokeWidth="1.5"
          strokeDasharray="4 8"
        />

        {/* Back sheet: a transcript */}
        <g transform="rotate(-7 190 170)">
          <rect
            x="112"
            y="78"
            width="150"
            height="196"
            rx="6"
            fill="#fff"
            stroke="var(--pc-border-strong)"
            strokeWidth="2"
          />
          <path
            d="M132 108h86M132 128h110M132 146h96M132 164h110M132 182h70M132 200h104M132 218h84"
            stroke="var(--pc-border-strong)"
            strokeWidth="3"
          />
        </g>

        {/* Front sheet: the certificate */}
        <rect
          x="196"
          y="92"
          width="176"
          height="210"
          rx="6"
          fill="#fff"
          stroke="var(--pc-charcoal)"
          strokeWidth="2"
        />
        <rect
          x="208"
          y="104"
          width="152"
          height="186"
          rx="3"
          stroke="var(--pc-gold)"
          strokeWidth="1.5"
        />
        <path d="M244 132h80" stroke="var(--pc-charcoal)" strokeWidth="3" />
        <path
          d="M232 152h104M240 168h88M236 184h96"
          stroke="var(--pc-border-strong)"
          strokeWidth="2.5"
        />
        {/* The PalCert diamond, small, as a letterhead mark */}
        <path d="M284 110l8 8-8 8-8-8z" stroke="var(--pc-gold)" strokeWidth="1.8" />

        {/* Seal and ribbons */}
        <path
          d="M312 250l-8 36 16-9 14 11-4-38"
          fill="var(--pc-gold-tint)"
          stroke="var(--pc-gold)"
          strokeWidth="1.8"
        />
        <circle cx="320" cy="238" r="24" fill="#fff" stroke="var(--pc-gold)" strokeWidth="2" />
        <circle
          cx="320"
          cy="238"
          r="16"
          stroke="var(--pc-gold)"
          strokeWidth="1.2"
          strokeDasharray="2 3"
        />
        <path d="M312 238l6 6 10-12" stroke="var(--pc-gold-text)" strokeWidth="2.4" />
        <path d="M232 262h52" stroke="var(--pc-charcoal)" strokeWidth="1.5" />

        {/* Magnifier: the check */}
        <g>
          <circle
            cx="132"
            cy="252"
            r="34"
            fill="rgb(255 255 255 / 85%)"
            stroke="var(--pc-charcoal)"
            strokeWidth="2.4"
          />
          <path d="M156 276l30 30" stroke="var(--pc-charcoal)" strokeWidth="6" />
          <path d="M118 252l10 10 18-20" stroke="var(--pc-gold)" strokeWidth="3" />
        </g>

        {/* Floating verification tags */}
        <g transform="translate(372 62)">
          <rect
            width="64"
            height="30"
            rx="15"
            fill="#fff"
            stroke="var(--pc-gold)"
            strokeWidth="1.5"
          />
          <path d="M16 15l5 5 9-10" stroke="var(--pc-gold-text)" strokeWidth="2.2" />
          <path d="M38 15h14" stroke="var(--pc-border-strong)" strokeWidth="2.5" />
        </g>
        <g transform="translate(60 96)">
          <rect
            width="46"
            height="46"
            rx="8"
            fill="#fff"
            stroke="var(--pc-border-strong)"
            strokeWidth="1.5"
            transform="rotate(-10 23 23)"
          />
          <path d="M16 22l6 6 10-12" stroke="var(--pc-gold)" strokeWidth="2.4" />
        </g>
        <circle cx="404" cy="170" r="5" fill="var(--pc-gold)" />
        <circle cx="96" cy="60" r="3" fill="var(--pc-gold-line)" />
        <circle cx="430" cy="252" r="3.5" fill="var(--pc-gold-line)" />
        <path d="M388 214l10 0M393 209l0 10" stroke="var(--pc-gold)" strokeWidth="1.8" />
      </g>
    </svg>
  );
}
