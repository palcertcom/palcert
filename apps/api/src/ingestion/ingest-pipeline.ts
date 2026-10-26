import { stat } from 'node:fs/promises';
import {
  ATTESTATION_ARTIFACT_MIME_TYPES,
  CANONICAL_MIME_TYPES,
  type AttestationArtifactFormat,
  type DocumentFormat,
} from '@palcert/contracts';
import type { MalwareScannerPort } from '../infrastructure/scanner/malware-scanner.port';
import type {
  ObjectStoragePort,
  StoredObjectIdentity,
} from '../infrastructure/storage/object-storage.port';
import { validateDocxPackage } from './docx-validator';
import { ContentRejectedError, TransientIngestError } from './errors';
import { sha256ToFile } from './hashing';
import { validateArtifact } from './image-validator';
import { validatePdfStructure } from './pdf-validator';
import { describeUnsupportedSignature, detectSignature, readHeadAndTail } from './signature';
import { fileScanSubject, tempFilePath, withSecureTempDir } from './temp-files';
import type { ArchiveLimits } from './zip-safety';

export interface IngestLimits {
  readonly maxBytesByFormat: Readonly<Record<DocumentFormat, number>>;
  readonly archive: ArchiveLimits;
  readonly validationTimeoutMs: number;
  readonly scanTimeoutMs: number;
}

/**
 * Exactly what a worker loaded from the row it is ingesting.
 *
 * Deliberately says nothing about *what* is being ingested. Phase 5 brings a
 * user's document version and Phase 9 an organization's guideline, and the
 * security properties — signature detection, archive limits, malware scanning,
 * digest verification, immutable promotion — are identical for both. An
 * organization upload path with its own weaker copy of this logic is exactly
 * the outcome sharing the pipeline exists to prevent (§9 of Phase 9).
 *
 * Ownership and authorization live entirely above this line: the pipeline
 * touches no database and decides nothing about who may do what.
 */
export interface IngestInput {
  readonly expectedFormat: DocumentFormat;
  readonly quarantineObjectKey: string;
  readonly quarantineObjectVersionId: string | null;
  readonly quarantineObjectEtag: string | null;
  readonly declaredSizeBytes: number;
  readonly clientSha256: string | null;
  readonly cleanObjectKey: string;
}

export type IngestStage = 'VALIDATING' | 'SCANNING';

/**
 * Something accepted in a restricted way, worth telling the uploader. Not a
 * warning about the document's quality — a statement of what PalCert did.
 */
export const IngestNotice = {
  /** Legacy equation objects were accepted as data, never executed. */
  LEGACY_EQUATIONS_SAFE_MODE: 'LEGACY_EQUATIONS_SAFE_MODE',
} as const;
export type IngestNotice = (typeof IngestNotice)[keyof typeof IngestNotice];

export type IngestOutcome =
  | {
      readonly kind: 'ready';
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly detectedFormat: DocumentFormat;
      readonly detectedMimeType: string;
      readonly clean: StoredObjectIdentity;
      readonly scanEngine: string;
      readonly notices: readonly IngestNotice[];
      /** How many legacy equation objects the package carries (0 for a PDF). */
      readonly legacyEquationCount: number;
    }
  | {
      readonly kind: 'rejected';
      readonly code: ContentRejectedError['code'];
      readonly detail: string;
      readonly scanEngine?: string;
      readonly scanSignature?: string;
    };

/**
 * A submitted certificate for attestation: PDF or image, never an office
 * document. The ceiling comes from the attestation type, never from the
 * browser, and is at most the PDF ceiling every other upload already has.
 */
export interface ArtifactIngestInput {
  readonly expectedFormat: AttestationArtifactFormat;
  readonly allowedFormats: readonly AttestationArtifactFormat[];
  readonly maxBytes: number;
  readonly quarantineObjectKey: string;
  readonly quarantineObjectVersionId: string | null;
  readonly quarantineObjectEtag: string | null;
  readonly clientSha256: string | null;
  readonly cleanObjectKey: string;
}

