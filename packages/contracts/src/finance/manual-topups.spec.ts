import { describe, expect, it } from 'vitest';
import { Permission } from '../auth/permissions';
import { RoleCode, getRoleDefinition } from '../auth/roles';
import {
  NOTIFICATION_AUDIENCE,
  NotificationAudience,
  NotificationType,
  MANUAL_TOPUP_NOTIFICATION_TYPES,
  REVIEWER_AUDIENCE_PERMISSION,
  isPlatformAudience,
  isReviewerAudience,
} from '../notifications/notification';
import { ALLOWED_PAYLOAD_KEYS, assertSafeEventPayload } from '../notifications/payload';
import {
  ADJUSTMENT_REASON_CODES,
  LedgerEntryType,
  LedgerReasonCode,
  signMatchesType,
} from './ledger';
import {
  LOGO_FORMATS,
  MANUAL_TOPUP_TRANSITIONS,
  ManualTopUpStatus,
  RECEIPT_FORMATS,
  RECEIPT_MAX_BYTES,
  canTransitionManualTopUp,
  isTerminalManualTopUpStatus,
  manualTopUpAmountLabel,
  manualTopUpFormatForFilename,
  normalizeIban,
  normalizeMobileNumber,
  normalizeTransferReference,
} from './manual-topups';

describe('transfer references', () => {
  it('fold the ways two people type the same reference into one string', () => {
    const forms = ['ab-12 34.cd', 'AB1234CD', ' ab/12_34cd ', 'ＡＢ１２３４ＣＤ', 'AB١٢٣٤CD'];
    for (const form of forms) expect(normalizeTransferReference(form)).toBe('AB1234CD');
  });

  it('refuse what is not a reference rather than silently dropping characters', () => {
    expect(normalizeTransferReference('')).toBeNull();
    expect(normalizeTransferReference('ab1')).toBeNull();
    expect(normalizeTransferReference('AB12<script>')).toBeNull();
    expect(normalizeTransferReference('AB12;DROP')).toBeNull();
    expect(normalizeTransferReference('X'.repeat(101))).toBeNull();
    expect(normalizeTransferReference('A'.repeat(65))).toBeNull();
  });
});

describe('IBANs and phone numbers', () => {
  it('accepts a valid IBAN in any spacing and case, and checks its digits', () => {
    expect(normalizeIban('gb82 west 1234 5698 7654 32')).toBe('GB82WEST12345698765432');
    expect(normalizeIban('PS92PALS000000000400123456702')).toBe('PS92PALS000000000400123456702');
    // One digit changed: the mod-97 check fails.
    expect(normalizeIban('GB82WEST12345698765433')).toBeNull();
    expect(normalizeIban('not an iban')).toBeNull();
  });

  it('normalizes a wallet number', () => {
    expect(normalizeMobileNumber('+970 59-900 0000')).toBe('+970599000000');
    expect(normalizeMobileNumber('٠٥٩٩٠٠٠٠٠٠')).toBe('0599000000');
    expect(normalizeMobileNumber('12')).toBeNull();
    expect(normalizeMobileNumber('call me')).toBeNull();
  });
});

