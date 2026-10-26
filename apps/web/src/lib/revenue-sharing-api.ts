import type {
  OrganizationRevenueSharesView,
  OrganizationServiceRevenueView,
  RevenueServiceCode,
} from '@palcert/contracts';
import { apiRequest } from './api-client';
export const revenueSharingApi = {
  rates: (organizationId: string) =>
    apiRequest<OrganizationRevenueSharesView>(
      `/admin/organizations/${organizationId}/revenue-shares`,
    ),
  set: (
    organizationId: string,
    serviceCode: RevenueServiceCode,
    body: { institutionPercent: string; reason: string; effectiveFrom?: string },
  ) =>
    apiRequest<OrganizationRevenueSharesView>(
      `/admin/organizations/${organizationId}/revenue-shares/${serviceCode}`,
      { method: 'PUT', body },
    ),
  revenue: (organizationId: string, admin: boolean, cursor?: string) =>
    apiRequest<OrganizationServiceRevenueView>(
      `${admin ? '/admin' : ''}/organizations/${organizationId}/service-revenue${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
};
