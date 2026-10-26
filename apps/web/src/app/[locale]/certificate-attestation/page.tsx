import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttestationFlow } from '@/components/landing/attestation-flow';
import { BrandMark, Icon, type IconName } from '@/components/ui/icon';
import { getAttestationInfoMessages } from '@/i18n/attestation-info-messages';
import { getLandingMessages } from '@/i18n/landing-messages';
import { LOCALES, isLocale } from '@/i18n/locales';
import { attestationEntry } from '@/lib/attestation-entry';
import { hasSessionCookie } from '@/server/session/session-hint';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const m = getAttestationInfoMessages(locale).meta;
  // The brand is written PalCert in both languages on this page.
  const title = `${m.title} | PalCert`;
  return {
    title,
    description: m.description,
    alternates: {
      languages: Object.fromEntries(
        LOCALES.map((candidate) => [candidate, `/${candidate}/certificate-attestation`]),
      ),
    },
    openGraph: { title, description: m.description, locale, type: 'website' },
  };
}

const BENEFIT_ICONS: readonly IconName[] = [
  'organization',
  'review',
  'bell',
  'fingerprint',
  'verified',
  'qr',
  'history',
  'shield',
  'lock',
];

/**
 * What institutional certificate attestation is, for anyone — before they
 * have an account.
 *
 * Informational only. It reads no organization, type or fee: those are shown
 * inside the signed-in workflow, which this page links to and never
 * duplicates. A visitor with a session cookie is sent straight to the
 * workflow; one without goes through sign-in, which returns them there.
 */
