import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type CatalogueDocumentTypeView,
  type CatalogueOrganizationView,
  type CatalogueStandardView,
  type StandardFormatCompatibility,
} from '@palcert/contracts';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  CompatibilityQueryDto,
  DocumentTypeParamDto,
  OrganizationParamDto,
  StandardParamDto,
} from '../dto/checks.dto';
import { CatalogueService } from '../services/catalogue.service';
import { FormatCompatibilityService } from '../services/format-compatibility.service';

/**
 * The catalogue a person chooses a standard from (§16–§22).
 *
 * Read-only, and deliberately narrow. It lists only standards their owning
 * organization deliberately made PUBLIC_CHECKABLE: a draft, a private standard
 * or an unverified organization's standard is not merely hidden from the list,
 * it cannot be chosen, because listing and creation ask the same database
 * function the same question.
 *
 * What it never exposes is the standard's rules. "Which standards can I check
 * against" and "what exactly does this standard require" are different
 * questions with different answers, and this route answers only the first.
 */
@ApiTags('checks')
@ApiCookieAuth()
@Controller('catalogue')
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly compatibility: FormatCompatibilityService,
  ) {}

  @Get('standards/:standardId/compatibility')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'What this standard can be checked for, in this document’s format',
    description:
      'Free, and computed without opening the document: it compares the standard’s published ' +
      'rules with what the document’s detected format can answer at all. A rule listed as ' +
      'unsupported will come back INDETERMINATE rather than failing. ' +
      'A supported rule is not a promise of a verdict — a scanned PDF has no text to read, ' +
      'and that is only discoverable once the check runs. When nothing at all can be ' +
      'answered, creating the check is refused with CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT ' +
      'rather than charged for.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CHECK_STANDARD_NOT_AVAILABLE' })
  compatibility_(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: StandardParamDto,
    @Query() query: CompatibilityQueryDto,
  ): Promise<StandardFormatCompatibility> {
    return this.compatibility.previewForVersion(
      principal.userId,
      params.standardId,
      query.documentVersionId,
    );
  }

  @Get('organizations')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'Organizations that publish checkable standards',
    description:
      'Verified, active organizations with at least one publicly checkable standard. An ' +
      'organization with none does not appear.',
  })
  @ApiResponse({ status: 200 })
  organizations(): Promise<CatalogueOrganizationView[]> {
    return this.catalogue.organizations();
  }

  @Get('organizations/:organizationId/document-types')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({ summary: 'Document types an organization publishes standards for' })
  @ApiResponse({ status: 200 })
  documentTypes(@Param() params: OrganizationParamDto): Promise<CatalogueDocumentTypeView[]> {
    return this.catalogue.documentTypes(params.organizationId);
  }

  @Get('document-types/:documentTypeId/standards')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'Checkable standards for a document type',
    description:
      'Each entry names the exact published version a new check would bind to, and how many ' +
      'rules it carries. The rules themselves are not exposed.',
  })
  @ApiResponse({ status: 200 })
  standards(@Param() params: DocumentTypeParamDto): Promise<CatalogueStandardView[]> {
    return this.catalogue.standards(params.documentTypeId);
  }

  @Get('standards/:standardId')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'One checkable standard',
    description:
      'Refused with CHECK_STANDARD_NOT_AVAILABLE when the standard is private, inactive, has no ' +
      'published version, or belongs to an unverified organization — the same answer a ' +
      'nonexistent id gets, so the route cannot be used to probe for private standards.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CHECK_STANDARD_NOT_AVAILABLE' })
  async standard(@Param() params: StandardParamDto): Promise<CatalogueStandardView> {
    const standard = await this.catalogue.checkableStandard(params.standardId);
    return {
      id: standard.standardId,
      organizationId: standard.organizationId,
      organizationName: standard.organizationName,
      documentTypeId: standard.documentTypeId,
      documentTypeName: standard.documentTypeName,
      code: standard.code,
      nameEn: standard.nameEn,
      nameAr: standard.nameAr,
      descriptionEn: null,
      descriptionAr: null,
      standardVersionId: standard.standardVersionId,
      versionLabel: standard.versionLabel,
      ruleCount: standard.ruleCount,
      effectiveFrom: null,
    };
  }

  // Deliberately absent: any route returning a standard's rules. Phase 7 lets
  // a person check against a standard, not read someone else's rulebook (§22).
  //
  // Also absent: a "query the catalogue by name" route. The listing is small
  // and bounded; a free-text search over other organizations' catalogues is a
  // different feature with different privacy questions (§119).
}
