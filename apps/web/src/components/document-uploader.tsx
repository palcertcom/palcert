'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentsMessages } from '@/i18n/documents-messages';
import { stageForStatus, type UploadStage } from '@/i18n/documents-messages';
import {
  ApiError,
  documentsApi,
  uploadToStorage,
  type DocumentVersionResponse,
} from '@/lib/api-client';

export interface DocumentUploaderProps {
  readonly documentId: string;
  readonly messages: DocumentsMessages;
  /** Called whenever the version changes state, so the page can refresh its list. */
  readonly onVersionChange: (version: DocumentVersionResponse) => void;
  /** Injectable for tests; defaults to the real API client. */
  readonly api?: Pick<typeof documentsApi, 'createVersion' | 'finalize' | 'cancel' | 'version'>;
  readonly upload?: typeof uploadToStorage;
  readonly pollIntervalMs?: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; fraction: number; versionId: string }
  | { kind: 'processing'; version: DocumentVersionResponse }
  | { kind: 'settled'; version: DocumentVersionResponse }
  | { kind: 'error'; code: string };

const STAGES: readonly UploadStage[] = ['UPLOADING', 'SECURITY_CHECK', 'PROCESSING', 'READY'];
const SETTLED = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED']);

async function sha256Of(file: Blob): Promise<string | undefined> {
  // Advisory only (§31): a mismatch is caught early, but PalCert computes the
  // authoritative digest itself. Skipped when the browser cannot hash.
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) return undefined;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    return undefined;
  }
}

/**
 * The upload control (§77, §78, §81).
 *
 * A real file input with a real label — keyboard-selectable and announced by
 * screen readers — an explicit Upload button, a progress element, and a
 * status region that reads out each stage as it changes. Drag-and-drop is
 * deliberately not the only path, nor any path, in this phase.
 */
