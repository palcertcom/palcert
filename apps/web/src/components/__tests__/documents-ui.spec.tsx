import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentUploader } from '../document-uploader';
import { VersionList, formatBytes } from '../version-list';
import { getDocumentsMessages } from '@/i18n/documents-messages';
import type { DocumentVersionResponse, UploadAuthorizationResponse } from '@/lib/api-client';

const en = getDocumentsMessages('en');
const ar = getDocumentsMessages('ar');

function version(overrides: Partial<DocumentVersionResponse> = {}): DocumentVersionResponse {
  return {
    id: 'v-1',
    documentId: 'd-1',
    versionNumber: 1,
    status: 'READY',
    originalFilename: 'thesis.pdf',
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    detectedFormat: 'PDF',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    rejectionCode: null,
    failureCode: null,
    retryable: false,
    uploadExpiresAt: null,
    createdAt: '2026-06-01T12:00:00.000Z',
    uploadedAt: '2026-06-01T12:00:01.000Z',
    validatedAt: null,
    scannedAt: null,
    readyAt: '2026-06-01T12:00:05.000Z',
    rejectedAt: null,
    failedAt: null,
    ...overrides,
  };
}

const grant: UploadAuthorizationResponse = {
  method: 'PUT',
  url: 'https://storage.test/x',
  headers: {},
  expiresAt: '2026-06-01T12:10:00.000Z',
};

function fakeApi(sequence: DocumentVersionResponse[]) {
  let polls = 0;
  return {
    createVersion: vi
      .fn()
      .mockResolvedValue({ version: version({ status: 'AWAITING_UPLOAD' }), upload: grant }),
    finalize: vi.fn().mockResolvedValue(version({ status: 'UPLOADED' })),
    cancel: vi.fn().mockResolvedValue(version({ status: 'CANCELLED' })),
    version: vi
      .fn()
      .mockImplementation(async () => sequence[Math.min(polls++, sequence.length - 1)]!),
  };
}

