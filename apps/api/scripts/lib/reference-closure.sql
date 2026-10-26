-- Every reference from PalCert's database to an object in the object store.
--
-- This is the join between the two halves of a PalCert backup, and it is the
-- reason the two halves can be checked against each other at all. Backup uses
-- it to prove the object copy covers everything the database snapshot points
-- at; restore uses it to prove the restored rows still point at objects that
-- are present and byte-for-byte what PalCert recorded.
--
-- Three columns carry the weight:
--
--   `expected_sha256` is PalCert's own authoritative hash where one exists.
--   It is NULL where PalCert never hashed those exact bytes -- a SmartFix
--   plan artifact is covered by a canonical `plan_hash` over the plan's
--   content rather than a digest of the stored file, and an upload session's
--   `client_sha256` is a claim by the uploader that nothing has verified yet.
--   Reporting NULL is the honest answer: a verifier checks presence and size
--   for those and says so, rather than inventing a hash to compare against.
--
--   `deleted` marks a reference the database itself already records as
--   collected. A quarantine object is deleted *before* the row is updated to
--   say so, so an absent object whose row says `quarantine_deleted_at IS NULL`
--   is a genuine dangling reference, while one whose row says otherwise is an
--   ordinary lifecycle step that happened to land inside the backup window.
--
--   `ephemeral` marks staging references that no restored workflow depends
--   on. An upload session is a browser part-way through a PUT; if its object
--   is missing after a restore the user re-uploads, and the sweeper expires
--   the row. Losing one is not a failed restore, so it is counted apart.
SELECT * FROM (
  SELECT
    'document_versions'::text        AS source_table,
    'quarantine_object_key'::text    AS source_column,
    dv.id::text                      AS row_id,
    'quarantine'::text               AS zone,
    dv.quarantine_object_key         AS object_key,
    dv.quarantine_object_version_id  AS object_version_id,
    dv.sha256                        AS expected_sha256,
    dv.size_bytes                    AS expected_size_bytes,
    (dv.quarantine_deleted_at IS NOT NULL) AS deleted,
    false                            AS ephemeral
  FROM document_versions dv
  WHERE dv.quarantine_object_key IS NOT NULL

  UNION ALL
  SELECT 'document_versions', 'clean_object_key', dv.id::text, 'clean',
         dv.clean_object_key, dv.clean_object_version_id,
         dv.sha256, dv.size_bytes, false, false
  FROM document_versions dv
  WHERE dv.clean_object_key IS NOT NULL

  UNION ALL
  SELECT 'standard_source_assets', 'quarantine_object_key', a.id::text, 'quarantine',
         a.quarantine_object_key, a.quarantine_object_version_id,
         a.sha256, a.size_bytes, (a.quarantine_deleted_at IS NOT NULL), false
  FROM standard_source_assets a
  WHERE a.quarantine_object_key IS NOT NULL

  UNION ALL
  SELECT 'standard_source_assets', 'clean_object_key', a.id::text, 'clean',
         a.clean_object_key, a.clean_object_version_id,
         a.sha256, a.size_bytes, false, false
  FROM standard_source_assets a
  WHERE a.clean_object_key IS NOT NULL

  UNION ALL
  SELECT 'document_analyses', 'artifact_object_key', an.id::text, 'derived',
         an.artifact_object_key, an.artifact_object_version_id,
         an.artifact_sha256, an.artifact_size_bytes, false, false
  FROM document_analyses an
  WHERE an.artifact_object_key IS NOT NULL

  UNION ALL
  SELECT 'check_reports', 'artifact_object_key', r.id::text, 'derived',
         r.artifact_object_key, r.artifact_object_version_id,
         r.artifact_sha256, r.artifact_size_bytes, false, false
  FROM check_reports r
  WHERE r.artifact_object_key IS NOT NULL

  UNION ALL
  -- No digest of these exact bytes exists: `plan_hash` is canonical over the
  -- plan's content, not over the stored file.
  SELECT 'smartfix_plans', 'artifact_object_key', p.id::text, 'derived',
         p.artifact_object_key, p.artifact_object_version_id,
         NULL, p.artifact_size_bytes, false, false
  FROM smartfix_plans p
  WHERE p.artifact_object_key IS NOT NULL

  UNION ALL
  -- `output_sha256` hashes the produced document, which is a document version
  -- of its own and is covered above; the manifest file itself is unhashed.
  SELECT 'smartfix_manifests', 'artifact_object_key', m.id::text, 'derived',
         m.artifact_object_key, m.artifact_object_version_id,
         NULL, m.artifact_size_bytes, false, false
  FROM smartfix_manifests m
  WHERE m.artifact_object_key IS NOT NULL

  UNION ALL
  SELECT 'compliance_certificates', 'claim_object_key', c.id::text, 'derived',
         c.claim_object_key, c.claim_object_version_id,
         c.claim_object_sha256, NULL, false, false
  FROM compliance_certificates c
  WHERE c.claim_object_key IS NOT NULL

  UNION ALL
  SELECT 'compliance_certificates', 'certificate_object_key', c.id::text, 'derived',
         c.certificate_object_key, c.certificate_object_version_id,
         c.certificate_object_sha256, NULL, false, false
  FROM compliance_certificates c
  WHERE c.certificate_object_key IS NOT NULL

  UNION ALL
  -- A certificate a user submitted for attestation, as uploaded. Until bytes
  -- arrive (or when the upload window lapsed) there may be no object at all.
  SELECT 'attestation_artifacts', 'quarantine_object_key', aa.id::text, 'quarantine',
         aa.quarantine_object_key, aa.quarantine_object_version_id,
         aa.sha256, aa.size_bytes, (aa.quarantine_deleted_at IS NOT NULL),
         (aa.status IN ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED', 'CANCELLED'))
  FROM attestation_artifacts aa
  WHERE aa.quarantine_object_key IS NOT NULL

  UNION ALL
  -- The clean copy PalCert measured. `purged_at` records retention deleting
  -- a file that was never attested; an attested one is never purged.
  SELECT 'attestation_artifacts', 'clean_object_key', aa.id::text, 'clean',
         aa.clean_object_key, aa.clean_object_version_id,
         aa.sha256, aa.size_bytes, (aa.purged_at IS NOT NULL), false
  FROM attestation_artifacts aa
  WHERE aa.clean_object_key IS NOT NULL

  UNION ALL
  -- The attestation's own pointer at the exact bytes it attests.
  SELECT 'attestations', 'artifact_clean_object_key', at.id::text, 'clean',
         at.artifact_clean_object_key, at.artifact_clean_object_version_id,
         at.artifact_sha256, at.artifact_size_bytes, false, false
  FROM attestations at

  UNION ALL
  -- A manual top-up receipt as uploaded, and the clean copy PalCert scanned.
  -- Proof of a payment finance relied on, so a missing clean copy is a real
  -- loss. A receipt never reached by its bytes has no object at all.
  SELECT 'manual_topup_receipts', 'quarantine_object_key', mr.id::text, 'quarantine',
         mr.quarantine_object_key, mr.quarantine_object_version_id,
         mr.sha256, mr.size_bytes, (mr.quarantine_deleted_at IS NOT NULL),
         (mr.status IN ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED'))
  FROM manual_topup_receipts mr
  WHERE mr.quarantine_object_key IS NOT NULL

  UNION ALL
  SELECT 'manual_topup_receipts', 'clean_object_key', mr.id::text, 'clean',
         mr.clean_object_key, mr.clean_object_version_id,
         mr.sha256, mr.size_bytes, false, false
  FROM manual_topup_receipts mr
  WHERE mr.clean_object_key IS NOT NULL

  UNION ALL
  -- A payment method's logo: staged, then the scanned image customers see.
  SELECT 'manual_payment_method_logos', 'quarantine_object_key', ml.id::text, 'quarantine',
         ml.quarantine_object_key, ml.quarantine_object_version_id,
         ml.sha256, ml.size_bytes, (ml.quarantine_deleted_at IS NOT NULL),
         (ml.status IN ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED'))
  FROM manual_payment_method_logos ml
  WHERE ml.quarantine_object_key IS NOT NULL

  UNION ALL
  SELECT 'manual_payment_method_logos', 'clean_object_key', ml.id::text, 'clean',
         ml.clean_object_key, ml.clean_object_version_id,
         ml.sha256, ml.size_bytes, false, false
  FROM manual_payment_method_logos ml
  WHERE ml.clean_object_key IS NOT NULL

  UNION ALL
  -- Staging for an upload in flight. `client_sha256` is the uploader's claim,
  -- not PalCert's measurement, so it is never an expectation to verify.
  SELECT 'upload_sessions', 'storage_key', u.id::text, 'quarantine',
         u.storage_key, NULL,
         NULL, u.declared_size_bytes, false, true
  FROM upload_sessions u
  WHERE u.storage_key IS NOT NULL
) refs
ORDER BY zone, object_key;