export default async function CertificateAttestationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getAttestationInfoMessages(locale);
  const flow = getLandingMessages(locale).services.flow;
  const base = `/${locale}`;
  const signedIn = await hasSessionCookie();
  const entry = attestationEntry(locale, signedIn);

  return (
    <main className="pc-landing pc-att-page">
      {/* --- Hero --------------------------------------------------------- */}
      <section className="pc-lp-hero pc-att-hero" aria-labelledby="att-title">
        <div className="pc-lp-inner pc-att-hero-grid">
          <div className="pc-lp-hero-copy">
            <p className="pc-lp-eyebrow">{m.hero.eyebrow}</p>
            <h1 id="att-title">{m.hero.title}</h1>
            <p className="pc-lp-hero-lead">{m.hero.lead}</p>
            <div className="pc-lp-actions">
              <Link
                className="pc-btn pc-lp-btn"
                href={entry.request}
                data-testid="info-request-attestation"
              >
                {m.hero.request}
              </Link>
              <Link
                className="pc-btn pc-btn-secondary pc-lp-btn"
                href={entry.mine}
                data-testid="info-my-requests"
              >
                {m.hero.myRequests}
              </Link>
            </div>
            {signedIn ? null : (
              <p className="pc-lp-signin">
                {m.hero.newHere} <Link href={`${base}/register`}>{m.hero.createAccount}</Link>
              </p>
            )}
          </div>
          <div className="pc-att-hero-visual">
            <span className="pc-att-hero-seal" aria-hidden="true">
              <BrandMark size={72} />
            </span>
            <h2 id="att-flow-title" className="pc-att-hero-visual-title">
              {flow.label}
            </h2>
            <AttestationFlow labels={flow} headingId="att-flow-title" />
          </div>
        </div>
      </section>

      {/* --- How it works ------------------------------------------------- */}
      <section className="pc-lp-section" data-tone="cream" aria-labelledby="att-steps">
        <div className="pc-lp-inner">
          <header className="pc-lp-heading" data-align="center">
            <p className="pc-lp-eyebrow">{m.steps.eyebrow}</p>
            <h2 id="att-steps">{m.steps.title}</h2>
            <p className="pc-lp-lead">{m.steps.lead}</p>
          </header>
          <ol className="pc-att-steps">
            {m.steps.items.map((step, index) => (
              <li key={step.title} className="pc-att-step" data-actor={step.actor}>
                <span className="pc-lp-step-marker" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p className="pc-lp-step-actor" data-actor={actorStyle(step.actor)}>
                    {m.steps.actors[step.actor]}
                  </p>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* --- What you get ------------------------------------------------- */}
      <section className="pc-lp-section" aria-labelledby="att-benefits">
        <div className="pc-lp-inner">
          <header className="pc-lp-heading">
            <p className="pc-lp-eyebrow">{m.benefits.eyebrow}</p>
            <h2 id="att-benefits">{m.benefits.title}</h2>
            <p className="pc-lp-lead">{m.benefits.lead}</p>
          </header>
          <ul className="pc-lp-modules pc-att-benefits">
            {m.benefits.items.map((item, index) => (
              <li key={item.title} className="pc-lp-module">
                <span className="pc-lp-icon-tile" aria-hidden="true">
                  <Icon name={BENEFIT_ICONS[index] ?? 'check'} size={22} />
                </span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* --- Who attests -------------------------------------------------- */}
      <section className="pc-lp-section" data-tone="cream" aria-labelledby="att-institution">
        <div className="pc-lp-inner">
          <header className="pc-lp-heading">
            <p className="pc-lp-eyebrow">{m.institution.eyebrow}</p>
            <h2 id="att-institution">{m.institution.title}</h2>
            <p className="pc-lp-lead">{m.institution.lead}</p>
          </header>
          <div className="pc-att-roles">
            <article
              className="pc-att-role"
              data-role="institution"
              aria-labelledby="att-role-inst"
            >
              <span className="pc-lp-icon-tile" aria-hidden="true">
                <Icon name="organization" size={22} />
              </span>
              <h3 id="att-role-inst">{m.institution.institutionTitle}</h3>
              <ul className="pc-lp-points">
                {m.institution.institutionPoints.map((point) => (
                  <li key={point}>
                    <Icon name="check" size={16} />
                    {point}
                  </li>
                ))}
              </ul>
            </article>
            <article className="pc-att-role" data-role="palcert" aria-labelledby="att-role-pc">
              <span className="pc-lp-icon-tile pc-lp-seal-tile" aria-hidden="true">
                <BrandMark size={30} />
              </span>
              <h3 id="att-role-pc">{m.institution.palcertTitle}</h3>
              <ul className="pc-lp-points">
                {m.institution.palcertPoints.map((point) => (
                  <li key={point}>
                    <Icon name="check" size={16} />
                    {point}
                  </li>
                ))}
              </ul>
            </article>
          </div>
          <p className="pc-att-boundary">{m.institution.badgeNote}</p>
        </div>
      </section>

      {/* --- After approval ----------------------------------------------- */}
      <section className="pc-lp-section" aria-labelledby="att-verification">
        <div className="pc-lp-inner pc-att-verify-grid">
          <div>
            <header className="pc-lp-heading">
              <p className="pc-lp-eyebrow">{m.verification.eyebrow}</p>
              <h2 id="att-verification">{m.verification.title}</h2>
              <p className="pc-lp-lead">{m.verification.lead}</p>
            </header>
            <ul className="pc-lp-points">
              {m.verification.points.map((point) => (
                <li key={point}>
                  <Icon name="check" size={16} />
                  {point}
                </li>
              ))}
            </ul>
            <Link
              className="pc-btn pc-btn-secondary pc-lp-btn pc-att-verify-action"
              href={`${base}/verify`}
              data-testid="info-verify"
            >
              <Icon name="verified" size={18} />
              {m.verification.action}
            </Link>
            <p className="pc-lp-caption">{m.verification.note}</p>
          </div>
          <div className="pc-att-statuses">
            <h3 id="att-statuses">{m.verification.statusesLabel}</h3>
            <ul aria-labelledby="att-statuses">
              {m.verification.statuses.map((status) => (
                <li key={status.key} className="pc-att-status" data-status={status.key}>
                  <span className="pc-att-status-name">{status.title}</span>
                  <span>{status.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* --- Fees and files ------------------------------------------------ */}
      <section className="pc-lp-section" data-tone="cream" aria-labelledby="att-fees">
        <div className="pc-lp-inner pc-att-facts">
          <article className="pc-att-fact" aria-labelledby="att-fees">
            <span className="pc-lp-icon-tile" aria-hidden="true">
              <Icon name="balance" size={22} />
            </span>
            <h2 id="att-fees">{m.fees.title}</h2>
            <p className="pc-att-fact-lead">{m.fees.lead}</p>
            <ul className="pc-lp-points">
              {m.fees.points.map((point) => (
                <li key={point}>
                  <Icon name="check" size={16} />
                  {point}
                </li>
              ))}
            </ul>
          </article>
          <article className="pc-att-fact" aria-labelledby="att-formats">
            <span className="pc-lp-icon-tile" aria-hidden="true">
              <Icon name="upload" size={22} />
            </span>
            <h2 id="att-formats">{m.formats.title}</h2>
            <ul className="pc-att-formats" aria-label={m.formats.listLabel}>
              {m.formats.list.map((format) => (
                <li key={format} dir="ltr">
                  {format}
                </li>
              ))}
            </ul>
            <p className="pc-att-fact-lead">{m.formats.lead}</p>
          </article>
        </div>
      </section>

      {/* --- Closing call to action ---------------------------------------- */}
      <section className="pc-lp-cta" aria-labelledby="att-cta">
        <div className="pc-lp-inner">
          <div className="pc-lp-cta-panel">
            <div>
              <h2 id="att-cta">{m.cta.title}</h2>
              <p>{m.cta.lead}</p>
            </div>
            <div className="pc-lp-cta-actions">
              <div className="pc-lp-actions">
                <Link className="pc-btn pc-lp-btn" href={entry.request}>
                  {m.hero.request}
                </Link>
                <Link className="pc-btn pc-btn-secondary pc-lp-btn" href={entry.mine}>
                  {m.hero.myRequests}
                </Link>
              </div>
              {signedIn ? null : (
                <p className="pc-lp-signin">
                  {m.hero.newHere} <Link href={`${base}/register`}>{m.hero.createAccount}</Link>
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/** The step tags reuse the homepage's three tag styles. */
function actorStyle(actor: 'you' | 'institution' | 'palcert'): string {
  return actor === 'you' ? 'author' : actor;
}