export type ArtifactIngestOutcome =
  | {
      readonly kind: 'ready';
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly detectedFormat: AttestationArtifactFormat;
      readonly detectedMimeType: string;
      readonly clean: StoredObjectIdentity;
      readonly scanEngine: string;
    }
  | {
      readonly kind: 'rejected';
      readonly code: ContentRejectedError['code'];
      readonly detail: string;
      readonly scanEngine?: string;
      readonly scanSignature?: string;
    };

/**
 * Upload -> validate -> hash -> scan -> promote (§29, §61).
 *
 * Pure orchestration over the two ports. The worker owns the database: it
 * calls `onStage` before each stage so the version's status tracks progress,
 * and it persists the outcome. Every step is idempotent, so a retried job
 * simply runs the pipeline again from the top; the only side effect is the
 * clean copy, and `copyImmutable` refuses to overwrite one that exists.
 *
 * A `ContentRejectedError` is an *outcome*, returned; anything else is thrown
 * for the worker to classify as transient.
 */
export class IngestPipeline {
  constructor(
    private readonly storage: ObjectStoragePort,
    private readonly scanner: MalwareScannerPort,
    private readonly limits: IngestLimits,
  ) {}

  async run(
    input: IngestInput,
    onStage: (stage: IngestStage) => Promise<void>,
  ): Promise<IngestOutcome> {
    try {
      return await this.execute(input, onStage);
    } catch (error) {
      if (error instanceof ContentRejectedError) {
        return {
          kind: 'rejected',
          code: error.code,
          detail: error.detail,
          ...(error.extra.scanEngine !== undefined ? { scanEngine: error.extra.scanEngine } : {}),
          ...(error.extra.scanSignature !== undefined
            ? { scanSignature: error.extra.scanSignature }
            : {}),
        };
      }
      throw error;
    }
  }

  private async execute(
    input: IngestInput,
    onStage: (stage: IngestStage) => Promise<void>,
  ): Promise<IngestOutcome> {
    const source = {
      zone: 'quarantine' as const,
      key: input.quarantineObjectKey,
      versionId: input.quarantineObjectVersionId,
    };

    // The exact finalized object, and only that (§26). If it has changed or
    // vanished, that is PalCert's problem to sort out, never the author's.
    const staged = await this.storage.headObject(source);
    if (staged === null) {
      throw new TransientIngestError(
        'QUARANTINE_OBJECT_MISSING',
        'finalized quarantine object not found',
      );
    }
    if (
      input.quarantineObjectEtag !== null &&
      staged.etag !== null &&
      unquoted(staged.etag) !== unquoted(input.quarantineObjectEtag)
    ) {
      throw new TransientIngestError(
        'QUARANTINE_OBJECT_CHANGED',
        'quarantine object etag differs from finalize',
      );
    }

    await onStage('VALIDATING');
    const maxBytes = this.limits.maxBytesByFormat[input.expectedFormat]!;

    return withSecureTempDir(async (directory) => {
      const path = tempFilePath(directory);
      const { stream } = await this.storage.getObjectStream(source);
      const digest = await withTimeout(
        sha256ToFile(stream, path, { maxBytes }),
        this.limits.validationTimeoutMs,
        'validation',
      );

      if (digest.sizeBytes === 0) throw new ContentRejectedError('FILE_EMPTY', 'zero bytes');
      if (digest.sizeBytes !== staged.sizeBytes || (await stat(path)).size !== digest.sizeBytes) {
        throw new TransientIngestError(
          'QUARANTINE_OBJECT_CHANGED',
          'streamed size differs from object size',
        );
      }
      if (input.clientSha256 !== null && input.clientSha256 !== digest.sha256) {
        throw new ContentRejectedError(
          'FILE_CHECKSUM_MISMATCH',
          'client digest does not match content',
        );
      }

      const { format: detectedFormat, legacyEquationCount } = await withTimeout(
        this.detectAndValidate(path, digest.sizeBytes, input.expectedFormat),
        this.limits.validationTimeoutMs,
        'validation',
      );

      await onStage('SCANNING');
      const scan = await this.scanner.scan(fileScanSubject(path, digest.sizeBytes), {
        timeoutMs: this.limits.scanTimeoutMs,
      });
      if (scan.verdict.result === 'ERROR') {
        throw new TransientIngestError('SCANNER_UNAVAILABLE', scan.verdict.reason);
      }
      if (scan.verdict.result === 'INFECTED') {
        throw new ContentRejectedError('FILE_MALWARE_DETECTED', 'scanner verdict', {
          scanEngine: scan.engine,
          scanSignature: scan.verdict.signature,
        });
      }

      const detectedMimeType = CANONICAL_MIME_TYPES[detectedFormat];
      const clean = await this.storage.copyImmutable({
        source,
        destination: { zone: 'clean', key: input.cleanObjectKey },
        contentType: detectedMimeType,
      });
      if (clean.sizeBytes !== digest.sizeBytes) {
        throw new TransientIngestError(
          'STORAGE_UNAVAILABLE',
          'promoted object size differs from source',
        );
      }

      return {
        kind: 'ready',
        sha256: digest.sha256,
        sizeBytes: digest.sizeBytes,
        detectedFormat,
        detectedMimeType,
        clean,
        scanEngine: scan.engine,
        notices: legacyEquationCount > 0 ? [IngestNotice.LEGACY_EQUATIONS_SAFE_MODE] : [],
        legacyEquationCount,
      };
    });
  }

