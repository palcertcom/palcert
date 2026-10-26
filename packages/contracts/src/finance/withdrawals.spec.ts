import { describe, expect, it } from 'vitest';
import { Permission, ORGANIZATION_SCOPED_PERMISSIONS } from '../auth/permissions';
import { RoleCode, getRoleDefinition } from '../auth/roles';
import {
  NOTIFICATION_AUDIENCE,
  NotificationAudience,
  REVIEWER_AUDIENCE_PERMISSION,
  WITHDRAWAL_NOTIFICATION_TYPES,
  isManualTopUpNotificationType,
  isWithdrawalNotificationType,
} from '../notifications/notification';
import { ALLOWED_PAYLOAD_KEYS, assertSafeEventPayload } from '../notifications/payload';
import { LedgerEntryType, LedgerReasonCode, signMatchesType } from './ledger';
import {
  PayoutDestinationType,
  RESERVING_WITHDRAWAL_STATUSES,
  TERMINAL_WITHDRAWAL_STATUSES,
  WITHDRAWAL_FEE_MINOR,
  WITHDRAWAL_POLICY_BOUNDS,
  WITHDRAWAL_STATUSES,
  WITHDRAWAL_TRANSITIONS,
  WithdrawalStatus,
  canTransitionWithdrawal,
  computeOrganizationAvailable,
  computePlatformAvailable,
  computeUserWithdrawable,
  maskTail,
  normalizePayoutDestination,
  summarizePayoutDestination,
  withdrawalAmountToMinor,
  withdrawalReference,
  withdrawalSettlementKey,
} from './withdrawals';

const user = (over: Partial<Parameters<typeof computeUserWithdrawable>[0]> = {}) =>
  computeUserWithdrawable({
    clearedEligibleInflowsMinor: 0n,
    cashOutflowsMinor: 0n,
    activeWithdrawalReservationsMinor: 0n,
    cashLedgerBalanceMinor: 0n,
    activeCashHoldsMinor: 0n,
    ...over,
  });

describe('user withdrawable formula (D1)', () => {
  it('never pays out an admin credit: a CASH balance with no eligible inflow withdraws nothing', () => {
    expect(user({ cashLedgerBalanceMinor: 80_000n }).withdrawableMinor).toBe(0n);
  });

  it('assumes outflows consumed eligible money first (conservative)', () => {
    // 1112.50 manual + 800.00 admin credit; 500.00 spent. Pooled CASH cannot
    // say which credit paid, so the eligible part shrinks first.
    const result = user({
      clearedEligibleInflowsMinor: 111_250n,
      cashOutflowsMinor: 50_000n,
      cashLedgerBalanceMinor: 141_250n,
    });
    expect(result.eligibleMinor).toBe(61_250n);
    expect(result.withdrawableMinor).toBe(61_250n);
  });

  it('is capped by spendable CASH after holds, and by active reservations', () => {
    const result = user({
      clearedEligibleInflowsMinor: 10_000n,
      activeWithdrawalReservationsMinor: 3_000n,
      cashLedgerBalanceMinor: 10_000n,
      activeCashHoldsMinor: 8_000n, // includes the 3_000 withdrawal hold
    });
    expect(result.eligibleMinor).toBe(7_000n);
    expect(result.spendableMinor).toBe(2_000n);
    expect(result.withdrawableMinor).toBe(2_000n);
  });

  it('is never negative, even after a chargeback pushed CASH below zero', () => {
    const result = user({
      clearedEligibleInflowsMinor: 5_000n,
      cashOutflowsMinor: 9_000n,
      cashLedgerBalanceMinor: -4_000n,
    });
    expect(result).toEqual({ eligibleMinor: 0n, spendableMinor: 0n, withdrawableMinor: 0n });
  });
});

