import { Controller, Get, Param } from '@nestjs/common';
import { ApiBasicAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiClientOperation } from '@palcert/contracts';
import { CurrentMachine, MachineOnly, MachineOperation } from '../decorators/api-client.decorators';
import type { MachinePrincipal } from '../machine-principal';
import { IntegrationReadService } from '../services/integration-read.service';
import { IsUUID } from 'class-validator';

class StandardParamDto {
  @IsUUID()
  standardId!: string;
}

class SubmissionParamDto {
  @IsUUID()
  submissionId!: string;
}

class RevisionParamDto {
  @IsUUID()
  revisionId!: string;
}

class CertificateParamDto {
  @IsUUID()
  certificateId!: string;
}

/**
 * The public integration API (Phase 19).
 *
 * **This controller is the machine-access allow-list.** Every route a machine
 * can reach is here, each naming the operation it implements, and a route that
 * names none is unreachable. Counting the `@MachineOperation` decorators in
 * this file is the complete answer to "what can an integration do?", which is
 * the property the design is for — adding a route elsewhere in PalCert never
 * widens machine access.
 *
 * There is no `:organizationId` in any path. A credential belongs to exactly
 * one organization and cannot name another, so the tenant is taken from the
 * credential and never from the request. That removes cross-organization IDOR
 * as a category rather than defending against it: there is no parameter to
 * tamper with.
 *
 * Every route is a GET. Phase 19 ships no machine write surface, deliberately —
 * a machine that can act wrongly at scale is a different class of incident from
 * one that can only read.
 */
@ApiTags('Integration API')
@ApiBasicAuth('api-client')
@Controller('integration/v1')
@MachineOnly()
export class IntegrationController {
  constructor(private readonly reads: IntegrationReadService) {}

  @Get('organization')
  @MachineOperation(ApiClientOperation.ORGANIZATION_PROFILE_READ)
  @ApiOperation({
    summary: 'The organization this credential belongs to',
    description:
      'Taken from the credential. There is no way to ask about a different organization, ' +
      'because there is no parameter that names one.',
  })
  @ApiResponse({ status: 401, description: 'API_CLIENT_AUTHENTICATION_FAILED' })
  @ApiResponse({ status: 403, description: 'API_CLIENT_SCOPE_INSUFFICIENT' })
  @ApiResponse({ status: 429, description: 'API_CLIENT_RATE_LIMITED' })
  async organization(@CurrentMachine() machine: MachinePrincipal) {
    return this.reads.organization(machine);
  }

  @Get('standards')
  @MachineOperation(ApiClientOperation.ORGANIZATION_STANDARD_LIST)
  @ApiOperation({
    summary: 'This organization’s standards and their published versions',
    description:
      'Published versions only. A draft is work in progress, and an integration acting on rules ' +
      'nobody has approved is the failure this excludes.',
  })
  async standards(@CurrentMachine() machine: MachinePrincipal) {
    return this.reads.standards(machine);
  }

  @Get('standards/:standardId')
  @MachineOperation(ApiClientOperation.ORGANIZATION_STANDARD_READ)
  @ApiOperation({ summary: 'One standard' })
  @ApiResponse({ status: 404, description: 'STANDARD_NOT_FOUND' })
  async standard(@Param() params: StandardParamDto, @CurrentMachine() machine: MachinePrincipal) {
    return this.reads.standard(machine, params.standardId);
  }

  @Get('submissions')
  @MachineOperation(ApiClientOperation.SUBMISSION_LIST)
  @ApiOperation({
    summary: 'Official submissions sent to this organization',
    description:
      'Metadata and decision state. Never the attached document or report, and never the ' +
      'submitter’s contact details.',
  })
  async submissions(@CurrentMachine() machine: MachinePrincipal) {
    return this.reads.submissions(machine);
  }

  @Get('submissions/:submissionId')
  @MachineOperation(ApiClientOperation.SUBMISSION_READ)
  @ApiOperation({ summary: 'One submission and its revisions' })
  @ApiResponse({ status: 404, description: 'SUBMISSION_NOT_FOUND' })
  async submission(
    @Param() params: SubmissionParamDto,
    @CurrentMachine() machine: MachinePrincipal,
  ) {
    return this.reads.submission(machine, params.submissionId);
  }

  @Get('revisions/:revisionId/history')
  @MachineOperation(ApiClientOperation.SUBMISSION_REVISION_HISTORY)
  @ApiOperation({
    summary: 'The decision history of one revision',
    description:
      'Empty for a revision belonging to another organization, which is the same answer as for ' +
      'one that does not exist.',
  })
  async history(@Param() params: RevisionParamDto, @CurrentMachine() machine: MachinePrincipal) {
    return this.reads.revisionHistory(machine, params.revisionId);
  }

  @Get('certificates/:certificateId')
  @MachineOperation(ApiClientOperation.CERTIFICATE_READ)
  @ApiOperation({
    summary: 'One certificate record',
    description:
      'The record, never the PDF and never the verification code. An integration asking whether ' +
      'one was issued does not need the document a person shows an employer.',
  })
  @ApiResponse({ status: 404, description: 'CERTIFICATE_NOT_FOUND' })
  async certificate(
    @Param() params: CertificateParamDto,
    @CurrentMachine() machine: MachinePrincipal,
  ) {
    return this.reads.certificate(machine, params.certificateId);
  }

  @Get('certificates/:certificateId/events')
  @MachineOperation(ApiClientOperation.CERTIFICATE_EVENTS_READ)
  @ApiOperation({ summary: 'A certificate’s lifecycle events' })
  async certificateEvents(
    @Param() params: CertificateParamDto,
    @CurrentMachine() machine: MachinePrincipal,
  ) {
    return this.reads.certificateEvents(machine, params.certificateId);
  }

  @Get('webhook-endpoints')
  @MachineOperation(ApiClientOperation.WEBHOOK_ENDPOINT_LIST)
  @ApiOperation({
    summary: 'This organization’s outbound integrations',
    description:
      'Status and description only. No URL and no signing secret: an integration checking that ' +
      'webhooks are healthy does not need to know where the events go.',
  })
  async webhookEndpoints(@CurrentMachine() machine: MachinePrincipal) {
    return this.reads.webhookEndpoints(machine);
  }
}
