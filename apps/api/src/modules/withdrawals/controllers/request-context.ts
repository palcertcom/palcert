import type { Request } from 'express';
import type { PayoutDestinationInput } from '@palcert/contracts';
import { contextOf, idempotencyKeyOf } from '../../manual-topups/controllers/request-context';
import type { PayoutDestinationDto } from '../dto/withdrawal.dto';

export { contextOf, idempotencyKeyOf };

export type ContextRequest = Request;

/** A destination body as the service takes it: absent fields are null, never undefined. */
export function destinationInput(body: PayoutDestinationDto): PayoutDestinationInput {
  return {
    type: body.type,
    label: body.label,
    beneficiaryName: body.beneficiaryName,
    currency: body.currency ?? null,
    bankName: body.bankName ?? null,
    iban: body.iban ?? null,
    accountNumber: body.accountNumber ?? null,
    branch: body.branch ?? null,
    mobileNumber: body.mobileNumber ?? null,
    instructions: body.instructions ?? null,
  };
}
