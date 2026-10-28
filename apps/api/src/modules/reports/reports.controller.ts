import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Permission } from '@palcert/contracts';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import type { RequestPrincipal } from '../auth/authenticated-request';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../organizations/tenant-context';
import { ReportsService, type ReportScope } from './reports.service';
import { ReportQuery } from './report-query';
import { ReportPdfRenderer } from './report-pdf.renderer';

async function pdf(
  service: ReportsService,
  renderer: ReportPdfRenderer,
  scope: ReportScope,
  query: ReportQuery,
) {
  const report = await service.report(scope, query, true);
  return new StreamableFile(await renderer.render(report), {
    type: 'application/pdf',
    disposition: `attachment; filename="palcert-${scope.kind}-${query.kind}-${report.generatedAt.slice(0, 10)}.pdf"`,
  });
}
@ApiTags('account-reports')
@ApiCookieAuth()
@Controller('reports')
@RequirePermissions(Permission.BALANCE_READ_SELF)
export class PersonalReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly renderer: ReportPdfRenderer,
  ) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Own financial or service report; never another user’s account' })
  report(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return this.service.report({ kind: 'user', userId: user.userId }, query);
  }
  @Get('print')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'All filtered own report rows for printing, up to 5000' })
  print(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return this.service.report({ kind: 'user', userId: user.userId }, query, true);
  }
  @Get('pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download full filtered own report as an Arabic/English PDF' })
  pdf(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return pdf(this.service, this.renderer, { kind: 'user', userId: user.userId }, query);
  }
}
@ApiTags('account-reports')
@ApiCookieAuth()
@Controller('organizations/:organizationId/reports')
@OrganizationScoped()
@RequireOrganizationPermissions(Permission.ORGANIZATION_WITHDRAWAL_READ)
export class OrganizationReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly renderer: ReportPdfRenderer,
  ) {}
  private scope(tenant: TenantContext): ReportScope {
    return { kind: 'organization', userId: tenant.userId, organizationId: tenant.organizationId };
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Institution revenue and content-free service report' })
  report(@Tenant() tenant: TenantContext, @Query() query: ReportQuery) {
    return this.service.report(this.scope(tenant), query);
  }
  @Get('print')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'All filtered institution report rows for printing, up to 5000' })
  print(@Tenant() tenant: TenantContext, @Query() query: ReportQuery) {
    return this.service.report(this.scope(tenant), query, true);
  }
  @Get('pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download full filtered institution report PDF' })
  pdf(@Tenant() tenant: TenantContext, @Query() query: ReportQuery) {
    return pdf(this.service, this.renderer, this.scope(tenant), query);
  }
}
@ApiTags('account-reports')
@ApiCookieAuth()
@Controller('admin/reports')
@RequirePermissions(Permission.ADMIN_REVENUE_SHARE_READ)
export class PlatformReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly renderer: ReportPdfRenderer,
  ) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Audited platform revenue and service report' })
  report(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return this.service.report({ kind: 'platform', userId: user.userId }, query);
  }
  @Get('print')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'All filtered platform report rows for printing, up to 5000' })
  print(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return this.service.report({ kind: 'platform', userId: user.userId }, query, true);
  }
  @Get('pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download full filtered platform report PDF' })
  pdf(@CurrentUser() user: RequestPrincipal, @Query() query: ReportQuery) {
    return pdf(this.service, this.renderer, { kind: 'platform', userId: user.userId }, query);
  }
}
