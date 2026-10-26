import type { CertificateClaim } from '@palcert/contracts';

/**
 * Turning an immutable claim into something a person can hold (§43).
 *
 * A port, because the certificate domain should not know how a PDF is made.
 * It should know that rendering is deterministic, that it happens from local
 * assets, and that the result is bytes with a digest — and nothing else.
 */

/**
 * Every label the renderer prints.
 *
 * A concrete shape rather than a string map, so adding a field to the
 * certificate is a compile error in the catalogue that has to supply it,
 * rather than a blank space on a printed artifact.
 */
export interface CertificateFieldLabels {
  readonly technicalResult: string;
  readonly institutionDecision: string;
  readonly organization: string;
  readonly documentType: string;
  readonly documentFormat: string;
  readonly standard: string;
  readonly standardVersion: string;
  readonly issued: string;
  readonly validity: string;
  readonly documentHash: string;
  readonly reportHash: string;
  readonly standardHash: string;
  readonly evidenceHash: string;
  readonly claimHash: string;
  readonly verify: string;
}

/** Localized text the renderer prints. Supplied, never looked up. */
export interface CertificateLabels {
  readonly title: string;
  readonly titleAr: string;
  readonly statement: string;
  readonly statementAr: string;
  readonly disclaimer: string;
  readonly disclaimerAr: string;
  readonly fields: CertificateFieldLabels;
}

export interface RenderedCertificate {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly rendererName: string;
  readonly rendererVersion: string;
  readonly templateVersion: string;
}

export abstract class CertificateRendererPort {
  /**
   * Render one certificate.
   *
   * Given the same claim, the same template version, the same renderer version
   * and the same assets, this must produce the same bytes — so the artifact
   * hash a verifier is shown means something (§48).
   */
  abstract render(params: {
    readonly claim: CertificateClaim;
    readonly verificationUrl: string;
    readonly labels: CertificateLabels;
  }): Promise<RenderedCertificate>;

  abstract get rendererName(): string;
  abstract get rendererVersion(): string;
  abstract get templateVersion(): string;
}
