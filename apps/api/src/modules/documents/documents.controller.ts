import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type CreateDocumentVersionResponse,
  type DocumentVersionView,
  type DocumentView,
  type DownloadAuthorizationView,
  type Page,
  type UploadAuthorizationView,
} from '@palcert/contracts';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import {
  CreateDocumentDto,
  CreateDocumentVersionDto,
  CreateDocumentVersionResponseDto,
  DocumentCollectionQueryDto,
  DocumentDto,
  DocumentPageDto,
  DocumentParamDto,
  DocumentVersionDto,
  DocumentVersionPageDto,
  DocumentVersionParamDto,
  DownloadAuthorizationDto,
  UpdateDocumentDto,
  UploadAuthorizationDto,
} from './dto/documents.dto';
import { DocumentService } from './services/document.service';
import { DocumentVersionService } from './services/document-version.service';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const IDEMPOTENCY_DOC = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional client-chosen key (at most 128 characters). Repeating the request with the same ' +
    'key returns the same version instead of creating another; the same key with a different ' +
    'body is refused with IDEMPOTENCY_KEY_REUSED.',
};

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

function idempotencyKeyOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const key = header.trim();
  if (key.length === 0) return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'Idempotency-Key must be 1 to 128 printable ASCII characters.',
      details: { field: 'Idempotency-Key' },
    });
  }
  return key;
}

/**
 * A person's private documents (ADR-0031).
 *
 * No organization appears in these routes: ownership, established by the
 * session and enforced by row-level security, is the only authorization.
 * Anyone else's document id is not found, never forbidden — the difference
 * would confirm the id exists.
 */
