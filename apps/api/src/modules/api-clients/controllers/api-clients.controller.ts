import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ALL_API_CLIENT_SCOPES,
  API_CLIENT_OPERATION_SCOPE,
  AppError,
  PalCertErrorCode,
  Permission,
  WRITE_API_CLIENT_SCOPES,
  type ApiClientScopeDescriptor,
  type ApiClientSecretRevealView,
  type ApiClientView,
} from '@palcert/contracts';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  ApiClientParamDto,
  CreateApiClientDto,
  OrganizationParamDto,
  RotateApiClientDto,
  SetApiClientEnabledDto,
} from '../dto/api-client.dto';
import { ApiClientService } from '../services/api-client.service';

/**
 * Managing an organization's machine credentials.
 *
 * Human-authenticated throughout: these are the screens an administrator uses,
 * and an API client cannot reach any of them. That is deliberate and it is the
 * single most important boundary in the phase — a credential that could mint
 * another credential would make revocation meaningless, because the attacker
 * who holds one could always issue itself a replacement.
 *
 * Reading and managing are separate permissions from issuing, so an
 * organization can let an auditor see the inventory without letting them create
 * a key to the data.
 */
@ApiTags('API clients')
@ApiCookieAuth()
@Controller('organizations/:organizationId/api-clients')
@OrganizationScoped()
export class ApiClientsController {
  constructor(private readonly clients: ApiClientService) {}

  @Get('scopes')
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_READ)
  @ApiOperation({
    summary: 'The scope catalogue',
    description:
      'What each scope unlocks, read from the same allow-list the guard enforces. Served rather ' +
      'than hard-coded into the UI so a screen can never offer a scope that does not exist, or ' +
      'describe one as granting something it does not.',
  })
  scopes(): ApiClientScopeDescriptor[] {
    return ALL_API_CLIENT_SCOPES.map((scope) => ({
      scope,
      operations: Object.entries(API_CLIENT_OPERATION_SCOPE)
        .filter(([, required]) => required === scope)
        .map(([operation]) => operation)
        .sort(),
      write: WRITE_API_CLIENT_SCOPES.includes(scope),
    }));
  }

  @Get()
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_READ)
  @ApiOperation({
    summary: 'List this organization’s API clients',
    description:
      'Never includes a secret, and there is no field on the response that could carry one.',
  })
  async list(
    @Param() _params: OrganizationParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<ApiClientView[]> {
    return this.clients.list(tenant);
  }

  @Get(':apiClientId')
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_READ)
  @ApiOperation({ summary: 'One API client' })
  @ApiResponse({ status: 404, description: 'API_CLIENT_NOT_FOUND' })
  async get(
    @Param() params: ApiClientParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<ApiClientView> {
    return this.clients.get(tenant, params.apiClientId);
  }

  @Post()
  @RequireOrganizationPermissions(
    Permission.INTEGRATION_API_CLIENT_MANAGE,
    Permission.INTEGRATION_API_CLIENT_SECRET_ISSUE,
  )
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required. Creating a client mints a credential, and a retried request must return the ' +
      'one that was already created rather than a second one. An identical repeat returns the ' +
      'identical secret for 24 hours; after that the secret is gone and rotation is the way to ' +
      'get a working one.',
  })
  @ApiOperation({
    summary: 'Create an API client and mint its secret',
    description:
      'The secret is returned here and nowhere else, ever. PalCert stores a one-way verifier ' +
      'and cannot show it again — not to support, not to an administrator, not to anyone.',
  })
  @ApiResponse({ status: 409, description: 'API_CLIENT_LIMIT_REACHED or an idempotency conflict' })
  @ApiResponse({ status: 410, description: 'API_CLIENT_SECRET_NO_LONGER_RECOVERABLE' })
  async create(
    @Param() _params: OrganizationParamDto,
    @Body() body: CreateApiClientDto,
    @Tenant() tenant: TenantContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ApiClientSecretRevealView> {
    return this.clients.create(tenant, {
      displayName: body.displayName,
      description: body.description ?? null,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
    });
  }

  @Post(':apiClientId/secret')
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_SECRET_ISSUE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Rotate the secret',
    description:
      'Mints a new secret and puts the previous one into a bounded overlap during which both ' +
      'work, so a deployment can be updated without downtime. The overlap ends on its own and ' +
      'is never longer than twelve hours: a rotation that left the old secret valid for ever ' +
      'would be an accidental second permanent credential, which is the thing rotation exists ' +
      'to remove.',
  })
  @ApiResponse({
    status: 409,
    description: 'API_CLIENT_ROTATION_IN_PROGRESS or API_CLIENT_REVOKED',
  })
  async rotate(
    @Param() params: ApiClientParamDto,
    @Body() body: RotateApiClientDto,
    @Tenant() tenant: TenantContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ApiClientSecretRevealView> {
    return this.clients.rotate(tenant, {
      apiClientId: params.apiClientId,
      overlapSeconds: body.overlapSeconds,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
    });
  }

  @Post(':apiClientId/enabled')
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_MANAGE)
  // A state transition on something that already exists, answering with the
  // updated record. 201 would claim a resource was created.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable or disable the client',
    description:
      'Reversible, and the secrets survive — re-enabling must not force a customer to redeploy. ' +
      'Use revocation for a credential you believe is compromised.',
  })
  async setEnabled(
    @Param() params: ApiClientParamDto,
    @Body() body: SetApiClientEnabledDto,
    @Tenant() tenant: TenantContext,
  ): Promise<ApiClientView> {
    return this.clients.setEnabled(tenant, params.apiClientId, body.enabled);
  }

  @Post(':apiClientId/revocation')
  @RequireOrganizationPermissions(Permission.INTEGRATION_API_CLIENT_MANAGE)
  // A state transition on something that already exists, answering with the
  // updated record. 201 would claim a resource was created.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke the client',
    description:
      'Final and immediate. Every secret is retired in the same transaction, so a client an ' +
      'organization was told is dead cannot still open the door. Nothing re-enables it.',
  })
  async revoke(
    @Param() params: ApiClientParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<ApiClientView> {
    return this.clients.revoke(tenant, params.apiClientId);
  }
}

/**
 * Required rather than optional, on every credential-minting route.
 *
 * Phase 17 made the same choice for the same reason: a create without a key
 * cannot be retried safely, and the failure mode — a second credential the
 * customer did not ask for and may not know about — is exactly the thing a
 * machine-credential feature must not do.
 */
function requireIdempotencyKey(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(PalCertErrorCode.API_CLIENT_IDEMPOTENCY_KEY_REQUIRED, {
      message: 'An Idempotency-Key header is required for this operation.',
      details: { field: 'Idempotency-Key' },
    });
  }
  const trimmed = value.trim();
  if (trimmed.length > 128 || !/^[\x20-\x7E]+$/.test(trimmed)) {
    throw new AppError(PalCertErrorCode.API_CLIENT_IDEMPOTENCY_KEY_REQUIRED, {
      message: 'Idempotency-Key must be 1 to 128 printable ASCII characters.',
      details: { field: 'Idempotency-Key' },
    });
  }
  return trimmed;
}