describe('organization and platform availability (D4, D5)', () => {
  it('counts only cleared net share as available; clearing is realized but not available', () => {
    expect(
      computeOrganizationAvailable({
        clearedNetMinor: 10_000n,
        clearingNetMinor: 4_000n,
        paidOutMinor: 2_500n,
        reservedMinor: 1_500n,
      }),
    ).toEqual({ realizedMinor: 14_000n, availableMinor: 6_000n });
  });

  it('subtracts refunds, chargeback losses, payouts and reservations, never below zero', () => {
    expect(
      computePlatformAvailable({
        cashServiceRevenueMinor: 20_000n,
        attestationCommissionMinor: 5_000n,
        serviceRefundsMinor: 3_000n,
        unrecoveredChargebackLossMinor: 2_000n,
        paidOutMinor: 10_000n,
        reservedMinor: 4_000n,
      }),
    ).toEqual({ realizedMinor: 20_000n, availableMinor: 6_000n });
    expect(
      computePlatformAvailable({
        cashServiceRevenueMinor: 1_000n,
        attestationCommissionMinor: 0n,
        serviceRefundsMinor: 0n,
        unrecoveredChargebackLossMinor: 5_000n,
        paidOutMinor: 0n,
        reservedMinor: 0n,
      }).availableMinor,
    ).toBe(0n);
  });
});

