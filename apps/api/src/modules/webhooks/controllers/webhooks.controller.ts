import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  type Page,
  type WebhookAttemptView,
  type WebhookConfigVersionView,
  type WebhookDeliveryView,
  type WebhookEndpointView,
  type WebhookEventType,
  type WebhookOperationView,
  type WebhookRotationPendingView,
  type WebhookSecretRevealView,
  type WebhookVerificationAttemptView,
  type WebhookVerificationRequestView,
} from '@palcert/contracts';
import type { Response } from 'express';

import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookDescriptionDto,
  UpdateWebhookUrlDto,
  WebhookDeliveryParamDto,
  WebhookDeliveryQueryDto,
  WebhookEndpointParamDto,
  WebhookSubscriptionsDto,
  OrganizationParamDto,
} from '../dto/webhook.dto';
import { WebhookAdminService } from '../services/webhook-admin.service';
import { WebhookReadService } from '../services/webhook-read.service';

/**
 * An organization's outbound integrations.
 *
 * Four permissions, and no route authorizes by role name: reading is
 * supportability, managing is configuration, and rotating a secret and
 * replaying an event are heavier acts that an organization may want to give to
 * fewer people than it gives ordinary management.
 *
 * Every mutation that creates a durable intent requires an `Idempotency-Key`,
 * because each of them either generates a credential or sends something to a
 * third party. A dropped response must be recoverable by repeating the request,
 * not by doing it twice and hoping.
 *
 * Nothing here makes a network request. A route creates an intent, a delivery
 * or a configuration; the socket belongs to a worker holding a job lease.
 */
@ApiTags('webhooks')
@ApiCookieAuth()
@Controller('organizations/:organizationId/webhooks')
@OrganizationScoped()
export class WebhooksController {
  constructor(
    private readonly admin: WebhookAdminService,
    private readonly reads: WebhookReadService,
  ) {}

  // --- endpoints ------------------------------------------------------------

