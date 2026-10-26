import type { MoneyView } from './money';

export const REVENUE_SERVICE_CODES = [
  'DOCUMENT_CHECK',
  'SMARTFIX',
  'AI_REVIEW',
  'AI_RULE_EXTRACTION',
  'ATTESTATION',
] as const;
export type RevenueServiceCode = (typeof REVENUE_SERVICE_CODES)[number];

export interface RevenueShareRateView {
  readonly serviceCode: RevenueServiceCode;
  readonly institutionPercent: string;
  readonly platformPercent: string;
  readonly isDefault: boolean;
  readonly effectiveFrom: string | null;
  readonly history: readonly {
    id: string;
    institutionPercent: string;
    effectiveFrom: string;
    changedByUserId: string;
    changeReason: string;
    createdAt: string;
  }[];
}
export interface OrganizationRevenueSharesView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly rates: readonly RevenueShareRateView[];
}
export interface OrganizationServiceRevenueView {
  readonly totals: readonly {
    serviceCode: RevenueServiceCode;
    currency: string;
    gross: MoneyView;
    institution: MoneyView;
    platform: MoneyView;
  }[];
  readonly entries: readonly {
    id: string;
    serviceCode: RevenueServiceCode;
    referenceId: string;
    currency: string;
    gross: MoneyView;
    institution: MoneyView;
    platform: MoneyView;
    isRefund: boolean;
    createdAt: string;
  }[];
  readonly nextCursor: string | null;
}