describe('files', () => {
  it('accepts receipts as PDF or images and logos as raster images only', () => {
    expect(RECEIPT_FORMATS).toEqual(['PDF', 'PNG', 'JPEG', 'WEBP']);
    expect(LOGO_FORMATS).toEqual(['PNG', 'JPEG', 'WEBP']);
    expect(manualTopUpFormatForFilename('receipt.PDF', RECEIPT_FORMATS)).toBe('PDF');
    expect(manualTopUpFormatForFilename('logo.pdf', LOGO_FORMATS)).toBeNull();
    expect(manualTopUpFormatForFilename('logo.svg', LOGO_FORMATS)).toBeNull();
    expect(manualTopUpFormatForFilename('receipt.svg', RECEIPT_FORMATS)).toBeNull();
    expect(manualTopUpFormatForFilename('receipt', RECEIPT_FORMATS)).toBeNull();
    expect(RECEIPT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('the request state machine', () => {
  it('allows exactly the documented transitions', () => {
    expect(MANUAL_TOPUP_TRANSITIONS).toEqual({
      DRAFT: ['PENDING_REVIEW', 'CANCELLED'],
      PENDING_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
      APPROVED: [],
      REJECTED: [],
      CANCELLED: [],
    });
    expect(canTransitionManualTopUp(ManualTopUpStatus.DRAFT, ManualTopUpStatus.APPROVED)).toBe(
      false,
    );
    expect(canTransitionManualTopUp(ManualTopUpStatus.APPROVED, ManualTopUpStatus.REJECTED)).toBe(
      false,
    );
    for (const status of [
      ManualTopUpStatus.APPROVED,
      ManualTopUpStatus.REJECTED,
      ManualTopUpStatus.CANCELLED,
    ]) {
      expect(isTerminalManualTopUpStatus(status)).toBe(true);
    }
  });
});

describe('money', () => {
  it('labels an amount exactly, by the currency exponent', () => {
    expect(manualTopUpAmountLabel({ currency: 'ILS', minorUnits: '15000' })).toBe('150.00 ILS');
    expect(manualTopUpAmountLabel({ currency: 'JOD', minorUnits: '5' })).toBe('0.005 JOD');
  });

  it('credits with a positive entry of its own type, which no adjustment can claim', () => {
    expect(signMatchesType(LedgerEntryType.MANUAL_TOPUP_CREDIT, 1n)).toBe(true);
    expect(signMatchesType(LedgerEntryType.MANUAL_TOPUP_CREDIT, -1n)).toBe(false);
    expect(ADJUSTMENT_REASON_CODES).not.toContain(LedgerReasonCode.MANUAL_TOPUP_APPROVED);
  });
});

describe('notifications', () => {
  it('alerts PalCert finance on submission and the person on a decision', () => {
    expect(NOTIFICATION_AUDIENCE[NotificationType.MANUAL_TOPUP_SUBMITTED]).toBe(
      NotificationAudience.PLATFORM_FINANCE_REVIEWERS,
    );
    expect(NOTIFICATION_AUDIENCE[NotificationType.MANUAL_TOPUP_APPROVED]).toBe(
      NotificationAudience.MANUAL_TOPUP_OWNER,
    );
    expect(NOTIFICATION_AUDIENCE[NotificationType.MANUAL_TOPUP_REJECTED]).toBe(
      NotificationAudience.MANUAL_TOPUP_OWNER,
    );
    expect(isReviewerAudience(NotificationAudience.PLATFORM_FINANCE_REVIEWERS)).toBe(true);
    expect(isPlatformAudience(NotificationAudience.PLATFORM_FINANCE_REVIEWERS)).toBe(true);
    expect(isPlatformAudience(NotificationAudience.ORGANIZATION_REVIEWERS)).toBe(false);
    expect(REVIEWER_AUDIENCE_PERMISSION[NotificationAudience.PLATFORM_FINANCE_REVIEWERS]).toBe(
      Permission.FINANCE_MANUAL_TOPUP_REVIEW,
    );
  });

  it('carries an identifier only — never an amount, a reference or a method', () => {
    for (const type of MANUAL_TOPUP_NOTIFICATION_TYPES) {
      expect(ALLOWED_PAYLOAD_KEYS[type]).toEqual(['manualTopUpRequestId']);
      expect(() => assertSafeEventPayload(type, { amountMinor: '100' })).toThrow();
      expect(() => assertSafeEventPayload(type, { reference: 'AB12' })).toThrow();
    }
  });
});

describe('governance', () => {
  const permissionsOf = (code: RoleCode): readonly string[] =>
    getRoleDefinition(code)?.permissions ?? [];

  it('lets finance decide, and nobody else', () => {
    const deciding = [
      Permission.FINANCE_MANUAL_TOPUP_APPROVE,
      Permission.FINANCE_MANUAL_TOPUP_REJECT,
    ];
    expect(permissionsOf(RoleCode.PALCERT_FINANCE)).toEqual(
      expect.arrayContaining([
        Permission.FINANCE_MANUAL_TOPUP_READ,
        Permission.FINANCE_MANUAL_TOPUP_REVIEW,
        ...deciding,
      ]),
    );
    for (const code of Object.values(RoleCode)) {
      if (code === RoleCode.PALCERT_FINANCE) continue;
      for (const permission of [...deciding, Permission.FINANCE_MANUAL_TOPUP_REVIEW]) {
        expect([code, permissionsOf(code).includes(permission)]).toEqual([code, false]);
      }
    }
  });

  it('lets an administrator configure methods and read the queue, and not credit anybody', () => {
    const admin = permissionsOf(RoleCode.PALCERT_ADMIN);
    expect(admin).toEqual(
      expect.arrayContaining([
        Permission.ADMIN_PAYMENT_METHOD_READ,
        Permission.ADMIN_PAYMENT_METHOD_MANAGE,
        Permission.FINANCE_MANUAL_TOPUP_READ,
      ]),
    );
    expect(admin).not.toContain(Permission.FINANCE_MANUAL_TOPUP_APPROVE);
  });

  it('keeps the auditor read-only and finance out of method configuration', () => {
    const auditor = permissionsOf(RoleCode.PALCERT_AUDITOR);
    expect(auditor).toEqual(
      expect.arrayContaining([
        Permission.ADMIN_PAYMENT_METHOD_READ,
        Permission.FINANCE_MANUAL_TOPUP_READ,
      ]),
    );
    expect(auditor).not.toContain(Permission.ADMIN_PAYMENT_METHOD_MANAGE);
    expect(permissionsOf(RoleCode.PALCERT_FINANCE)).not.toContain(
      Permission.ADMIN_PAYMENT_METHOD_MANAGE,
    );
  });
});