describe('DocumentUploader — accessibility and stages (§78, §81)', () => {
  it('offers a labelled, keyboard-reachable file input and no upload until a file is chosen', () => {
    render(
      <DocumentUploader
        documentId="d-1"
        messages={en}
        onVersionChange={() => undefined}
        api={fakeApi([])}
        upload={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(en.chooseFile) as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toContain('.docx');
    expect(screen.getByRole('button', { name: en.upload })).toBeDisabled();
    expect(screen.getByText(en.noFileChosen)).toBeInTheDocument();
  });

  it('walks through uploading, security check and ready, announcing each stage', async () => {
    const api = fakeApi([version({ status: 'SCANNING' }), version({ status: 'READY' })]);
    const upload = vi.fn(async (_g, _f, onProgress: (f: number) => void) => {
      onProgress(0.5);
      onProgress(1);
    });
    const changes: string[] = [];
    render(
      <DocumentUploader
        documentId="d-1"
        messages={en}
        onVersionChange={(v) => changes.push(v.status)}
        api={api}
        upload={upload}
        pollIntervalMs={5}
      />,
    );

    const file = new File([new Uint8Array([37, 80, 68, 70])], 'thesis.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByLabelText(en.chooseFile), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: en.upload }));

    await waitFor(() => expect(api.createVersion).toHaveBeenCalled());
    expect(api.createVersion.mock.calls[0]![1]).toMatchObject({
      originalFilename: 'thesis.pdf',
      sizeBytes: 4,
    });
    // A fresh idempotency key accompanies every attempt (§74).
    expect(api.createVersion.mock.calls[0]![2]).toMatch(/^[0-9a-f-]{36}$/);

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en.stageReady));
    expect(changes).toEqual(['AWAITING_UPLOAD', 'UPLOADED', 'SCANNING', 'READY']);
    const steps = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([
      en.stageUploading,
      en.stageSecurityCheck,
      en.stageProcessing,
      en.stageReady,
    ]);
    expect(screen.getByText(en.stageReady, { selector: 'li' })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('explains a rejection in plain words, without internals', async () => {
    const api = fakeApi([version({ status: 'REJECTED', rejectionCode: 'FILE_MACRO_UNSUPPORTED' })]);
    render(
      <DocumentUploader
        documentId="d-1"
        messages={en}
        onVersionChange={() => undefined}
        api={api}
        upload={vi.fn().mockResolvedValue(undefined)}
        pollIntervalMs={5}
      />,
    );
    fireEvent.change(screen.getByLabelText(en.chooseFile), {
      target: { files: [new File(['x'], 'a.docx')] },
    });
    fireEvent.click(screen.getByRole('button', { name: en.upload }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(en.rejections['FILE_MACRO_UNSUPPORTED']),
    );
  });

  it('reports an infrastructure failure as PalCert’s, not the document’s', async () => {
    const api = fakeApi([
      version({ status: 'FAILED', failureCode: 'SCANNER_UNAVAILABLE', retryable: true }),
    ]);
    render(
      <DocumentUploader
        documentId="d-1"
        messages={en}
        onVersionChange={() => undefined}
        api={api}
        upload={vi.fn().mockResolvedValue(undefined)}
        pollIntervalMs={5}
      />,
    );
    fireEvent.change(screen.getByLabelText(en.chooseFile), {
      target: { files: [new File(['x'], 'a.pdf')] },
    });
    fireEvent.click(screen.getByRole('button', { name: en.upload }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en.failedExplanation));
    expect(screen.getByRole('status').textContent).not.toMatch(/invalid/i);
  });

  it('cancels an in-flight upload and tells the API so', async () => {
    let abortSignal: AbortSignal | undefined;
    const upload = vi.fn(
      (_g, _f, _p, signal?: AbortSignal) =>
        new Promise<void>((_, reject) => {
          abortSignal = signal;
          signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('cancelled'), { code: 'UPLOAD_CANCELLED', name: 'ApiError' }),
            ),
          );
        }),
    );
    const api = fakeApi([]);
    render(
      <DocumentUploader
        documentId="d-1"
        messages={en}
        onVersionChange={() => undefined}
        api={api}
        upload={upload}
      />,
    );
    fireEvent.change(screen.getByLabelText(en.chooseFile), {
      target: { files: [new File(['x'], 'a.pdf')] },
    });
    fireEvent.click(screen.getByRole('button', { name: en.upload }));

    const cancel = await screen.findByRole('button', { name: en.cancelUpload });
    fireEvent.click(cancel);
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('d-1', 'v-1'));
    expect(abortSignal?.aborted).toBe(true);
  });

  it('renders in Arabic', () => {
    render(
      <DocumentUploader
        documentId="d-1"
        messages={ar}
        onVersionChange={() => undefined}
        api={fakeApi([])}
        upload={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(ar.chooseFile)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ar.upload })).toBeInTheDocument();
  });
});

describe('VersionList (§79, §80)', () => {
  it('offers download only for a READY version', () => {
    const onDownload = vi.fn();
    render(
      <VersionList
        versions={[
          version(),
          version({ id: 'v-2', versionNumber: 2, status: 'SCANNING', sha256: null }),
        ]}
        messages={en}
        locale="en"
        onDownload={onDownload}
        onRetry={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: en.download });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1' }));
  });

  it('explains a rejection and offers no retry', () => {
    render(
      <VersionList
        versions={[
          version({ status: 'REJECTED', rejectionCode: 'FILE_TYPE_MISMATCH', sha256: null }),
        ]}
        messages={en}
        locale="en"
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('note').textContent).toBe(en.rejections['FILE_TYPE_MISMATCH']);
    expect(screen.queryByRole('button', { name: en.retryProcessing })).not.toBeInTheDocument();
  });

  it('offers a retry for a retryable failure and explains it is not the document', () => {
    const onRetry = vi.fn();
    render(
      <VersionList
        versions={[
          version({
            status: 'FAILED',
            failureCode: 'SCANNER_UNAVAILABLE',
            retryable: true,
            sha256: null,
          }),
        ]}
        messages={en}
        locale="en"
        onDownload={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain(en.failedNotInvalid);
    fireEvent.click(screen.getByRole('button', { name: en.retryProcessing }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the SHA-256 fingerprint of a ready version', () => {
    render(
      <VersionList
        versions={[version()]}
        messages={en}
        locale="en"
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('formats sizes for the locale', () => {
    expect(formatBytes(2048, 'en')).toBe('2 KB');
    expect(formatBytes(null, 'en')).toBe('—');
    expect(formatBytes(1536, 'ar')).toMatch(/KB$/);
  });
});
