import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  describeRuleSchema,
  type DocumentTypeView,
  type Page,
  type RuleSchemaDescriptor,
  type RuleView,
  type StandardVersionUsageView,
  type StandardVersionValidationView,
  type StandardVersionView,
  type StandardView,
} from '@palcert/contracts';
import type { Response } from 'express';
import { requestIdOf, type AuthenticatedRequest } from '../auth/authenticated-request';
import { RequirePermissions } from '../auth/decorators/auth.decorators';
import { UpdateStandardAvailabilityDto } from '../checks/dto/checks.dto';
import { Permission as GlobalPermission } from '@palcert/contracts';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../organizations/tenant-context';
import { IF_MATCH_HEADER, parseIfMatch, revisionToETag } from './concurrency';
import {
  CloneStandardVersionDto,
  PublishStandardVersionDto,
  CollectionQueryDto,
  CreateDocumentTypeDto,
  CreateStandardDto,
  CreateStandardVersionDto,
  DocumentTypeParamDto,
  DocumentTypeQueryDto,
  OrganizationScopedParamDto,
  ReorderRulesDto,
  RuleBodyDto,
  RuleParamDto,
  RuleQueryDto,
  StandardParamDto,
  StandardQueryDto,
  StandardVersionParamDto,
  StandardVersionQueryDto,
  UpdateDocumentTypeDto,
  UpdateStandardDto,
  UpdateStandardVersionDto,
} from './dto/standards.dto';
import {
  DocumentTypeDto,
  DocumentTypePageDto,
  RuleDto,
  RulePageDto,
  RuleSchemaDto,
  StandardDto,
  StandardPageDto,
  StandardVersionDto,
  StandardVersionPageDto,
  StandardVersionSnapshotDto,
  StandardVersionUsageDto,
  StandardVersionValidationDto,
} from './dto/standards-response.dto';
import { DocumentTypeService } from './services/document-type.service';
import { RuleService } from './services/rule.service';
import { StandardService } from './services/standard.service';
import { StandardVersionService } from './services/standard-version.service';

const IF_MATCH_DOC = {
  name: 'If-Match',
  required: true,
  description:
    'The version revision you are editing, as returned in the ETag of a version read — for ' +
    'example `"3"`. Required on every draft mutation: without it the request would be ' +
    'last-write-wins and could silently discard someone else’s edit.',
};

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

/**
 * The rule schema catalogue.
 *
 * Organization-agnostic platform reference data: it describes what a rule may
 * be, not what any tenant has written. The rule builder reads it to drive its
 * dropdowns and conditional fields, so the form can only ever offer
 * combinations the API accepts.
 */
@ApiTags('standards')
@ApiCookieAuth()
@Controller('standards')
export class RuleSchemaController {
  @Get('rule-schema')
  @RequirePermissions(GlobalPermission.PROFILE_READ_SELF)
  @ApiOperation({
    summary: 'Describe the rule schema',
    description:
      'Categories, operators, value types, units and the operator/value compatibility matrix. ' +
      'Reference data about the platform; carries no tenant information.',
  })
  @ApiResponse({ status: 200, type: RuleSchemaDto })
  describe(): RuleSchemaDescriptor {
    return describeRuleSchema();
  }
}

@ApiTags('standards')
@ApiCookieAuth()
@Controller('organizations/:organizationId/document-types')
export class DocumentTypesController {
  constructor(private readonly documentTypes: DocumentTypeService) {}

