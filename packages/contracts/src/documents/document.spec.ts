import { describe, expect, it } from 'vitest';
import { PalCertErrorCode } from '../errors/error-codes.js';
import { defaultHttpStatusFor } from '../errors/app-error.js';
import {
  ACCEPTED_DECLARED_MIME_TYPES,
  CANONICAL_MIME_TYPES,
  DOCUMENT_FAILURE_CODES,
  DOCUMENT_REJECTION_CODES,
  DOCUMENT_VERSION_STATUSES,
  DOCUMENT_VERSION_TRANSITIONS,
  DocumentVersionStatus,
  PROCESSING_JOB_TRANSITIONS,
  type ProcessingJobStatus,
  SUPPORTED_UPLOAD_EXTENSIONS,
  TERMINAL_DOCUMENT_VERSION_STATUSES,
  UPLOAD_SESSION_TRANSITIONS,
  canTransitionDocumentVersion,
  canTransitionProcessingJob,
  canTransitionUploadSession,
  processingJobIdempotencyKey,
} from './document.js';

describe('document version lifecycle', () => {
  it('starts awaiting upload and can only be finalized, expire or be cancelled from there', () => {
    expect(DOCUMENT_VERSION_TRANSITIONS.AWAITING_UPLOAD).toEqual([
      'UPLOADED',
      'UPLOAD_EXPIRED',
      'CANCELLED',
    ]);
  });

  it('never lets a version become READY without passing through scanning', () => {
    for (const from of DOCUMENT_VERSION_STATUSES) {
      if (from === DocumentVersionStatus.SCANNING) continue;
      expect(canTransitionDocumentVersion(from, DocumentVersionStatus.READY), from).toBe(false);
    }
    expect(canTransitionDocumentVersion('SCANNING', 'READY')).toBe(true);
  });

  it('treats READY and REJECTED as final', () => {
    expect(DOCUMENT_VERSION_TRANSITIONS.READY).toEqual([]);
    expect(DOCUMENT_VERSION_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('lets a FAILED version be retried without a new upload', () => {
    // An infrastructure failure is PalCert's problem, not the author's.
    expect(canTransitionDocumentVersion('FAILED', 'UPLOADED')).toBe(true);
    expect(canTransitionDocumentVersion('REJECTED', 'UPLOADED')).toBe(false);
  });

  it('lets a processing stage be re-entered, so a retried worker is safe', () => {
    expect(canTransitionDocumentVersion('VALIDATING', 'VALIDATING')).toBe(true);
    expect(canTransitionDocumentVersion('SCANNING', 'SCANNING')).toBe(true);
    // But never backwards past a completed stage.
    expect(canTransitionDocumentVersion('SCANNING', 'VALIDATING')).toBe(true); // a retry restarts validation
  });

  it('lists every status in the transition table', () => {
    expect(Object.keys(DOCUMENT_VERSION_TRANSITIONS).sort()).toEqual(
      [...DOCUMENT_VERSION_STATUSES].sort(),
    );
    for (const targets of Object.values(DOCUMENT_VERSION_TRANSITIONS)) {
      for (const target of targets) expect(DOCUMENT_VERSION_STATUSES).toContain(target);
    }
  });

  it('gives terminal statuses no outgoing transitions', () => {
    for (const status of TERMINAL_DOCUMENT_VERSION_STATUSES) {
      expect(DOCUMENT_VERSION_TRANSITIONS[status]).toEqual([]);
    }
  });
});

describe('upload session lifecycle', () => {
  it('is finalized, expired or cancelled exactly once', () => {
    expect(UPLOAD_SESSION_TRANSITIONS.CREATED).toEqual(['FINALIZED', 'EXPIRED', 'CANCELLED']);
    expect(canTransitionUploadSession('FINALIZED', 'CREATED')).toBe(false);
    expect(canTransitionUploadSession('EXPIRED', 'FINALIZED')).toBe(false);
  });
});

describe('processing job lifecycle', () => {
  it('cannot succeed without running', () => {
    for (const from of Object.keys(PROCESSING_JOB_TRANSITIONS) as ProcessingJobStatus[]) {
      if (from === 'RUNNING') continue;
      expect(canTransitionProcessingJob(from, 'SUCCEEDED'), from).toBe(false);
    }
  });

  it('can return a lost dispatch to the outbox', () => {
    // Redis published nothing, or the worker died before picking it up.
    expect(canTransitionProcessingJob('DISPATCHED', 'PENDING')).toBe(true);
  });

  it('lets operations resurrect a dead job but never un-succeed one', () => {
    expect(canTransitionProcessingJob('DEAD', 'PENDING')).toBe(true);
    expect(PROCESSING_JOB_TRANSITIONS.SUCCEEDED).toEqual([]);
  });

  it('derives a deterministic identity for one unit of work', () => {
    const key = processingJobIdempotencyKey('DOCUMENT_INGEST', 'v-1');
    expect(key).toBe('DOCUMENT_INGEST:v-1');
    expect(processingJobIdempotencyKey('DOCUMENT_INGEST', 'v-1')).toBe(key);
    expect(processingJobIdempotencyKey('DOCUMENT_PURGE', 'v-1')).not.toBe(key);
  });
});

describe('supported formats', () => {
  it('accepts exactly DOCX and PDF by extension', () => {
    expect(Object.keys(SUPPORTED_UPLOAD_EXTENSIONS).sort()).toEqual(['.docx', '.pdf']);
  });

  it('does not accept look-alikes as if they were DOCX or PDF', () => {
    const lookAlikes = ['.doc', '.docm', '.dotx', '.rtf', '.odt', '.zip', '.html', '.exe'];
    for (const ext of lookAlikes) expect(SUPPORTED_UPLOAD_EXTENSIONS[ext], ext).toBeUndefined();
  });

  it('reports the canonical content type per format', () => {
    expect(CANONICAL_MIME_TYPES.PDF).toBe('application/pdf');
    expect(CANONICAL_MIME_TYPES.DOCX).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    for (const format of ['DOCX', 'PDF'] as const) {
      expect(ACCEPTED_DECLARED_MIME_TYPES[format]).toContain(CANONICAL_MIME_TYPES[format]);
    }
  });
});

describe('rejection and failure codes', () => {
  it('are all user-facing error codes with an HTTP status', () => {
    for (const code of DOCUMENT_REJECTION_CODES) {
      expect(PalCertErrorCode[code], code).toBe(code);
      expect(defaultHttpStatusFor(code), code).toBeGreaterThanOrEqual(400);
    }
  });

  it('never overlap: a code says either "your file" or "our problem"', () => {
    const rejection = new Set<string>(DOCUMENT_REJECTION_CODES);
    for (const code of DOCUMENT_FAILURE_CODES) expect(rejection.has(code), code).toBe(false);
  });

  it('classifies malware as a rejection, not a failure', () => {
    expect(DOCUMENT_REJECTION_CODES).toContain('FILE_MALWARE_DETECTED');
    expect(DOCUMENT_FAILURE_CODES).toContain('SCANNER_UNAVAILABLE');
  });
});