@ApiTags('documents')
@ApiCookieAuth()
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentService,
    private readonly versions: DocumentVersionService,
  ) {}

  @Get()
  @RequirePermissions(Permission.DOCUMENT_READ_SELF)
  @ApiOperation({
    summary: 'List your documents',
    description: "Newest activity first, with each document's latest version. Cursor-paginated.",
  })
  @ApiResponse({ status: 200, type: DocumentPageDto })
  list(
    @Query() query: DocumentCollectionQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<Page<DocumentView>> {
    return this.documents.list(principal.userId, query);
  }

  @Post()
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a document',
    description: 'A logical document with no content yet. Upload a version to add a file.',
  })
  @ApiResponse({ status: 201, type: DocumentDto })
  create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentView> {
    return this.documents.create(principal.userId, dto.displayName, contextOf(request));
  }

  @Get(':documentId')
  @RequirePermissions(Permission.DOCUMENT_READ_SELF)
  @ApiOperation({ summary: 'Read a document' })
  @ApiResponse({ status: 200, type: DocumentDto })
  @ApiResponse({ status: 404, description: 'DOCUMENT_NOT_FOUND' })
  get(
    @Param() params: DocumentParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DocumentView> {
    return this.documents.get(principal.userId, params.documentId);
  }

  @Patch(':documentId')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @ApiOperation({ summary: 'Rename a document' })
  @ApiResponse({ status: 200, type: DocumentDto })
  update(
    @Param() params: DocumentParamDto,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentView> {
    return this.documents.update(principal.userId, params.documentId, dto, contextOf(request));
  }

  @Delete(':documentId')
  @RequirePermissions(Permission.DOCUMENT_DELETE_SELF)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a document',
    description:
      'Hidden immediately; the stored files are removed asynchronously unless a retention lock references a version.',
  })
  @ApiResponse({ status: 204 })
  async remove(
    @Param() params: DocumentParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.documents.remove(principal.userId, params.documentId, contextOf(request));
  }

  // --- Versions --------------------------------------------------------------

  @Get(':documentId/versions')
  @RequirePermissions(Permission.DOCUMENT_READ_SELF)
  @ApiOperation({
    summary: "List a document's versions",
    description: 'Newest version first. Cursor-paginated.',
  })
  @ApiResponse({ status: 200, type: DocumentVersionPageDto })
  listVersions(
    @Param() params: DocumentParamDto,
    @Query() query: DocumentCollectionQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<Page<DocumentVersionView>> {
    return this.versions.list(principal.userId, params.documentId, query);
  }

  @Post(':documentId/versions')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader(IDEMPOTENCY_DOC)
  @ApiOperation({
    summary: 'Create the next version and authorize its upload',
    description:
      'Allocates the next version number, creates an upload session and returns a short-lived ' +
      'authorization to PUT the file straight into quarantine storage. The browser must then ' +
      'call finalize. Only .docx and .pdf are accepted; the content is verified after upload.',
  })
  @ApiResponse({ status: 201, type: CreateDocumentVersionResponseDto })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'FILE_EXTENSION_UNSUPPORTED' })
  createVersion(
    @Param() params: DocumentParamDto,
    @Body() dto: CreateDocumentVersionDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreateDocumentVersionResponse> {
    return this.versions.create(
      principal.userId,
      params.documentId,
      { ...dto, idempotencyKey: idempotencyKeyOf(idempotencyKey) },
      contextOf(request),
    );
  }

  @Get(':documentId/versions/:versionId')
  @RequirePermissions(Permission.DOCUMENT_READ_SELF)
  @ApiOperation({ summary: 'Read a version', description: 'Poll this for processing status.' })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  getVersion(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DocumentVersionView> {
    return this.versions.get(principal.userId, params.documentId, params.versionId);
  }

  @Post(':documentId/versions/:versionId/upload-authorizations')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Re-issue an upload authorization',
    description:
      'For a version still awaiting its upload whose previous authorization lapsed. The same staged key is used.',
  })
  @ApiResponse({ status: 201, type: UploadAuthorizationDto })
  @ApiResponse({ status: 409, description: 'UPLOAD_ALREADY_FINALIZED' })
  @ApiResponse({ status: 410, description: 'UPLOAD_SESSION_EXPIRED' })
  reissue(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<UploadAuthorizationView> {
    return this.versions.reissueUploadAuthorization(
      principal.userId,
      params.documentId,
      params.versionId,
    );
  }

  @Post(':documentId/versions/:versionId/finalize')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finalize an upload',
    description:
      'Verifies the exact uploaded object and queues security processing. Idempotent: calling ' +
      'it again returns the current state without creating anything.',
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  @ApiResponse({ status: 409, description: 'UPLOAD_OBJECT_NOT_FOUND' })
  @ApiResponse({ status: 410, description: 'UPLOAD_SESSION_EXPIRED' })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 422, description: 'UPLOAD_SIZE_MISMATCH' })
  finalize(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentVersionView> {
    return this.versions.finalize(
      principal.userId,
      params.documentId,
      params.versionId,
      contextOf(request),
    );
  }

  @Post(':documentId/versions/:versionId/cancel')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an upload that has not been finalized' })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  cancel(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentVersionView> {
    return this.versions.cancel(
      principal.userId,
      params.documentId,
      params.versionId,
      contextOf(request),
    );
  }

  @Post(':documentId/versions/:versionId/retry')
  @RequirePermissions(Permission.DOCUMENT_WRITE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry processing after an infrastructure failure',
    description:
      'Only a FAILED version whose upload is still held can be retried; a REJECTED one cannot.',
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  @ApiResponse({ status: 409, description: 'DOCUMENT_VERSION_NOT_RETRYABLE' })
  retry(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentVersionView> {
    return this.versions.retry(
      principal.userId,
      params.documentId,
      params.versionId,
      contextOf(request),
    );
  }

  @Post(':documentId/versions/:versionId/download-authorization')
  @RequirePermissions(Permission.DOCUMENT_DOWNLOAD_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Authorize a download of a READY version',
    description:
      'Returns a short-lived signed URL for the exact clean object, served as an attachment.',
  })
  @ApiResponse({ status: 201, type: DownloadAuthorizationDto })
  @ApiResponse({ status: 409, description: 'DOCUMENT_NOT_READY' })
  download(
    @Param() params: DocumentVersionParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DownloadAuthorizationView> {
    return this.versions.createDownloadAuthorization(
      principal.userId,
      params.documentId,
      params.versionId,
      contextOf(request),
    );
  }
}
