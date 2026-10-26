import { describe, expect, it } from 'vitest';
import { BALANCE_MESSAGES, getBalanceMessages, type BalanceMessages } from './balance-messages';
import { DEFAULT_LOCALE, LOCALES } from './locales';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = [
  'entryTypes',
  'reasonCodes',
  'serviceProducts',
  'topUpStatuses',
  'topUpFailureCodes',
  'holdStatuses',
  'holdPurposes',
  'refundStatuses',
  'errors',
] as const;

/**
 * The vocabulary Phase 10 forbids outright (§2). What a customer holds is
 * credit with PalCert. It is not a wallet, and it has nothing to do with
 * crypto — wording that suggests otherwise would misdescribe the product to
 * a regulator as readily as to a student.
 */
const FORBIDDEN_FINANCIAL_VOCABULARY =
  /\bwallet\b|\bcrypto|\bblockchain\b|\btoken(s|ised|ized)?\b|\bcoin\b|\bweb3\b|محفظة|عملة رقمية|بلوك ?تشين|مشفّرة/i;

/** PalCert's own plumbing, which a reader should never meet (§114). */
const INTERNAL_TERMS =
  /\bstripe\b|\bledger entry\b|\bidempotenc|\bwebhook\b|\bminor units?\b|payment_intent|\bpi_|\bcs_|prisma|postgres|bullmq|redis|\bthe queue\b|سترايب|ويب ?هوك/i;

/**
 * Wording that would promise money back that PalCert cannot send back (§9).
 * Promotional credit is spendable and not withdrawable, and the difference
 * has to survive translation.
 */
const CASH_OUT_CLAIM =
  /\bwithdraw\b|\bcash out\b|\btransfer to your bank\b|السحب النقدي|تحويله إلى حسابك/i;

