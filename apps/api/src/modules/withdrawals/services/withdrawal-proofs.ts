import {
  AppError,
  ManualTopUpFileStatus,
  PalCertErrorCode,
  type ManualTopUpFileFormat,
  type WithdrawalProofView,
} from '@palcert/contracts';
import type { WithdrawalProof } from '@palcert/database';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

/** The ready proof of one request, for finance or for the requester. */
export async function readyProofOf(tx: TenantClient, requestId: string): Promise<WithdrawalProof> {
  const proof = await tx.withdrawalProof.findFirst({
    where: { requestId, status: ManualTopUpFileStatus.READY },
    orderBy: { readyAt: 'desc' },
  });
  if (proof === null) {
    throw new AppError(PalCertErrorCode.WITHDRAWAL_PROOF_NOT_FOUND, {
      message: 'This withdrawal has no payout proof.',
    });
  }
  return proof;
}

export function proofView(proof: WithdrawalProof): WithdrawalProofView {
  return {
    id: proof.id,
    status: proof.status as ManualTopUpFileStatus,
    originalFilename: proof.originalFilename,
    format: (proof.detectedFormat ?? null) as ManualTopUpFileFormat | null,
    sizeBytes: proof.sizeBytes,
    rejectionCode: proof.rejectionCode,
    createdAt: proof.createdAt.toISOString(),
  };
}