  /**
   * The same pipeline for a certificate submitted for attestation.
   *
   * Identical stages — exact object, streamed digest under a hard ceiling,
   * signature detection, structural validation, malware scan, immutable
   * promotion — with the image-aware validator in place of the DOCX one.
   * Kept as a sibling of `run` rather than a flag on it, so the document
   * path cannot start accepting images by accident.
   */
  async runArtifact(
    input: ArtifactIngestInput,
    onStage: (stage: IngestStage) => Promise<void>,
  ): Promise<ArtifactIngestOutcome> {
    try {
      return await this.executeArtifact(input, onStage);
    } catch (error) {
      if (error instanceof ContentRejectedError) {
        return {
          kind: 'rejected',
          code: error.code,
          detail: error.detail,
          ...(error.extra.scanEngine !== undefined ? { scanEngine: error.extra.scanEngine } : {}),
          ...(error.extra.scanSignature !== undefined
            ? { scanSignature: error.extra.scanSignature }
            : {}),
        };
      }
      throw error;
    }
  }

  private async executeArtifact(
    input: ArtifactIngestInput,
    onStage: (stage: IngestStage) => Promise<void>,
  ): Promise<ArtifactIngestOutcome> {
    const source = {
      zone: 'quarantine' as const,
      key: input.quarantineObjectKey,
      versionId: input.quarantineObjectVersionId,
    };

    const staged = await this.storage.headObject(source);
    if (staged === null) {
      throw new TransientIngestError(
        'QUARANTINE_OBJECT_MISSING',
        'finalized quarantine object not found',
      );
    }
    if (
      input.quarantineObjectEtag !== null &&
      staged.etag !== null &&
      unquoted(staged.etag) !== unquoted(input.quarantineObjectEtag)
    ) {
      throw new TransientIngestError(
        'QUARANTINE_OBJECT_CHANGED',
        'quarantine object etag differs from finalize',
      );
    }

    await onStage('VALIDATING');

    return withSecureTempDir(async (directory) => {
      const path = tempFilePath(directory);
      const { stream } = await this.storage.getObjectStream(source);
      const digest = await withTimeout(
        sha256ToFile(stream, path, { maxBytes: input.maxBytes }),
        this.limits.validationTimeoutMs,
        'validation',
      );

      if (digest.sizeBytes === 0) throw new ContentRejectedError('FILE_EMPTY', 'zero bytes');
      if (digest.sizeBytes !== staged.sizeBytes || (await stat(path)).size !== digest.sizeBytes) {
        throw new TransientIngestError(
          'QUARANTINE_OBJECT_CHANGED',
          'streamed size differs from object size',
        );
      }
      if (input.clientSha256 !== null && input.clientSha256 !== digest.sha256) {
        throw new ContentRejectedError(
          'FILE_CHECKSUM_MISMATCH',
          'client digest does not match content',
        );
      }

      const { head, tail } = await readHeadAndTail(path, digest.sizeBytes);
      const detectedFormat = validateArtifact({
        head,
        tail,
        sizeBytes: digest.sizeBytes,
        expectedFormat: input.expectedFormat,
        allowedFormats: input.allowedFormats,
      });

      await onStage('SCANNING');
      const scan = await this.scanner.scan(fileScanSubject(path, digest.sizeBytes), {
        timeoutMs: this.limits.scanTimeoutMs,
      });
      if (scan.verdict.result === 'ERROR') {
        throw new TransientIngestError('SCANNER_UNAVAILABLE', scan.verdict.reason);
      }
      if (scan.verdict.result === 'INFECTED') {
        throw new ContentRejectedError('FILE_MALWARE_DETECTED', 'scanner verdict', {
          scanEngine: scan.engine,
          scanSignature: scan.verdict.signature,
        });
      }

      const detectedMimeType = ATTESTATION_ARTIFACT_MIME_TYPES[detectedFormat];
      const clean = await this.storage.copyImmutable({
        source,
        destination: { zone: 'clean', key: input.cleanObjectKey },
        contentType: detectedMimeType,
      });
      if (clean.sizeBytes !== digest.sizeBytes) {
        throw new TransientIngestError(
          'STORAGE_UNAVAILABLE',
          'promoted object size differs from source',
        );
      }

      return {
        kind: 'ready',
        sha256: digest.sha256,
        sizeBytes: digest.sizeBytes,
        detectedFormat,
        detectedMimeType,
        clean,
        scanEngine: scan.engine,
      };
    });
  }