describe('balance message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(BALANCE_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(BALANCE_MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(BALANCE_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(BALANCE_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('writes Arabic in Arabic', () => {
    for (const [key, value] of flatten(BALANCE_MESSAGES.ar)) {
      expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
    }
  });

  it('names every ledger entry type the API can return', () => {
    // A closed vocabulary. An unlabelled type would reach a customer as a raw
    // enum, and an extra label would mean the UI had invented a transaction
    // kind the ledger cannot produce.
    expect(Object.keys(BALANCE_MESSAGES.en.entryTypes).sort()).toEqual([
      'ADMIN_CREDIT',
      'ADMIN_DEBIT',
      'CHARGEBACK_DEBIT',
      'CHARGEBACK_REVERSAL',
      'MANUAL_TOPUP_CREDIT',
      'PAYMENT_REFUND_DEBIT',
      'PROMOTIONAL_CREDIT',
      'SERVICE_CHARGE',
      'SERVICE_REFUND',
      'TOP_UP_CREDIT',
      'WITHDRAWAL_DEBIT',
    ]);
  });

  it('names every service a balance entry can pay for, AI included', () => {
    // ADR-0149: history shows "AI review", never the raw product code.
    expect(Object.keys(BALANCE_MESSAGES.en.serviceProducts).sort()).toEqual([
      'AI_REVIEW',
      'AI_RULE_EXTRACTION',
      'DOCUMENT_CHECK',
      'SMARTFIX',
    ]);
    expect(BALANCE_MESSAGES.en.serviceProducts.AI_REVIEW).toBe('AI review');
    expect(BALANCE_MESSAGES.ar.serviceProducts.AI_REVIEW).toBe('مراجعة بالذكاء الاصطناعي');
    expect(BALANCE_MESSAGES.ar.serviceProducts.AI_RULE_EXTRACTION).toBe(
      'استخراج القواعد بالذكاء الاصطناعي',
    );
  });

  it('names every top-up, hold and refund state', () => {
    expect(Object.keys(BALANCE_MESSAGES.en.topUpStatuses).sort()).toEqual([
      'CANCELLED',
      'CREATED',
      'EXPIRED',
      'FAILED',
      'PENDING',
      'RECONCILIATION_REQUIRED',
      'SUCCEEDED',
    ]);
    expect(Object.keys(BALANCE_MESSAGES.en.holdStatuses).sort()).toEqual([
      'ACTIVE',
      'CAPTURED',
      'EXPIRED',
      'RELEASED',
    ]);
    expect(Object.keys(BALANCE_MESSAGES.en.refundStatuses).sort()).toEqual([
      'FAILED',
      'PENDING',
      'RECONCILIATION_REQUIRED',
      'REQUESTED',
      'SUCCEEDED',
    ]);
  });

  it('gives every state words, not a colour', () => {
    // §116. A red chip and a green chip are the same chip to a screen reader
    // and to a colour-blind reader, so no state may be left without a label.
    for (const locale of LOCALES) {
      for (const map of NESTED_MAPS) {
        for (const [key, label] of Object.entries(BALANCE_MESSAGES[locale][map])) {
          expect([`${locale}.${map}.${key}`, label.trim().length > 0]).toEqual([
            `${locale}.${map}.${key}`,
            true,
          ]);
        }
      }
    }
  });

  it('never calls PalCert Balance a wallet, and never says anything crypto', () => {
    // §2, and the reason the catalogue exists in this shape at all.
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(BALANCE_MESSAGES[locale])) {
        expect([`${locale}.${key}`, FORBIDDEN_FINANCIAL_VOCABULARY.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
    expect(BALANCE_MESSAGES.en.title).toBe('PalCert Balance');
  });

  it('uses no internal machine vocabulary anywhere', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(BALANCE_MESSAGES[locale])) {
        expect([`${locale}.${key}`, INTERNAL_TERMS.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
  });

  it('describes promotional credit as spendable but not returnable', () => {
    // §9. The honest description is the whole point: promotional credit buys
    // PalCert services and never becomes money back on a card.
    expect(BALANCE_MESSAGES.en.promotionalHint).toMatch(/can spend it on PalCert services/i);
    expect(BALANCE_MESSAGES.en.promotionalHint).toMatch(/cannot be returned to a card/i);
    expect(BALANCE_MESSAGES.ar.promotionalHint).toMatch(/لا يمكن إعادته إلى البطاقة/);

    for (const locale of LOCALES) {
      for (const [key, value] of flatten(BALANCE_MESSAGES[locale])) {
        expect([`${locale}.${key}`, CASH_OUT_CLAIM.test(value)]).toEqual([
          `${locale}.${key}`,
          false,
        ]);
      }
    }
  });

  it('never tells a customer the redirect added their credit', () => {
    // §40, §91: the browser coming back from the provider proves only that a
    // browser came back. The page that a redirect lands on says PalCert is
    // still confirming, and says what happens if the customer walks away.
    expect(BALANCE_MESSAGES.en.returnConfirming).toMatch(
      /confirming your payment with the payment provider/i,
    );
    expect(BALANCE_MESSAGES.en.returnNotYetCredited).toMatch(
      /update as soon as the payment is confirmed/i,
    );
    expect(BALANCE_MESSAGES.en.returnNotYetCredited).toMatch(/safely close this page/i);
    expect(BALANCE_MESSAGES.ar.returnConfirming).toMatch(/نتحقق من عملية الدفع/);

    // And the confirming wording never claims the money arrived.
    for (const locale of LOCALES) {
      expect([
        locale,
        /\badded\b|\bcredited\b|\bcomplete\b|أُضيف|اكتمل/i.test(
          BALANCE_MESSAGES[locale].returnConfirming,
        ),
      ]).toEqual([locale, false]);
    }
  });

  it('tells a customer that PalCert never sees their card details', () => {
    // §38: PalCert holds no card data because the customer types it on the
    // provider's page, and the customer is told so before they leave.
    expect(BALANCE_MESSAGES.en.continueHint).toMatch(/never sees or stores them/i);
    expect(BALANCE_MESSAGES.ar.continueHint).toMatch(/لا يرى بال‌سيرت هذه البيانات ولا يخزنها/);
  });

  it('explains a negative balance without blaming the customer or hiding it', () => {
    // §84, §85: a reversal can take the balance below zero, and PalCert does
    // not fabricate credit to hide that. It says what happened.
    expect(BALANCE_MESSAGES.en.negativeBalance).toMatch(/reversed by your bank/i);
    expect(BALANCE_MESSAGES.ar.negativeBalance).toMatch(/عكس عملية دفع/);
  });

  it('says a provider outage leaves existing balance usable', () => {
    // §111: adding credit is the only thing that stops. Spending, history and
    // the balance itself are unaffected, and the wording must not imply that
    // the whole product is down.
    expect(BALANCE_MESSAGES.en.unavailableHint).toMatch(/balance and history are unaffected/i);
    expect(BALANCE_MESSAGES.en.unavailableHint).toMatch(/can still be used/i);
  });

  it('never offers the customer a self-service card refund', () => {
    // Refunds to a card are a PalCert-initiated act (§72, §95). The page says
    // who arranges one rather than presenting a button that does not exist.
    expect(BALANCE_MESSAGES.en.refundInitiatedByPalCert).toMatch(/arranged by PalCert/i);
    expect(BALANCE_MESSAGES.en.refundInitiatedByPalCert).toMatch(/Contact support/i);
  });

  it('falls back to English for an unknown locale', () => {
    expect(getBalanceMessages('fr' as never)).toBe(BALANCE_MESSAGES.en);
  });
});

/** Every reader-facing string, including the nested maps, as key/value pairs. */
function flatten(messages: BalanceMessages): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') {
      pairs.push([key, value]);
      continue;
    }
    for (const [nested, text] of Object.entries(value as Record<string, string>)) {
      pairs.push([`${key}.${nested}`, text]);
    }
  }
  return pairs;
}
