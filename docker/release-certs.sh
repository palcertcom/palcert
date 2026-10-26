#!/bin/sh
# Generate the release stack's TLS material, once, into a shared volume.
#
# PalCert's production configuration refuses to boot without TLS: object
# storage must be reached over https and the public web URL must be https.
# Those guards are correct and this stack does not get to opt out of them —
# a "production-like" stack that disables the checks production depends on is
# not production-like, it is a different system that happens to use the same
# images.
#
# So the release stack terminates TLS for real, with a private CA generated
# here. Self-signed certificates are appropriate for a stack whose whole
# purpose is to be thrown away; what matters is that the code paths exercised
# are the ones production uses — https to storage, https on the public URL,
# and a CA the Node processes have to be told about explicitly.
set -eu

CERTS=/certs

# The object store's encryption-at-rest key (Phase 20 Checkpoint 9).
#
# PalCert's production configuration refuses to boot unless every object is
# stored with server-side encryption (`STORAGE_SERVER_SIDE_ENCRYPTION`), and
# MinIO honours an SSE-S3 request only when it has a KMS. Without one, every
# upload and every object the workers write is refused with `501 KMS is not
# configured` -- which the release stack did, unnoticed, until Checkpoint 20.9
# pushed a real document through it.
#
# A managed object store owns its SSE-S3 key and the operator never sees it.
# This is the release stack's stand-in for that: one static key, generated
# here once, in a volume only MinIO mounts. It sits beside the TLS material
# only in the sense that this script writes both; the API, the worker and the
# proxy never see it. Kept before the early exit below so a stack whose
# certificates predate it still gets one.
KMS=/kms
if [ -d "$KMS" ] && [ ! -s "$KMS/key" ]; then
    umask 077
    printf 'palcert-release-sse:%s' "$(openssl rand -base64 32)" > "$KMS/key"
    echo "object-store encryption key generated"
fi

[ -f "$CERTS/ca.crt" ] && { echo "certificates already present"; exit 0; }

mkdir -p "$CERTS"
cd "$CERTS"

# A CA, so the API and worker can verify MinIO rather than skipping
# verification. NODE_EXTRA_CA_CERTS points at this file; nothing anywhere sets
# NODE_TLS_REJECT_UNAUTHORIZED, which would be the shortcut that teaches the
# wrong habit.
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout ca.key -out ca.crt \
    -subj "/CN=PalCert Release Test CA" >/dev/null 2>&1

issue() {
    name="$1"
    openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" \
        -subj "/CN=$name" >/dev/null 2>&1
    printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\n' "$name" > "$name.ext"
    openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
        -out "$name.crt" -days 365 -extfile "$name.ext" >/dev/null 2>&1
    rm -f "$name.csr" "$name.ext"
}

issue proxy
issue minio

# MinIO expects its pair under this exact name.
mkdir -p minio-certs
cp minio.crt minio-certs/public.crt
cp minio.key minio-certs/private.key

chmod 644 ./*.crt ./*.key minio-certs/*
echo "certificates generated"