  private async detectAndValidate(
    path: string,
    sizeBytes: number,
    expectedFormat: DocumentFormat,
  ): Promise<{ format: DocumentFormat; legacyEquationCount: number }> {
    const { head, tail } = await readHeadAndTail(path, sizeBytes);
    const signature = detectSignature(head);

    if (signature === 'UNKNOWN') {
      throw new ContentRejectedError('FILE_TYPE_UNSUPPORTED', describeUnsupportedSignature(head));
    }
    const candidate: DocumentFormat = signature === 'PDF' ? 'PDF' : 'DOCX';
    if (candidate !== expectedFormat) {
      throw new ContentRejectedError(
        'FILE_TYPE_MISMATCH',
        `content looks like ${signature}, extension says ${expectedFormat}`,
      );
    }

    if (candidate === 'PDF') {
      validatePdfStructure(head, tail);
      return { format: 'PDF', legacyEquationCount: 0 };
    }
    const inspection = await validateDocxPackage(path, this.limits.archive);
    return { format: 'DOCX', legacyEquationCount: inspection.legacyEquations.length };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TransientIngestError('PROCESSING_TIMEOUT', `${what} exceeded ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An ETag without its quotes.
 *
 * S3 returns `"abc"` from HEAD and `abc` from a PUT's response, and the two
 * are the same ETag. Comparing them literally means a server-generated object
 * never matches itself — which Phase 12 is the first thing to notice, because
 * it is the first to hand a PUT's ETag back to this pipeline.
 */
function unquoted(etag: string): string {
  return etag.replaceAll('"', '');
}