  @Get('endpoints')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'This organization’s webhook endpoints' })
  @ApiResponse({ status: 200 })
  listEndpoints(@Tenant() tenant: TenantContext): Promise<WebhookEndpointView[]> {
    return this.reads.listEndpoints(tenant);
  }

  @Post('endpoints')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Create an endpoint and its first configuration',
    description:
      'Returns the signing secret once. Repeating the identical request with the same ' +
      'Idempotency-Key returns the identical secret while the recovery window is open, and ' +
      'WEBHOOK_IDEMPOTENCY_KEY_EXPIRED afterwards. The endpoint is PENDING_VERIFICATION ' +
      'until it answers a challenge.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'WEBHOOK_ENDPOINT_LIMIT_REACHED' })
  @ApiResponse({ status: 422, description: 'WEBHOOK_URL_NOT_ALLOWED' })
  async createEndpoint(
    @Tenant() tenant: TenantContext,
    @Body() body: CreateWebhookEndpointDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WebhookSecretRevealView & { endpointId: string; operationId: string }> {
    noStore(response);
    return this.admin.createEndpoint(tenant, {
      description: body.description,
      url: body.url,
      eventTypes: body.eventTypes,
      idempotencyKey: requireKey(idempotencyKey),
    });
  }

  @Get('endpoints/:endpointId')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'One endpoint, with whatever is waiting to be verified' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'WEBHOOK_ENDPOINT_NOT_FOUND' })
  getEndpoint(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<WebhookEndpointView> {
    return this.reads.getEndpoint(tenant, params.endpointId);
  }

  @Put('endpoints/:endpointId/description')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Rename an endpoint',
    description: 'A label, not a configuration. No idempotency key: it is not a durable intent.',
  })
  @ApiResponse({ status: 204 })
  async updateDescription(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Body() body: UpdateWebhookDescriptionDto,
  ): Promise<void> {
    await this.admin.updateDescription(tenant, params.endpointId, body.description);
  }

  @Put('endpoints/:endpointId/url')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Point the endpoint somewhere new',
    description:
      'Creates a new immutable configuration version and supersedes any older pending one. ' +
      'The verified configuration keeps serving until the new one is verified.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 422, description: 'WEBHOOK_URL_NOT_ALLOWED' })
  updateUrl(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Body() body: UpdateWebhookUrlDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WebhookVerificationRequestView> {
    return this.admin.updateUrl(tenant, params.endpointId, {
      url: body.url,
      idempotencyKey: requireKey(idempotencyKey),
    });
  }

  @Post('endpoints/:endpointId/verify')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Ask PalCert to prove the pending configuration reaches somebody',
    description:
      'Accepted, not completed: a worker makes the request. A new Idempotency-Key is how an ' +
      'administrator asks again after fixing their receiver.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 409, description: 'WEBHOOK_NO_PENDING_CONFIG' })
  verify(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WebhookVerificationRequestView> {
    return this.admin.verify(tenant, params.endpointId, requireKey(idempotencyKey));
  }

  // --- lifecycle ------------------------------------------------------------

  @Post('endpoints/:endpointId/pause')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop sending, keep the configuration' })
  @ApiResponse({ status: 204 })
  async pause(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<void> {
    await this.admin.pause(tenant, params.endpointId);
  }

  @Post('endpoints/:endpointId/resume')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Start sending again',
    description: 'Requires a verified current configuration to resume to.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 409, description: 'WEBHOOK_ENDPOINT_NOT_VERIFIED' })
  async resume(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<void> {
    await this.admin.resume(tenant, params.endpointId);
  }

  @Post('endpoints/:endpointId/disable')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Turn the integration off for good',
    description:
      'Terminal, and it frees the endpoint slot. Nothing brings a disabled endpoint back; ' +
      'creating a new one is the way forward.',
  })
  @ApiResponse({ status: 204 })
  async disable(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<void> {
    await this.admin.disable(tenant, params.endpointId);
  }

  // --- subscriptions --------------------------------------------------------

  @Get('endpoints/:endpointId/subscriptions')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'Which event types this endpoint receives' })
  @ApiResponse({ status: 200 })
  async subscriptions(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<readonly WebhookEventType[]> {
    return (await this.reads.getEndpoint(tenant, params.endpointId)).subscribedEventTypes;
  }

  @Put('endpoints/:endpointId/subscriptions')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @ApiOperation({
    summary: 'Replace the subscription set',
    description:
      'The exact set, not a delta. It takes effect on the next attempt of every delivery, ' +
      'including ones already scheduled — unsubscribing is an instruction, not a preference.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 422, description: 'WEBHOOK_EVENT_TYPE_INVALID' })
  replaceSubscriptions(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Body() body: WebhookSubscriptionsDto,
  ): Promise<readonly WebhookEventType[]> {
    return this.admin.replaceSubscriptions(tenant, params.endpointId, body.eventTypes);
  }

  // --- test and rotate ------------------------------------------------------

  @Post('endpoints/:endpointId/test')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_MANAGE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Send a signed control message',
    description:
      'A real request carrying no event: no PalCert-Event-Id header, and nothing a receiver ' +
      'should record as business. It appears in delivery history like anything else.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 409, description: 'WEBHOOK_ENDPOINT_NOT_VERIFIED' })
  test(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ deliveryId: string; operationId: string }> {
    return this.admin.test(tenant, params.endpointId, requireKey(idempotencyKey));
  }

  @Post('endpoints/:endpointId/rotate-secret')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_SECRET_ROTATE)
  // A rotation answers with the endpoint's new secret rather than creating a
  // resource the caller can address, and the documented contract says 200.
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Mint a new signing secret',
    description:
      'A new pending configuration that must be verified before it serves. Deliveries already ' +
      'in flight keep the configuration they were created with, so a receiver must keep the ' +
      'previous secret valid until the unsettled old-configuration count reaches zero.',
  })
  @ApiResponse({ status: 200 })
  async rotateSecret(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WebhookSecretRevealView & { endpointId: string; operationId: string }> {
    noStore(response);
    return this.admin.rotateSecret(tenant, params.endpointId, requireKey(idempotencyKey));
  }

  @Get('endpoints/:endpointId/rotation-pending')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({
    summary: 'How much traffic still carries the previous configuration',
    description:
      'The number a receiver watches during a rotation. Zero means the old secret can be ' +
      'retired.',
  })
  @ApiResponse({ status: 200 })
  rotationPending(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<WebhookRotationPendingView> {
    return this.reads.rotationPending(tenant, params.endpointId);
  }

  // --- history --------------------------------------------------------------

  @Get('deliveries')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'Delivery history, newest first' })
  @ApiResponse({ status: 200 })
  listDeliveries(
    @Tenant() tenant: TenantContext,
    @Query() query: WebhookDeliveryQueryDto,
    @Param() _params: OrganizationParamDto,
  ): Promise<Page<WebhookDeliveryView>> {
    return this.reads.listDeliveries(tenant, {
      ...(query.endpointId !== undefined ? { endpointId: query.endpointId } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  }

  @Get('deliveries/:deliveryId/attempts')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({
    summary: 'Every network attempt for one delivery',
    description:
      'What happened, not what was said: a normalized code, an HTTP status and a duration. ' +
      'No request body, no response body, no headers.',
  })
  @ApiResponse({ status: 200 })
  listAttempts(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookDeliveryParamDto,
  ): Promise<readonly WebhookAttemptView[]> {
    return this.reads.listAttempts(tenant, params.deliveryId);
  }

  @Post('deliveries/:deliveryId/replay')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_REPLAY)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Send a business event again',
    description:
      'A new delivery id carrying the same event id, so a receiver that deduplicates on the ' +
      'event sees one. It uses the endpoint’s current verified configuration. A control ' +
      'message projects no event and cannot be replayed.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 409, description: 'WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE' })
  replay(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookDeliveryParamDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ deliveryId: string; operationId: string }> {
    return this.admin.replay(tenant, params.deliveryId, requireKey(idempotencyKey));
  }

  @Get('endpoints/:endpointId/verification-attempts')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'Every verification handshake this endpoint has had' })
  @ApiResponse({ status: 200 })
  listVerificationAttempts(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<readonly WebhookVerificationAttemptView[]> {
    return this.reads.listVerificationAttempts(tenant, params.endpointId);
  }

  @Get('endpoints/:endpointId/config-versions')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({
    summary: 'Every configuration this endpoint has had',
    description: 'Immutable versions, newest first. The sealed URL is never part of a read model.',
  })
  @ApiResponse({ status: 200 })
  listConfigVersions(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<readonly WebhookConfigVersionView[]> {
    return this.reads.listConfigVersions(tenant, params.endpointId);
  }

  @Get('endpoints/:endpointId/operations')
  @RequireOrganizationPermissions(Permission.INTEGRATION_WEBHOOK_READ)
  @ApiOperation({ summary: 'The durable management intents recorded for this endpoint' })
  @ApiResponse({ status: 200 })
  listOperations(
    @Tenant() tenant: TenantContext,
    @Param() params: WebhookEndpointParamDto,
  ): Promise<readonly WebhookOperationView[]> {
    return this.reads.listOperations(tenant, params.endpointId);
  }
}

/**
 * A durable intent needs a durable name for the request that asked for it.
 *
 * Refused rather than defaulted: a generated key would make every retry a new
 * operation, which for these six operations means a second endpoint, a second
 * secret or a second outbound message.
 */
function requireKey(idempotencyKey: string | undefined): string {
  const key = idempotencyKey?.trim();
  if (key === undefined || key.length === 0) {
    throw new AppError(PalCertErrorCode.WEBHOOK_IDEMPOTENCY_KEY_REQUIRED);
  }
  return key;
}

/** A response that carries a secret is never stored by anything in between. */
function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
}