describe('state machine', () => {
  it('has terminal states with no way out', () => {
    for (const status of TERMINAL_WITHDRAWAL_STATUSES) {
      expect(WITHDRAWAL_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('settles only from PROCESSING and keeps FAILED reserved until retry or release (D9)', () => {
    for (const from of WITHDRAWAL_STATUSES) {
      expect([from, canTransitionWithdrawal(from, WithdrawalStatus.PAID)]).toEqual([
        from,
        from === WithdrawalStatus.PROCESSING,
      ]);
    }
    expect(RESERVING_WITHDRAWAL_STATUSES).toContain(WithdrawalStatus.FAILED);
    expect(canTransitionWithdrawal(WithdrawalStatus.FAILED, WithdrawalStatus.PROCESSING)).toBe(
      true,
    );
    expect(canTransitionWithdrawal(WithdrawalStatus.FAILED, WithdrawalStatus.CANCELLED)).toBe(true);
    expect(canTransitionWithdrawal(WithdrawalStatus.FAILED, WithdrawalStatus.REJECTED)).toBe(false);
    expect(canTransitionWithdrawal(WithdrawalStatus.PROCESSING, WithdrawalStatus.CANCELLED)).toBe(
      false,
    );
  });

  it('charges no fee in v1 and uses a deterministic settlement key', () => {
    expect(WITHDRAWAL_FEE_MINOR).toBe(0n);
    expect(withdrawalSettlementKey('abc')).toBe('withdrawal:abc:settle');
    expect(withdrawalReference('0a1b2c3d-0000-4000-8000-000000000000')).toBe('W-0A1B2C3D');
  });

  it('bounds the clearing periods as approved', () => {
    expect(WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays).toEqual({
      min: 0,
      max: 90,
      default: 14,
    });
    expect(WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays).toEqual({
      min: 0,
      max: 180,
      default: 30,
    });
  });
});

describe('destinations', () => {
  it('drops fields the type does not use and masks identifiers', () => {
    const { value, issues } = normalizePayoutDestination({
      type: PayoutDestinationType.MOBILE_WALLET,
      label: ' Wallet ',
      beneficiaryName: 'Lina Haddad',
      currency: null,
      bankName: null,
      iban: 'PS92PALS000000000400123456702',
      accountNumber: '123456',
      branch: 'x',
      mobileNumber: '+970599123456',
      instructions: null,
    });
    expect(issues).toEqual([]);
    expect(value.iban).toBeNull();
    expect(value.accountNumber).toBeNull();
    expect(value.label).toBe('Wallet');
    const summary = summarizePayoutDestination(value);
    expect(summary.mobileNumberMasked).toBe('•••• 456');
    expect(JSON.stringify(summary)).not.toContain('599123456');
  });

  it('requires an IBAN or account number, and a bank name without an IBAN', () => {
    const base = {
      type: PayoutDestinationType.BANK_ACCOUNT,
      label: 'Bank',
      beneficiaryName: 'Org',
      currency: 'USD',
      bankName: null,
      iban: null,
      accountNumber: null,
      branch: null,
      mobileNumber: null,
      instructions: null,
    } as const;
    expect(normalizePayoutDestination(base).issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(['iban', 'bankName']),
    );
    expect(
      normalizePayoutDestination({ ...base, accountNumber: '12345678', bankName: 'Bank of P' })
        .issues,
    ).toEqual([]);
    expect(normalizePayoutDestination({ ...base, iban: 'NOT-AN-IBAN' }).issues).toContainEqual({
      field: 'iban',
      code: 'INVALID',
    });
    expect(maskTail('PS92PALS000000000400123456702')).toBe('•••• 6702');
  });

  it('parses amounts strictly by currency exponent', () => {
    expect(withdrawalAmountToMinor('12.5', 'USD')).toBe(1250n);
    expect(withdrawalAmountToMinor('12.555', 'USD')).toBeNull();
    expect(withdrawalAmountToMinor('-1', 'USD')).toBeNull();
    expect(withdrawalAmountToMinor('1e3', 'USD')).toBeNull();
  });
});

describe('ledger and notifications', () => {
  it('records a payout as a negative WITHDRAWAL_DEBIT that is never a manual adjustment', () => {
    expect(signMatchesType(LedgerEntryType.WITHDRAWAL_DEBIT, -100n)).toBe(true);
    expect(signMatchesType(LedgerEntryType.WITHDRAWAL_DEBIT, 100n)).toBe(false);
    expect(LedgerReasonCode.WITHDRAWAL_PAID).toBe('WITHDRAWAL_PAID');
  });

  it('routes the pending notice to withdrawal reviewers and carries only the request id', () => {
    expect(NOTIFICATION_AUDIENCE.WITHDRAWAL_PENDING_REVIEW).toBe(
      NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS,
    );
    expect(REVIEWER_AUDIENCE_PERMISSION[NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS]).toBe(
      'finance:withdrawal:review',
    );
    for (const type of WITHDRAWAL_NOTIFICATION_TYPES) {
      expect(isWithdrawalNotificationType(type)).toBe(true);
      expect(isManualTopUpNotificationType(type)).toBe(false);
      expect(ALLOWED_PAYLOAD_KEYS[type]).toEqual(['withdrawalRequestId']);
      expect(() => assertSafeEventPayload(type, { iban: 'PS92' })).toThrow();
      expect(() => assertSafeEventPayload(type, { amountMinor: '1' })).toThrow();
    }
  });
});

describe('permissions (D6, D8)', () => {
  const permissionsOf = (code: RoleCode): readonly string[] =>
    getRoleDefinition(code)?.permissions ?? [];

  it('lets only the organization owner request an organization payout by default', () => {
    for (const code of Object.values(RoleCode)) {
      expect([
        code,
        permissionsOf(code).includes(Permission.ORGANIZATION_WITHDRAWAL_REQUEST),
      ]).toEqual([code, code === RoleCode.ORGANIZATION_OWNER]);
    }
    expect(ORGANIZATION_SCOPED_PERMISSIONS).toContain(Permission.ORGANIZATION_WITHDRAWAL_REQUEST);
  });

  it('keeps approval and execution with finance, not with administrators', () => {
    for (const permission of [
      Permission.FINANCE_WITHDRAWAL_REVIEW,
      Permission.FINANCE_WITHDRAWAL_APPROVE,
      Permission.FINANCE_WITHDRAWAL_EXECUTE,
    ]) {
      for (const code of Object.values(RoleCode)) {
        expect([code, permission, permissionsOf(code).includes(permission)]).toEqual([
          code,
          permission,
          code === RoleCode.PALCERT_FINANCE,
        ]);
      }
    }
  });
});