export function DocumentUploader({
  documentId,
  messages,
  onVersionChange,
  api = documentsApi,
  upload = uploadToStorage,
  pollIntervalMs = 1500,
}: DocumentUploaderProps) {
  const inputId = useId();
  const statusId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const cancelledVersion = useRef<string | null>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);

  // Poll while PalCert processes, until the version settles.
  useEffect(() => {
    if (phase.kind !== 'processing') return;
    const version = phase.version;
    const timer = setTimeout(async () => {
      try {
        const latest = await api.version(documentId, version.id);
        onVersionChange(latest);
        setPhase(
          SETTLED.has(latest.status)
            ? { kind: 'settled', version: latest }
            : { kind: 'processing', version: latest },
        );
      } catch (caught) {
        setPhase({ kind: 'error', code: caught instanceof ApiError ? caught.code : 'UNKNOWN' });
      }
    }, pollIntervalMs);
    return () => clearTimeout(timer);
  }, [phase, api, documentId, onVersionChange, pollIntervalMs]);

  async function start(): Promise<void> {
    if (file === null) return;
    const controller = new AbortController();
    abort.current = controller;
    cancelledVersion.current = null;
    try {
      const created = await api.createVersion(
        documentId,
        {
          originalFilename: file.name,
          sizeBytes: file.size,
          ...(file.type ? { declaredMimeType: file.type } : {}),
          ...(await sha256Of(file).then((hash) => (hash ? { sha256: hash } : {}))),
        },
        crypto.randomUUID(),
      );
      onVersionChange(created.version);
      setPhase({ kind: 'uploading', fraction: 0, versionId: created.version.id });

      await upload(
        created.upload,
        file,
        (fraction) => {
          setPhase((current) =>
            current.kind === 'uploading' ? { ...current, fraction } : current,
          );
        },
        controller.signal,
      );

      const finalized = await api.finalize(documentId, created.version.id);
      onVersionChange(finalized);
      setPhase(
        SETTLED.has(finalized.status)
          ? { kind: 'settled', version: finalized }
          : { kind: 'processing', version: finalized },
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'UPLOAD_CANCELLED') {
        setPhase({ kind: 'error', code: 'UPLOAD_CANCELLED' });
      } else {
        setPhase({ kind: 'error', code: caught instanceof ApiError ? caught.code : 'UNKNOWN' });
      }
    } finally {
      abort.current = null;
      uploadButton.current?.focus();
    }
  }

  async function cancel(): Promise<void> {
    if (phase.kind !== 'uploading') return;
    cancelledVersion.current = phase.versionId;
    abort.current?.abort();
    try {
      const cancelled = await api.cancel(documentId, phase.versionId);
      onVersionChange(cancelled);
    } catch {
      // The version may already have been finalized; the list refresh shows the truth.
    }
  }

  const currentStage: UploadStage | null =
    phase.kind === 'uploading'
      ? 'UPLOADING'
      : phase.kind === 'processing' || phase.kind === 'settled'
        ? stageForStatus(phase.version.status)
        : null;

  const stageLabel: Record<UploadStage, string> = {
    UPLOADING: messages.stageUploading,
    SECURITY_CHECK: messages.stageSecurityCheck,
    PROCESSING: messages.stageProcessing,
    READY: messages.stageReady,
    REJECTED: messages.stageRejected,
    FAILED: messages.stageFailed,
  };

  const busy = phase.kind === 'uploading' || phase.kind === 'processing';

  let announcement = '';
  if (phase.kind === 'uploading')
    announcement = messages.uploadProgress(Math.round(phase.fraction * 100));
  else if (phase.kind === 'processing')
    announcement = `${messages.uploadComplete} ${messages.statuses[phase.version.status] ?? ''}`;
  else if (phase.kind === 'settled') {
    const version = phase.version;
    announcement =
      version.status === 'READY'
        ? messages.stageReady
        : version.status === 'REJECTED'
          ? (messages.rejections[version.rejectionCode ?? ''] ?? messages.stageRejected)
          : version.status === 'FAILED'
            ? messages.failedExplanation
            : (messages.statuses[version.status] ?? version.status);
  } else if (phase.kind === 'error') {
    announcement =
      phase.code === 'UPLOAD_CANCELLED'
        ? messages.uploadCancelled
        : (messages.errors[phase.code] ?? messages.genericError);
  }

  return (
    <section className="pc-card pc-uploader" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className="pc-card-title">
        {messages.uploadTitle}
      </h2>

      <div className="pc-field">
        <label htmlFor={inputId}>{messages.chooseFile}</label>
        <input
          id={inputId}
          type="file"
          accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={busy}
          aria-describedby={`${inputId}-hint`}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPhase({ kind: 'idle' });
          }}
        />
        <p id={`${inputId}-hint`} className="pc-hint">
          {messages.chooseFileHint}
        </p>
        <p className="pc-file-name">{file ? file.name : messages.noFileChosen}</p>
      </div>

      <div className="pc-actions">
        <button
          ref={uploadButton}
          type="button"
          onClick={() => void start()}
          disabled={file === null || busy}
        >
          {phase.kind === 'uploading' ? messages.uploading : messages.upload}
        </button>
        {phase.kind === 'uploading' && (
          <button type="button" onClick={() => void cancel()}>
            {messages.cancelUpload}
          </button>
        )}
      </div>

      {phase.kind === 'uploading' && (
        <progress value={phase.fraction} max={1} aria-describedby={statusId} />
      )}

      {currentStage !== null && (
        <ol className="pc-stages" aria-label={messages.stageProcessing}>
          {STAGES.map((stage) => {
            const reached =
              STAGES.indexOf(stage) <=
              STAGES.indexOf(
                currentStage === 'REJECTED' || currentStage === 'FAILED'
                  ? 'PROCESSING'
                  : currentStage,
              );
            const isCurrent = stage === currentStage;
            return (
              <li
                key={stage}
                aria-current={isCurrent ? 'step' : undefined}
                className={reached ? 'pc-stage-reached' : 'pc-stage-pending'}
              >
                {stageLabel[stage]}
              </li>
            );
          })}
          {(currentStage === 'REJECTED' || currentStage === 'FAILED') && (
            <li aria-current="step" className="pc-stage-terminal">
              {stageLabel[currentStage]}
            </li>
          )}
        </ol>
      )}

      <p id={statusId} role="status" aria-live="polite" className="pc-live-status">
        {announcement}
      </p>
    </section>
  );
}
