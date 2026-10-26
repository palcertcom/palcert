import {
  EmailFailureCode,
  OUTBOUND_EMAIL_FAILURES,
  OutboundEmailFailure,
  isPermanentEmailFailure,
  isRetryableEmailFailure,
} from '@palcert/contracts';
import { notificationCodeFor } from './notification-email-router';

describe('notificationCodeFor', () => {
  it('keeps retryability consistent with the Phase 16 ladder', () => {
    for (const failure of OUTBOUND_EMAIL_FAILURES) {
      expect(isPermanentEmailFailure(notificationCodeFor(failure))).toBe(
        !isRetryableEmailFailure(failure),
      );
    }
  });

  it('maps credential and sender problems to CONFIGURATION_REJECTED', () => {
    expect(notificationCodeFor(OutboundEmailFailure.AUTHENTICATION_REJECTED)).toBe(
      EmailFailureCode.CONFIGURATION_REJECTED,
    );
    expect(notificationCodeFor(OutboundEmailFailure.SENDER_REJECTED)).toBe(
      EmailFailureCode.CONFIGURATION_REJECTED,
    );
    expect(notificationCodeFor(OutboundEmailFailure.RECIPIENT_REJECTED)).toBe(
      EmailFailureCode.RECIPIENT_REJECTED,
    );
  });
});
