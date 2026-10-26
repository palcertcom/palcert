import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark, Icon, type IconName } from '@/components/ui/icon';
import {
  getLandingMessages,
  type LandingAudienceKey,
  type LandingModuleKey,
} from '@/i18n/landing-messages';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { Wave } from '@/components/shell/decor';
import { attestationEntry } from '@/lib/attestation-entry';
import { AttestationFlow } from './attestation-flow';
import { LandingHeader } from './landing-header';
import { LANDING_SECTIONS } from './landing-sections';
import {
  DashboardPreview,
  DocumentsPreview,
  ReportPreview,
  ReviewQueuePreview,
  VerificationPreview,
  WorkspacePreview,
} from './previews';

/**
 * PalCert's public homepage, for a visitor who is not signed in.
 *
 * A product page rather than a splash screen: what PalCert is, its three
 * services (document checking, institutional certificate attestation and
 * public verification — kept apart on purpose), the stages a document goes
 * through, the modules that carry it, who it serves, why it can be trusted,
 * and where to go next. Every section describes the product
 * as it works today; the previews are illustrations and are captioned so.
 * The next steps are the real ones — create an account, sign in, or verify a
 * certificate without an account.
 */

const MODULES: readonly { key: LandingModuleKey; icon: IconName; audience: Audience }[] = [
  { key: 'documents', icon: 'document', audience: 'authors' },
  { key: 'checks', icon: 'check', audience: 'authors' },
  { key: 'smartfix', icon: 'wand', audience: 'authors' },
  { key: 'ai', icon: 'sparkle', audience: 'authors' },
  { key: 'submissions', icon: 'submission', audience: 'authors' },
  { key: 'review', icon: 'review', audience: 'institutions' },
  { key: 'standards', icon: 'standard', audience: 'institutions' },
  { key: 'certificates', icon: 'certificate', audience: 'authors' },
  { key: 'verification', icon: 'verified', audience: 'everyone' },
  { key: 'notifications', icon: 'bell', audience: 'everyone' },
  { key: 'balance', icon: 'balance', audience: 'authors' },
  { key: 'integrations', icon: 'webhook', audience: 'institutions' },
];
type Audience = 'authors' | 'institutions' | 'everyone';

const AUDIENCES: readonly { key: LandingAudienceKey; icon: IconName }[] = [
  { key: 'authors', icon: 'user' },
  { key: 'institutions', icon: 'organization' },
  { key: 'reviewers', icon: 'review' },
  { key: 'verifiers', icon: 'verified' },
];

const HERO_SERVICES: readonly {
  key: 'checking' | 'attestation' | 'verification';
  icon: IconName;
}[] = [
  { key: 'checking', icon: 'check' },
  { key: 'attestation', icon: 'certificate' },
  { key: 'verification', icon: 'verified' },
];

const TRUST_ICONS: readonly IconName[] = [
  'lock',
  'shield',
  'upload',
  'history',
  'fingerprint',
  'verified',
  'sparkle',
  'balance',
];

function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
  align = 'start',
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
  align?: 'start' | 'center';
}) {
  return (
    <header className="pc-lp-heading" data-align={align}>
      <p className="pc-lp-eyebrow">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {lead ? <p className="pc-lp-lead">{lead}</p> : null}
    </header>
  );
}

function Section({
  id,
  tone = 'plain',
  labelledBy,
  children,
}: {
  id?: string;
  tone?: 'plain' | 'cream';
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="pc-lp-section" data-tone={tone} aria-labelledby={labelledBy}>
      <div className="pc-lp-inner">{children}</div>
    </section>
  );
}