  @Get()
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_READ)
  @ApiOperation({ summary: 'List document types' })
  @ApiResponse({ status: 200, type: DocumentTypePageDto })
  async list(
    // The organization-only param shape: this route has no :documentTypeId, and
    // validating against the richer DTO would reject every request.
    @Param() _params: OrganizationScopedParamDto,
    @Query() query: DocumentTypeQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<DocumentTypeView>> {
    return this.documentTypes.list(tenant, query);
  }

  @Post()
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a document type',
    description:
      'The system category is a closed PalCert vocabulary; the name is whatever the ' +
      'organization calls it. Names are unique per organization, case-insensitively.',
  })
  @ApiResponse({ status: 201, type: DocumentTypeDto })
  @ApiResponse({ status: 409, description: 'DOCUMENT_TYPE_NAME_TAKEN' })
  async create(
    @Body() dto: CreateDocumentTypeDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.create(tenant, dto, contextOf(request));
  }

  @Get(':documentTypeId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_READ)
  @ApiOperation({ summary: 'Read a document type' })
  @ApiResponse({ status: 200, type: DocumentTypeDto })
  @ApiResponse({ status: 404, description: 'DOCUMENT_TYPE_NOT_FOUND' })
  async read(
    @Param() params: DocumentTypeParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.get(tenant, params.documentTypeId);
  }

  @Patch(':documentTypeId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_MANAGE)
  @ApiOperation({ summary: 'Update a document type' })
  @ApiResponse({ status: 200, type: DocumentTypeDto })
  async update(
    @Param() params: DocumentTypeParamDto,
    @Body() dto: UpdateDocumentTypeDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.update(tenant, params.documentTypeId, dto, contextOf(request));
  }

  @Post(':documentTypeId/archive')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_MANAGE)
  @ApiOperation({
    summary: 'Archive a document type',
    description:
      'Refused while active standards still reference it — cascading would orphan them, and ' +
      'allowing it would leave a picker offering a type whose standards are unreachable.',
  })
  @ApiResponse({ status: 200, type: DocumentTypeDto })
  @ApiResponse({ status: 409, description: 'DOCUMENT_TYPE_IN_USE' })
  async archive(
    @Param() params: DocumentTypeParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.archive(tenant, params.documentTypeId, contextOf(request));
  }

  @Post(':documentTypeId/restore')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_DOCUMENT_TYPE_MANAGE)
  @ApiOperation({ summary: 'Restore an archived document type' })
  @ApiResponse({ status: 200, type: DocumentTypeDto })
  async restore(
    @Param() params: DocumentTypeParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentTypeView> {
    return this.documentTypes.restore(tenant, params.documentTypeId, contextOf(request));
  }
}

@ApiTags('standards')
@ApiCookieAuth()
@Controller('organizations/:organizationId/standards')
export class StandardsController {
  constructor(
    private readonly standards: StandardService,
    private readonly versions: StandardVersionService,
    private readonly rules: RuleService,
  ) {}

  // --- standards -----------------------------------------------------------

