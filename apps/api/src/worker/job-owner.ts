import { AppError, PalCertErrorCode } from '@palcert/contracts';

/**
 * The customer a job belongs to.
 *
 * Since Phase 10 `processing_jobs.owner_user_id` is nullable, because settling
 * a payment and reconciling against the provider are PalCert's own work and
 * belong to no customer. Every *other* job type still has an owner, and a
 * database CHECK says which is which.
 *
 * Handlers for customer work call this rather than asserting non-null inline:
 * an ownerless document job would mean the ledger row was written wrong, and
 * the worker must refuse to guess a scope rather than run under the wrong one.
 */
export function requireJobOwner(job: {
  readonly id: string;
  readonly jobType: string;
  readonly ownerUserId: string | null;
}): string {
  if (job.ownerUserId === null) {
    throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred.',
      internalContext: {
        reason: `processing job ${job.id} of type ${job.jobType} has no owner but requires one`,
      },
    });
  }
  return job.ownerUserId;
}
