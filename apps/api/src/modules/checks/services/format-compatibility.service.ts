import { Injectable } from '@nestjs/common';
import {
  AppError,
  DocumentFormat,
  DocumentStatus,
  DocumentVersionStatus,
  PalCertErrorCode,
  compatibilityFor,
  type CompatibilityRuleInput,
  type StandardFormatCompatibility,
} from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { CatalogueService } from './catalogue.service';

/**
 * What a standard can be checked for against a document, before any money
 * moves (Phase 13 §63-§66).
 *
 * The preview is **static**. It reads the standard's published rules and the
 * property support registry, and it does not open the document — deliberately,
 * because opening the document is the work the user has not paid for. So it
 * answers "what can a PDF answer about this standard" rather than "what will
 * your PDF answer", and the UI must say so: a fully supported standard can
 * still come back INDETERMINATE on a scan (§64).
 *
 * It refuses nothing by itself. `assertCheckable` is what turns a zero-coverage
 * answer into a refusal, and it is called on the check-creation path so the
 * refusal happens before the reservation rather than after the report (§66).
 */
@Injectable()
export class FormatCompatibilityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: CatalogueService,
  ) {}

  /** The compatibility of one standard with one of the caller's versions. */
  async previewForVersion(
    userId: string,
    standardId: string,
    documentVersionId: string,
  ): Promise<StandardFormatCompatibility> {
    const format = await this.formatOf(userId, documentVersionId);
    const standard = await this.catalogue.checkableStandard(standardId);
    return this.compute(format, standard.standardVersionId);
  }

  /**
   * Refuse a check whose standard this format cannot answer at all.
   *
   * Partial coverage is sold: a standard where PalCert can answer eight rules
   * of twelve is a useful check, and the four it cannot answer come back
   * INDETERMINATE with a reason. Zero coverage is not: it would be a report
   * with no verdict in it, charged for at full price.
   */
  async assertCheckable(format: DocumentFormat, standardVersionId: string): Promise<void> {
    const compatibility = await this.compute(format, standardVersionId);
    if (compatibility.level !== 'NONE') return;
    throw new AppError(PalCertErrorCode.CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT, {
      message:
        'None of this standard’s rules can be answered from this document format. ' +
        'Upload the document in a supported format, or choose a different standard.',
      details: { format, totalRules: compatibility.totalRules },
    });
  }

  async compute(
    format: DocumentFormat,
    standardVersionId: string,
  ): Promise<StandardFormatCompatibility> {
    const snapshot = await this.catalogue.snapshotForVersion(standardVersionId);
    if (snapshot === null) {
      throw new AppError(PalCertErrorCode.CHECK_STANDARD_NOT_PUBLISHED, {
        message: 'That standard has no complete published version.',
        internalContext: { standardVersionId },
      });
    }
    const canonical = snapshot.canonical as { rules?: readonly CompatibilityRuleInput[] };
    return compatibilityFor(format, canonical.rules ?? []);
  }

  /**
   * The format of a version the caller owns.
   *
   * Row-level security already hides another user's version, so a stranger
   * gets the same 404 a nonexistent id gets — the preview must not become a
   * way to learn that a document id exists (ADR-0017).
   */
  private async formatOf(userId: string, documentVersionId: string): Promise<DocumentFormat> {
    const version = await this.tenant.withUser(userId, (tx) =>
      tx.documentVersion.findFirst({
        where: { id: documentVersionId, visibleToOwner: true },
        include: { document: true },
      }),
    );
    if (version === null || version.document.status === DocumentStatus.DELETED) {
      throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_FOUND, {
        message: 'No such document version.',
      });
    }
    if (version.status !== DocumentVersionStatus.READY) {
      throw new AppError(PalCertErrorCode.CHECK_DOCUMENT_NOT_READY, {
        message: 'This version is still being processed.',
      });
    }
    const format = version.detectedFormat as DocumentFormat | null;
    if (format !== DocumentFormat.DOCX && format !== DocumentFormat.PDF) {
      throw new AppError(PalCertErrorCode.CHECK_DOCUMENT_FORMAT_UNSUPPORTED, {
        message: 'PalCert can check Word documents and PDFs.',
        details: { format },
      });
    }
    return format;
  }
}
