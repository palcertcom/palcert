#!/usr/bin/env bash
# Only a fresh disposable hosted stack. Never used for the production topology.
set -euo pipefail
umask 077
export COMPOSE_PROJECT_NAME=palcert-auto-staging
export MINIO_IMAGE="palcert/minio-ci:${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
export MINIO_MC_IMAGE="$MINIO_IMAGE"
scripts/ci/free-hosted-runner-disk.sh --require-free-gb 25
node scripts/release/verify-manifest.mjs --manifest release-manifest.json \
  --expect-commit "$GITHUB_SHA" --registry-check
bash scripts/release/verify-provenance.sh release-manifest.json
node scripts/release/render-deploy-env.mjs --manifest release-manifest.json --out images.env
docker build -f docker/minio-ci.Dockerfile -t "$MINIO_IMAGE" .
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 24)"
  echo 'STORAGE_ACCESS_KEY_ID=staging-only'
  echo "STORAGE_SECRET_ACCESS_KEY=$(openssl rand -hex 24)"
  for name in AUTH_MFA_SECRET_KEY CERTIFICATE_VERIFICATION_SECRET_KEY API_CLIENT_REVEAL_SECRET_KEY; do
    echo "$name=$(openssl rand -base64 32)"
  done
  echo 'STRIPE_SECRET_KEY=sk_test_ci_placeholder_never_called_00000000'
  echo 'STRIPE_WEBHOOK_SECRET=whsec_ci_placeholder_never_called_00000000'
  echo 'WEBHOOK_ENCRYPTION_ACTIVE_KID=staging'
  echo "WEBHOOK_ENCRYPTION_KEYS=staging:$(openssl rand -base64 32)"
  cat images.env
} > staging.env
export ENVIRONMENT_FILE="$PWD/staging.env" FREEZE="$PWD/release-freeze.json"
export SMOKE="$PWD/scripts/release/staging-smoke.sh" DEPLOY_ENVIRONMENT=staging
bash scripts/release/deploy.sh release-manifest.json images.env
node scripts/release/record-deployment.mjs --manifest release-manifest.json \
  --environment staging --actor "$GITHUB_ACTOR" \
  --workflow-run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --outcome success --out staging-deployment.json