export function LandingPage({ locale }: { locale: Locale }) {
  const t = getLandingMessages(locale);
  const shell = getShellMessages(locale);
  const base = `/${locale}`;
  // Only a visitor without a session sees this page, so the signed-in
  // features are reached through sign-in, which returns to them.
  const entry = attestationEntry(locale, false);
  const s = t.services;

  // The whole frame is drawn here rather than by the application shell, so
  // the page can be rendered on the server for a visitor who is not signed
  // in: everything below is public, and none of it depends on a session.
  // Each part is a direct child of <body>, as the shell's grid expects.
  return (
    <>
      <a className="pc-skip-link" href="#pc-content">
        {shell.skipToContent}
      </a>
      <LandingHeader locale={locale} />
      <span id="pc-content" className="pc-app-context pc-content-anchor" tabIndex={-1} />
      <main className="pc-landing">
        {/* --- Hero ------------------------------------------------------- */}
        <section className="pc-lp-hero" aria-labelledby="lp-hero-title">
          <div className="pc-lp-inner pc-lp-hero-grid">
            <div className="pc-lp-hero-copy">
              <p className="pc-lp-eyebrow">{t.hero.eyebrow}</p>
              <h1 id="lp-hero-title">{t.hero.title}</h1>
              <p className="pc-lp-hero-lead">{t.hero.lead}</p>
              <div className="pc-lp-actions">
                <Link
                  className="pc-btn pc-lp-btn"
                  href={entry.request}
                  data-testid="hero-request-attestation"
                >
                  <Icon name="certificate" size={18} />
                  {s.attestation.action}
                </Link>
                <Link
                  className="pc-btn pc-btn-secondary pc-lp-btn"
                  href={`${base}/verify`}
                  data-testid="hero-verify"
                >
                  <Icon name="verified" size={18} />
                  {shell.verifyCertificate}
                </Link>
              </div>
              <ul
                className="pc-lp-hero-services"
                aria-label={t.hero.servicesLabel}
                data-testid="hero-services"
              >
                {HERO_SERVICES.map((service) => {
                  const content = t.hero.services[service.key];
                  const target =
                    service.key === 'attestation'
                      ? `${base}/certificate-attestation`
                      : service.key === 'verification'
                        ? `${base}/verify`
                        : '#services';
                  return (
                    <li
                      key={service.key}
                      data-service={service.key}
                      {...(service.key === 'attestation' ? { 'data-featured': 'true' } : {})}
                    >
                      <a href={target}>
                        <span className="pc-lp-hero-service-mark" aria-hidden="true">
                          {service.key === 'attestation' ? (
                            <BrandMark size={28} />
                          ) : (
                            <Icon name={service.icon} size={20} />
                          )}
                        </span>
                        <span className="pc-lp-hero-service-text">
                          <strong>{content.title}</strong>
                          <span>{content.text}</span>
                        </span>
                        <Icon name="chevron" size={16} />
                      </a>
                    </li>
                  );
                })}
              </ul>
              <p className="pc-lp-hero-more">
                <Link className="pc-lp-text-link" href={`${base}/register`}>
                  {shell.createAccount}
                  <Icon name="arrow" size={16} />
                </Link>
                <a className="pc-lp-text-link" href="#services">
                  {t.hero.explore}
                  <Icon name="arrow" size={16} />
                </a>
              </p>
            </div>
            <figure className="pc-lp-hero-figure">
              <WorkspacePreview locale={locale} />
              <figcaption className="pc-lp-caption">{t.hero.previewCaption}</figcaption>
            </figure>
          </div>
        </section>

        {/* --- Services ---------------------------------------------------- */}
        <Section id="services" labelledBy="lp-services">
          <SectionHeading
            id="lp-services"
            eyebrow={s.eyebrow}
            title={s.title}
            lead={s.lead}
            align="center"
          />
          <ul className="pc-lp-services">
            <li className="pc-lp-service" data-service="checking">
              <article aria-labelledby="lp-service-checking">
                <span className="pc-lp-icon-tile" aria-hidden="true">
                  <Icon name="check" size={22} />
                </span>
                <h3 id="lp-service-checking">{s.checking.title}</h3>
                <p>{s.checking.text}</p>
                <ul className="pc-lp-points">
                  {s.checking.points.map((point) => (
                    <li key={point}>
                      <Icon name="check" size={16} />
                      {point}
                    </li>
                  ))}
                </ul>
                <Link className="pc-lp-text-link" href={entry.check}>
                  {s.checking.action}
                  <Icon name="arrow" size={16} />
                </Link>
              </article>
            </li>
            <li className="pc-lp-service" data-service="attestation" data-featured="true">
              <article aria-labelledby="lp-service-attestation" data-testid="service-attestation">
                <div className="pc-lp-service-top">
                  <span className="pc-lp-icon-tile pc-lp-seal-tile" aria-hidden="true">
                    <BrandMark size={34} />
                  </span>
                  <p className="pc-lp-service-badge">{s.attestation.badge}</p>
                </div>
                <h3 id="lp-service-attestation">{s.attestation.title}</h3>
                <p>{s.attestation.text}</p>
                <ul className="pc-lp-points">
                  {s.attestation.points.map((point) => (
                    <li key={point}>
                      <Icon name="check" size={16} />
                      {point}
                    </li>
                  ))}
                </ul>
                <div className="pc-lp-service-actions">
                  <Link
                    className="pc-btn pc-lp-btn"
                    href={entry.request}
                    data-testid="service-request-attestation"
                  >
                    {s.attestation.action}
                  </Link>
                  <Link className="pc-lp-text-link" href={`${base}/certificate-attestation`}>
                    {s.attestation.learnMore}
                    <Icon name="arrow" size={16} />
                  </Link>
                </div>
              </article>
            </li>
            <li className="pc-lp-service" data-service="verification">
              <article aria-labelledby="lp-service-verification">
                <span className="pc-lp-icon-tile" aria-hidden="true">
                  <Icon name="verified" size={22} />
                </span>
                <h3 id="lp-service-verification">{s.verification.title}</h3>
                <p>{s.verification.text}</p>
                <ul className="pc-lp-points">
                  {s.verification.points.map((point) => (
                    <li key={point}>
                      <Icon name="check" size={16} />
                      {point}
                    </li>
                  ))}
                </ul>
                <Link className="pc-lp-text-link" href={`${base}/verify`}>
                  {s.verification.action}
                  <Icon name="arrow" size={16} />
                </Link>
              </article>
            </li>
          </ul>
          <div className="pc-lp-att-path">
            <h3 id="lp-att-path">{s.flow.label}</h3>
            <AttestationFlow labels={s.flow} headingId="lp-att-path" />
          </div>
        </Section>

        {/* --- Workflow --------------------------------------------------- */}
        <Section id="how-it-works" tone="cream" labelledBy="lp-workflow">
          <SectionHeading
            id="lp-workflow"
            eyebrow={t.workflow.eyebrow}
            title={t.workflow.title}
            lead={t.workflow.lead}
            align="center"
          />
          <ol className="pc-lp-steps">
            {t.workflow.steps.map((step, index) => (
              <li key={step.title} className="pc-lp-step">
                <span className="pc-lp-step-marker" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3>{step.title}</h3>
                <p className="pc-lp-step-actor" data-actor={step.actor}>
                  {t.workflow.actors[step.actor]}
                </p>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* --- Modules ---------------------------------------------------- */}
        <Section id="platform" labelledBy="lp-platform">
          <SectionHeading
            id="lp-platform"
            eyebrow={t.platform.eyebrow}
            title={t.platform.title}
            lead={t.platform.lead}
          />
          <ul className="pc-lp-modules">
            {MODULES.map((module) => (
              <li key={module.key} className="pc-lp-module">
                <span className="pc-lp-icon-tile" aria-hidden="true">
                  <Icon name={module.icon} size={22} />
                </span>
                <h3>{t.platform.modules[module.key].title}</h3>
                <p>{t.platform.modules[module.key].text}</p>
                <p className="pc-lp-tag">{t.platform.audiences[module.audience]}</p>
              </li>
            ))}
          </ul>
        </Section>

        {/* --- Solutions by audience -------------------------------------- */}
        <Section id="solutions" tone="cream" labelledBy="lp-solutions">
          <SectionHeading
            id="lp-solutions"
            eyebrow={t.solutions.eyebrow}
            title={t.solutions.title}
            lead={t.solutions.lead}
          />
          <ul className="pc-lp-audiences">
            {AUDIENCES.map((audience) => {
              const content = t.solutions.audiences[audience.key];
              const action =
                audience.key === 'verifiers'
                  ? { href: `${base}/verify`, label: shell.verifyCertificate }
                  : audience.key === 'reviewers'
                    ? { href: `${base}/login`, label: shell.signIn }
                    : { href: `${base}/register`, label: shell.createAccount };
              const headingId = `lp-audience-${audience.key}`;
              return (
                <li key={audience.key} className="pc-lp-audience">
                  <article aria-labelledby={headingId}>
                    <span className="pc-lp-icon-tile" aria-hidden="true">
                      <Icon name={audience.icon} size={22} />
                    </span>
                    <h3 id={headingId}>{content.title}</h3>
                    <p className="pc-lp-audience-lead">{content.lead}</p>
                    <ul className="pc-lp-points">
                      {content.points.map((point) => (
                        <li key={point}>
                          <Icon name="check" size={16} />
                          {point}
                        </li>
                      ))}
                    </ul>
                    <Link className="pc-lp-text-link" href={action.href}>
                      {action.label}
                      <Icon name="arrow" size={16} />
                    </Link>
                  </article>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* --- Why PalCert ------------------------------------------------ */}
        <Section labelledBy="lp-value">
          <SectionHeading
            id="lp-value"
            eyebrow={t.value.eyebrow}
            title={t.value.title}
            lead={t.value.lead}
          />
          <ol className="pc-lp-pillars">
            {t.value.pillars.map((pillar, index) => (
              <li key={pillar.title} className="pc-lp-pillar">
                <span className="pc-lp-pillar-number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3>{pillar.title}</h3>
                <p>{pillar.text}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* --- Trust ------------------------------------------------------ */}
        <Section id="trust" tone="cream" labelledBy="lp-trust">
          <SectionHeading
            id="lp-trust"
            eyebrow={t.trust.eyebrow}
            title={t.trust.title}
            lead={t.trust.lead}
          />
          <div className="pc-lp-trust-grid">
            <ul className="pc-lp-assurance-grid">
              {t.trust.assurances.map((item, index) => (
                <li key={item.title} className="pc-lp-assurance">
                  <Icon name={TRUST_ICONS[index] ?? 'shield'} size={20} />
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </li>
              ))}
            </ul>
            <aside className="pc-lp-trust-aside" aria-labelledby="lp-verifier">
              <figure className="pc-lp-principle">
                <blockquote>
                  <p>{t.trust.principle}</p>
                </blockquote>
                <figcaption>{t.trust.principleLabel}</figcaption>
              </figure>
              <div className="pc-lp-verifier">
                <h3 id="lp-verifier">{t.trust.verifierTitle}</h3>
                <p>{t.trust.verifierLead}</p>
                <figure>
                  <VerificationPreview locale={locale} />
                  <figcaption className="pc-lp-caption">{t.product.sampleNote}</figcaption>
                </figure>
                <Link className="pc-lp-text-link" href={`${base}/verify`}>
                  {shell.verifyCertificate}
                  <Icon name="arrow" size={16} />
                </Link>
              </div>
            </aside>
          </div>
        </Section>

        {/* --- Product previews ------------------------------------------- */}
        <Section id="product" labelledBy="lp-product">
          <SectionHeading
            id="lp-product"
            eyebrow={t.product.eyebrow}
            title={t.product.title}
            lead={t.product.lead}
            align="center"
          />
          <div className="pc-lp-gallery">
            {(
              [
                ['dashboard', DashboardPreview],
                ['report', ReportPreview],
                ['documents', DocumentsPreview],
                ['review', ReviewQueuePreview],
              ] as const
            ).map(([key, Preview]) => (
              <figure key={key} className="pc-lp-shot">
                <Preview locale={locale} />
                <figcaption>
                  <strong>{t.product.frames[key].title}</strong>
                  <span>{t.product.frames[key].text}</span>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="pc-lp-caption pc-lp-caption-center">{t.product.sampleNote}</p>
        </Section>

        {/* --- FAQ -------------------------------------------------------- */}
        <Section id="faq" tone="cream" labelledBy="lp-faq">
          <div className="pc-lp-faq">
            <SectionHeading id="lp-faq" eyebrow={t.faq.eyebrow} title={t.faq.title} />
            <div className="pc-lp-faq-list">
              {t.faq.items.map((item) => (
                <details key={item.question} className="pc-lp-faq-item">
                  <summary>
                    <span>{item.question}</span>
                    <Icon name="chevron-down" size={18} />
                  </summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </Section>

        {/* --- Closing call to action ------------------------------------- */}
        <section className="pc-lp-cta" aria-labelledby="lp-cta">
          <div className="pc-lp-inner">
            <div className="pc-lp-cta-panel">
              <div>
                <h2 id="lp-cta">{t.cta.title}</h2>
                <p>{t.cta.lead}</p>
              </div>
              <div className="pc-lp-cta-actions">
                <div className="pc-lp-actions">
                  <Link className="pc-btn pc-lp-btn" href={`${base}/register`}>
                    {shell.createAccount}
                  </Link>
                  <Link className="pc-btn pc-btn-secondary pc-lp-btn" href={`${base}/verify`}>
                    {shell.verifyCertificate}
                  </Link>
                </div>
                <p className="pc-lp-signin">
                  {t.cta.signInPrompt} <Link href={`${base}/login`}>{shell.signIn}</Link>
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Wave />
      <LandingFooter locale={locale} />
    </>
  );
}

function LandingFooter({ locale }: { locale: Locale }) {
  const t = getLandingMessages(locale);
  const shell = getShellMessages(locale);
  const base = `/${locale}`;
  return (
    <footer className="pc-lp-footer">
      <div className="pc-lp-inner">
        <div className="pc-lp-footer-grid">
          <div className="pc-lp-footer-brand">
            <span className="pc-lp-footer-mark">
              <BrandMark size={28} />
              <span>{shell.brand}</span>
            </span>
            <p>{t.footer.summary}</p>
          </div>

          <nav aria-labelledby="lp-footer-platform">
            <h2 id="lp-footer-platform">{t.footer.platformHeading}</h2>
            <ul>
              {LANDING_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{t.nav[section.key]}</a>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-labelledby="lp-footer-account">
            <h2 id="lp-footer-account">{t.footer.accountHeading}</h2>
            <ul>
              <li>
                <Link href={`${base}/login`}>{shell.signIn}</Link>
              </li>
              <li>
                <Link href={`${base}/register`}>{shell.createAccount}</Link>
              </li>
              <li>
                <Link href={`${base}/forgot-password`}>{t.footer.resetPassword}</Link>
              </li>
            </ul>
          </nav>

          <nav aria-labelledby="lp-footer-verification">
            <h2 id="lp-footer-verification">{t.footer.verificationHeading}</h2>
            <ul>
              <li>
                <Link href={`${base}/verify`}>{shell.verifyCertificate}</Link>
              </li>
              <li>
                <Link href={`${base}/certificate-attestation`}>{t.footer.attestation}</Link>
              </li>
              <li>
                <a href="#faq">{t.footer.howCertificationWorks}</a>
              </li>
            </ul>
          </nav>

          <nav aria-labelledby="lp-footer-language">
            <h2 id="lp-footer-language">{t.footer.languageHeading}</h2>
            <ul>
              {LOCALES.map((candidate) => (
                <li key={candidate}>
                  <a
                    href={`/${candidate}`}
                    hrefLang={candidate}
                    lang={candidate}
                    aria-current={candidate === locale ? 'page' : undefined}
                  >
                    {LOCALE_LABELS[candidate]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="pc-lp-footer-base">
          <p>{t.footer.boundary}</p>
          <p>{t.footer.copyright}</p>
        </div>
      </div>
    </footer>
  );
}
