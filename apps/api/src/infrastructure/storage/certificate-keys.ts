/**
 * Where a certificate's artifacts live (§50).
 *
 * Organization-scoped and built only from identifiers. No name, no email, no
 * document title, no filename — a storage key is seen by more systems than
 * anyone expects, and one that carried a thesis title would leak it to every
 * one of them.
 */
export function certificateClaimKey(params: {
  readonly organizationId: string;
  readonly certificateId: string;
}): string {
  return `organizations/${params.organizationId}/certificates/${params.certificateId}/claim`;
}

export function certificateArtifactKey(params: {
  readonly organizationId: string;
  readonly certificateId: string;
}): string {
  return `organizations/${params.organizationId}/certificates/${params.certificateId}/certificate.pdf`;
}
