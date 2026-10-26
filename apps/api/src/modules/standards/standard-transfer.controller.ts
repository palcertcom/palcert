import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type StandardImportPreviewView,
  type StandardImportResultView,
} from '@palcert/contracts';
import type { Response } from 'express';
import { requestIdOf, type AuthenticatedRequest } from '../auth/authenticated-request';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../organizations/tenant-context';
import {
  ImportStandardDto,
  OrganizationScopedParamDto,
  PreviewStandardImportDto,
  StandardVersionParamDto,
} from './dto/standards.dto';
import { StandardTransferService } from './services/standard-transfer.service';

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

/**
 * Portable standard packages (`PALCERT_STANDARD`).
 *
 * Export is a read: anyone who may read a version may take its content away as
 * a file, whatever the version's status. Import creates a draft, so it needs
 * the permissions that creating a draft and its rules need; creating a whole
 * new standard additionally needs `standard:definition:create`, checked in the
 * service because it depends on the mode the caller chose.
 */
@ApiTags('standards')
@ApiCookieAuth()
@Controller('organizations/:organizationId/standards')
export class StandardTransferController {
  constructor(private readonly transfer: StandardTransferService) {}

  @Get(':standardId/versions/:versionId/export')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({
    summary: 'Export a version as a portable standard package',
    description:
      'A PALCERT_STANDARD JSON file another organization can import as a draft: the ' +
      'standard, its document category and every rule, with a SHA-256 content hash. No ' +
      'database identifier, user, check, certificate, source document or AI output is ' +
      'included. Available for drafts, published, superseded and archived versions alike. ' +
      'Not the published snapshot, which is the proof of what was published.',
  })
  @ApiResponse({ status: 200, description: 'application/json attachment (.palcert.json)' })
  @ApiResponse({ status: 409, description: 'STANDARD_VERSION_EMPTY — nothing to export' })
  async export(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.transfer.export(
      tenant,
      params.standardId,
      params.versionId,
      contextOf(request),
    );
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    // The name is built only from [A-Za-z0-9._-], so it needs no quoting rules.
    response.setHeader('content-disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('x-palcert-package-hash', file.packageHash);
    response.send(file.body);
  }

  @Post('import/preview')
  @OrganizationScoped()
  @RequireOrganizationPermissions(
    Permission.STANDARD_READ,
    Permission.STANDARD_VERSION_CREATE,
    Permission.STANDARD_RULE_WRITE,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a portable standard package',
    description:
      'Reads the package, verifies its integrity hash and format, validates every rule exactly ' +
      'as a hand-written rule is validated, and reports where it could go in this ' +
      'organization. Changes nothing. The returned packageHash is required to import.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 422,
    description:
      'STANDARD_IMPORT_PACKAGE_INVALID, STANDARD_IMPORT_INTEGRITY_FAILED or ' +
      'STANDARD_IMPORT_UNSUPPORTED — details.reason names the problem',
  })
  @ApiResponse({ status: 413, description: 'STANDARD_IMPORT_PACKAGE_TOO_LARGE' })
  async preview(
    @Param() _params: OrganizationScopedParamDto,
    @Body() dto: PreviewStandardImportDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardImportPreviewView> {
    return this.transfer.preview(tenant, dto.package);
  }

  @Post('import')
  @OrganizationScoped()
  @RequireOrganizationPermissions(
    Permission.STANDARD_READ,
    Permission.STANDARD_VERSION_CREATE,
    Permission.STANDARD_RULE_WRITE,
  )
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Import a previewed package as a new draft',
    description:
      'Creates, in one transaction, the standard (NEW_STANDARD) or nothing but a new version of ' +
      'an existing one (EXISTING_STANDARD), a DRAFT version with every rule, a provenance ' +
      'record and a STANDARD_IMPORTED audit event. Never publishes; never modifies an ' +
      'existing version. Refused if the package is not the one previewed, if any rule is ' +
      'invalid, or — unless acknowledgeDuplicate is set — if it was imported here before.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({
    status: 409,
    description:
      'STANDARD_IMPORT_PACKAGE_CHANGED, STANDARD_IMPORT_DUPLICATE, STANDARD_IMPORT_INCOMPATIBLE, ' +
      'STANDARD_CODE_TAKEN or STANDARD_VERSION_LABEL_TAKEN',
  })
  @ApiResponse({ status: 422, description: 'STANDARD_IMPORT_RULES_INVALID and the preview errors' })
  async import(
    @Param() _params: OrganizationScopedParamDto,
    @Body() dto: ImportStandardDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardImportResultView> {
    return this.transfer.import(
      tenant,
      {
        package: dto.package,
        packageHash: dto.packageHash,
        mode: dto.mode,
        standardId: dto.standardId,
        code: dto.code,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        documentTypeId: dto.documentTypeId,
        versionLabel: dto.versionLabel,
        acknowledgeDuplicate: dto.acknowledgeDuplicate,
      },
      contextOf(request),
    );
  }
}