  @Get()
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({
    summary: 'List standards',
    description:
      'Search filters within the caller’s organization only. Row-level security makes this ' +
      'structurally incapable of returning another tenant’s standard.',
  })
  @ApiResponse({ status: 200, type: StandardPageDto })
  async listStandards(
    @Query() query: StandardQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<StandardView>> {
    return this.standards.list(tenant, query);
  }

  @Post()
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a standard' })
  @ApiResponse({ status: 201, type: StandardDto })
  @ApiResponse({ status: 409, description: 'STANDARD_CODE_TAKEN' })
  async createStandard(
    @Body() dto: CreateStandardDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardView> {
    return this.standards.create(tenant, dto, contextOf(request));
  }

  @Get(':standardId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({ summary: 'Read a standard' })
  @ApiResponse({ status: 200, type: StandardDto })
  @ApiResponse({ status: 404, description: 'STANDARD_NOT_FOUND' })
  async readStandard(
    @Param() params: StandardParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardView> {
    return this.standards.get(tenant, params.standardId);
  }

  @Patch(':standardId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_UPDATE)
  @ApiOperation({
    summary: 'Update a standard',
    description:
      'The code cannot be changed: it is the stable handle other systems quote, and renaming it ' +
      'would silently invalidate every external reference.',
  })
  @ApiResponse({ status: 200, type: StandardDto })
  async updateStandard(
    @Param() params: StandardParamDto,
    @Body() dto: UpdateStandardDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardView> {
    return this.standards.update(tenant, params.standardId, dto, contextOf(request));
  }

  @Patch(':standardId/check-availability')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_CHECK_AVAILABILITY_MANAGE)
  @ApiOperation({
    summary: 'Publish this standard to the check catalogue, or withdraw it',
    description:
      'PUBLIC_CHECKABLE lets anyone check a document against this standard. It does not expose ' +
      'the standard’s rules, and it gives the organization no sight of the documents checked ' +
      'against it, who checked them, or how they scored. Withdrawing it stops new checks and ' +
      'leaves existing reports intact. Its own permission and its own audit entry, because ' +
      'making an institution’s standard world-visible is a deliberate decision.',
  })
  @ApiResponse({ status: 200, type: StandardDto })
  async setStandardCheckAvailability(
    @Param() params: StandardParamDto,
    @Body() dto: UpdateStandardAvailabilityDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardView> {
    return this.standards.setCheckAvailability(
      tenant,
      params.standardId,
      dto.checkAvailability,
      contextOf(request),
    );
  }

  @Post(':standardId/archive')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_ARCHIVE)
  @ApiOperation({
    summary: 'Archive a standard',
    description:
      'Published versions stay readable and stay hashed: documents were judged against them, ' +
      'so a past result must remain explainable.',
  })
  @ApiResponse({ status: 200, type: StandardDto })
  async archiveStandard(
    @Param() params: StandardParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardView> {
    return this.standards.archive(tenant, params.standardId, contextOf(request));
  }

  @Post(':standardId/restore')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_ARCHIVE)
  @ApiOperation({ summary: 'Restore an archived standard' })
  @ApiResponse({ status: 200, type: StandardDto })
  async restoreStandard(
    @Param() params: StandardParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardView> {
    return this.standards.restore(tenant, params.standardId, contextOf(request));
  }

  // --- versions ------------------------------------------------------------

  @Get(':standardId/versions')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({ summary: 'List the versions of a standard' })
  @ApiResponse({ status: 200, type: StandardVersionPageDto })
  async listVersions(
    @Param() params: StandardParamDto,
    @Query() query: StandardVersionQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<StandardVersionView>> {
    return this.versions.list(tenant, params.standardId, query);
  }

  @Post(':standardId/versions')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_VERSION_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a draft version' })
  @ApiResponse({ status: 201, type: StandardVersionDto })
  @ApiResponse({ status: 409, description: 'STANDARD_VERSION_LABEL_TAKEN' })
  async createVersion(
    @Param() params: StandardParamDto,
    @Body() dto: CreateStandardVersionDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StandardVersionView> {
    const version = await this.versions.create(tenant, params.standardId, dto, contextOf(request));
    response.setHeader('ETag', revisionToETag(version.revision));
    return version;
  }

  @Get(':standardId/versions/:versionId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({
    summary: 'Read a standard version',
    description: 'The ETag carries the revision to send back as If-Match when editing.',
  })
  @ApiResponse({ status: 200, type: StandardVersionDto })
  @ApiResponse({ status: 404, description: 'STANDARD_VERSION_NOT_FOUND' })
  async readVersion(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StandardVersionView> {
    const version = await this.versions.get(tenant, params.standardId, params.versionId);
    response.setHeader('ETag', revisionToETag(version.revision));
    return version;
  }

  @Patch(':standardId/versions/:versionId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_VERSION_UPDATE)
  @ApiHeader(IF_MATCH_DOC)
  @ApiOperation({ summary: 'Update a draft version' })
  @ApiResponse({ status: 200, type: StandardVersionDto })
  @ApiResponse({
    status: 409,
    description: 'STANDARD_VERSION_IMMUTABLE — the version is published',
  })
  @ApiResponse({ status: 412, description: 'STANDARD_VERSION_CONFLICT — stale If-Match' })
  async updateVersion(
    @Param() params: StandardVersionParamDto,
    @Body() dto: UpdateStandardVersionDto,
    @Headers(IF_MATCH_HEADER) ifMatch: string | undefined,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StandardVersionView> {
    const version = await this.versions.update(
      tenant,
      params.standardId,
      params.versionId,
      parseIfMatch(ifMatch),
      dto,
      contextOf(request),
    );
    response.setHeader('ETag', revisionToETag(version.revision));
    return version;
  }

  @Post(':standardId/versions/:versionId/clone')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_VERSION_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Clone a version into a new draft',
    description:
      'The only supported way to change a published standard. Every rule is copied; the ' +
      "publication state deliberately is not. The new draft keeps the source version's rule " +
      'schema version unless `upgradeRuleSchema` is set, which is the only way a clone changes ' +
      'the schema the copied rules are judged by. The source version is never modified.',
  })
  @ApiResponse({ status: 201, type: StandardVersionDto })
  async cloneVersion(
    @Param() params: StandardVersionParamDto,
    @Body() dto: CloneStandardVersionDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StandardVersionView> {
    const version = await this.versions.clone(
      tenant,
      params.standardId,
      params.versionId,
      dto.versionLabel,
      contextOf(request),
      { upgradeRuleSchema: dto.upgradeRuleSchema },
    );
    response.setHeader('ETag', revisionToETag(version.revision));
    return version;
  }

  @Get(':standardId/versions/:versionId/validation')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({
    summary: 'Validate a draft without publishing it',
    description:
      'Runs exactly the checks publication runs, so an author sees every problem at once ' +
      'instead of one failed publish at a time.',
  })
  @ApiResponse({ status: 200, type: StandardVersionValidationDto })
  async validateVersion(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardVersionValidationView> {
    return this.versions.validate(tenant, params.standardId, params.versionId);
  }

  @Post(':standardId/versions/:versionId/publish')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_VERSION_PUBLISH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a draft version',
    description:
      'Validates every rule, computes the canonical snapshot and its SHA-256 content hash, and ' +
      'freezes the version — all in one transaction. If another version of the standard is in ' +
      'force, the same transaction marks it SUPERSEDED and records this version as its ' +
      'successor, so the standard always has exactly one version in force. Idempotent: ' +
      'publishing an already-published version returns its existing state rather than failing, ' +
      'so a retried request is safe.',
  })
  @ApiResponse({ status: 200, type: StandardVersionDto })
  @ApiResponse({
    status: 409,
    description:
      'STANDARD_VERSION_EMPTY; STANDARD_VERSION_SUPERSEDED or STANDARD_VERSION_ARCHIVED — the ' +
      'version cannot be published again (clone it); CONFLICT — replacesVersionId is no longer ' +
      'the version in force, or another version was published at the same moment',
  })
  @ApiResponse({ status: 422, description: 'STANDARD_VERSION_INVALID — details.issues lists each' })
  async publishVersion(
    @Param() params: StandardVersionParamDto,
    @Body() dto: PublishStandardVersionDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StandardVersionView> {
    const version = await this.versions.publish(
      tenant,
      params.standardId,
      params.versionId,
      contextOf(request),
      dto.replacesVersionId === undefined ? {} : { replacesVersionId: dto.replacesVersionId },
    );
    response.setHeader('ETag', revisionToETag(version.revision));
    return version;
  }

  @Post(':standardId/versions/:versionId/archive')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_VERSION_ARCHIVE)
  @ApiOperation({ summary: 'Archive a standard version' })
  @ApiResponse({ status: 200, type: StandardVersionDto })
  async archiveVersion(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardVersionView> {
    return this.versions.archive(tenant, params.standardId, params.versionId, contextOf(request));
  }

  @Get(':standardId/versions/:versionId/usage')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({
    summary: 'What relies on a version',
    description:
      'Counts of the submissions checked against this version and the certificates issued on ' +
      'them, as the organization sees them. Individual checks are never counted: they belong ' +
      'to the people who ran them.',
  })
  @ApiResponse({ status: 200, type: StandardVersionUsageDto })
  async versionUsage(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardVersionUsageView> {
    return this.versions.usage(tenant, params.standardId, params.versionId);
  }

  @Get(':standardId/versions/:versionId/snapshot')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @Header('Cache-Control', 'private, max-age=0, must-revalidate')
  @ApiOperation({
    summary: 'Read the published canonical snapshot',
    description:
      'Returns the exact object the content hash was computed over, plus whether it still ' +
      'hashes to the recorded value. Re-serialize it canonically and hash it to verify the ' +
      'standard without trusting PalCert.',
  })
  @ApiResponse({ status: 200, type: StandardVersionSnapshotDto })
  async readSnapshot(
    @Param() params: StandardVersionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<unknown> {
    return this.versions.snapshot(tenant, params.standardId, params.versionId);
  }

  // --- rules ---------------------------------------------------------------

  @Get(':standardId/versions/:versionId/rules')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({ summary: 'List the rules of a version' })
  @ApiResponse({ status: 200, type: RulePageDto })
  async listRules(
    @Param() params: StandardVersionParamDto,
    @Query() query: RuleQueryDto,
    @Tenant() tenant: TenantContext,
  ): Promise<Page<RuleView>> {
    return this.rules.list(tenant, params.standardId, params.versionId, query);
  }

  @Post(':standardId/versions/:versionId/rules')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_RULE_WRITE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader(IF_MATCH_DOC)
  @ApiOperation({
    summary: 'Add a rule to a draft',
    description:
      'A rule is data, never an expression. The payload is validated against the versioned rule ' +
      'schema; every failure comes back in details.issues with the field path that caused it.',
  })
  @ApiResponse({ status: 201, type: RuleDto })
  @ApiResponse({ status: 409, description: 'RULE_CODE_TAKEN' })
  @ApiResponse({ status: 422, description: 'RULE_SCHEMA_INVALID' })
  async createRule(
    @Param() params: StandardVersionParamDto,
    @Body() dto: RuleBodyDto,
    @Headers(IF_MATCH_HEADER) ifMatch: string | undefined,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RuleView> {
    const result = await this.rules.create(
      tenant,
      params.standardId,
      params.versionId,
      parseIfMatch(ifMatch),
      toRuleInput(dto),
      contextOf(request),
    );
    response.setHeader('ETag', revisionToETag(result.revision));
    return result.rule;
  }

  @Get(':standardId/versions/:versionId/rules/:ruleId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_READ)
  @ApiOperation({ summary: 'Read a rule' })
  @ApiResponse({ status: 200, type: RuleDto })
  @ApiResponse({ status: 404, description: 'RULE_NOT_FOUND' })
  async readRule(
    @Param() params: RuleParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleView> {
    return this.rules.get(tenant, params.standardId, params.versionId, params.ruleId);
  }

  @Patch(':standardId/versions/:versionId/rules/:ruleId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_RULE_WRITE)
  @ApiHeader(IF_MATCH_DOC)
  @ApiOperation({
    summary: 'Update a rule in a draft',
    description:
      'The change is merged onto the stored rule and the *result* is validated, because the ' +
      'invariants that matter are relationships between fields.',
  })
  @ApiResponse({ status: 200, type: RuleDto })
  @ApiResponse({ status: 412, description: 'STANDARD_VERSION_CONFLICT' })
  async updateRule(
    @Param() params: RuleParamDto,
    @Body() dto: RuleBodyDto,
    @Headers(IF_MATCH_HEADER) ifMatch: string | undefined,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RuleView> {
    const result = await this.rules.update(
      tenant,
      params.standardId,
      params.versionId,
      params.ruleId,
      parseIfMatch(ifMatch),
      toRuleInput(dto),
      contextOf(request),
    );
    response.setHeader('ETag', revisionToETag(result.revision));
    return result.rule;
  }

  @Delete(':standardId/versions/:versionId/rules/:ruleId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_RULE_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader(IF_MATCH_DOC)
  @ApiOperation({ summary: 'Delete a rule from a draft' })
  @ApiResponse({ status: 204, description: 'Deleted. The ETag carries the new version revision.' })
  async deleteRule(
    @Param() params: RuleParamDto,
    @Headers(IF_MATCH_HEADER) ifMatch: string | undefined,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.rules.remove(
      tenant,
      params.standardId,
      params.versionId,
      params.ruleId,
      parseIfMatch(ifMatch),
      contextOf(request),
    );
    response.setHeader('ETag', revisionToETag(result.revision));
  }

  @Post(':standardId/versions/:versionId/rules/reorder')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_RULE_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader(IF_MATCH_DOC)
  @ApiOperation({
    summary: 'Reorder the rules of a draft',
    description:
      'The complete set of rule ids is required, so a partial list can never leave unlisted ' +
      'rules holding stale positions.',
  })
  @ApiResponse({ status: 204, description: 'Reordered.' })
  async reorderRules(
    @Param() params: StandardVersionParamDto,
    @Body() dto: ReorderRulesDto,
    @Headers(IF_MATCH_HEADER) ifMatch: string | undefined,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.rules.reorder(
      tenant,
      params.standardId,
      params.versionId,
      parseIfMatch(ifMatch),
      dto.ruleIds,
      contextOf(request),
    );
    response.setHeader('ETag', revisionToETag(result.revision));
  }
}

/**
 * Map the wire DTO onto the rule contract.
 *
 * The only real work is `expected`, which the API exposes under a friendlier
 * name than the column it lands in. Everything else is carried straight through
 * to `validateRuleDefinition`, which is the single authority on whether the
 * combination is legal.
 */
function toRuleInput(dto: RuleBodyDto): Record<string, unknown> {
  return {
    ruleCode: dto.ruleCode,
    category: dto.category,
    evaluationMode: dto.evaluationMode,
    scope: dto.scope,
    operator: dto.operator,
    expected: dto.expected,
    unit: dto.unit ?? null,
    tolerance: dto.tolerance ?? null,
    severity: dto.severity,
    blocking: dto.blocking,
    autofix: dto.autofix,
    origin: dto.origin,
    originReference: dto.originReference ?? null,
    titleEn: dto.titleEn,
    titleAr: dto.titleAr,
    descriptionEn: dto.descriptionEn ?? null,
    descriptionAr: dto.descriptionAr ?? null,
    guidanceEn: dto.guidanceEn ?? null,
    guidanceAr: dto.guidanceAr ?? null,
    ...(dto.displayOrder === undefined ? {} : { displayOrder: dto.displayOrder }),
  };
}

export { CollectionQueryDto };
