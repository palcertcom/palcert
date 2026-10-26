# AI configuration for an existing Compose deployment

`docker/docker-compose.ai.yml` passes four AI variables to the existing `api`
and `worker` services. It changes only their environment. It does not select
images, build code, change ports, alter TLS, or start containers.

Use it as the last Compose file, after the deployment's base file and any TLS
override. It is optional and is not a standalone stack. All four values are
required when this overlay is included, so a missing or empty value stops
configuration rendering. Explicit `environment` mappings also override an
`AI_ENABLED=false` entry already present in the base configuration.

## Keep credentials on the deployment host

Keep `/etc/palcert/ai.env` outside the repository, owned by root with mode `600`.
The repository ignores files named `ai.env` as an additional guard.
Store these entries there:

```dotenv
AI_ENABLED=true
AI_PRIMARY_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-opus-5
ANTHROPIC_API_KEY=<the deployment's API key>
```

The last line is documentation, not a usable credential. Enter the real key
through a hidden prompt on the host; do not put it in a shell command, commit,
PR, screenshot, or log. Saving this file alone does not change running services.

The model above matches the current configuration default and the operator's
verified model list for this deployment. Choose a model available to the
deployment's Anthropic account if configuring a different installation.

## Validate without starting services

The production deployment inspected on 2026-10-23 uses:

- Project: `palcert-prod`.
- Working directory: `/opt/palcert/docker`.
- Base: `/opt/palcert/docker/docker-compose.production.yml`.
- TLS override: `/etc/palcert/docker-compose.origin-tls.yml`.
- Existing environment: `/etc/palcert/production.env`.

The base production file is host-managed and is not currently tracked in this
repository. Preserve it and the TLS override; do not substitute the release
test topology for them. Once the reviewed overlay has been brought into the
server checkout at `/opt/palcert/docker/docker-compose.ai.yml`, run:

```bash
(
  set -o pipefail
  sudo docker compose \
    --project-directory /opt/palcert/docker \
    --env-file /etc/palcert/production.env \
    --env-file /etc/palcert/ai.env \
    -p palcert-prod \
    -f /opt/palcert/docker/docker-compose.production.yml \
    -f /etc/palcert/docker-compose.origin-tls.yml \
    -f /opt/palcert/docker/docker-compose.ai.yml \
    config --format json |
  python3 -c '
import json, sys

services = json.load(sys.stdin).get("services", {})
valid = True
for name in ("api", "worker"):
    print("SERVICE=" + name)
    if name not in services:
        print("SERVICE_NOT_FOUND")
        valid = False
        continue
    env = services[name].get("environment") or {}
    for key in ("AI_ENABLED", "AI_PRIMARY_PROVIDER", "ANTHROPIC_MODEL"):
        print(key + "=" + str(env.get(key, "<unset>")))
    present = bool(str(env.get("ANTHROPIC_API_KEY") or "").strip())
    print("ANTHROPIC_API_KEY_PRESENT=" + str(present))
    valid = valid and (
        env.get("AI_ENABLED") == "true"
        and env.get("AI_PRIMARY_PROVIDER") == "anthropic"
        and env.get("ANTHROPIC_MODEL") == "claude-opus-5"
        and present
    )
print("CONFIG_VALID=" + str(valid))
sys.exit(0 if valid else 1)
'
)
```

For the settings above, both services should show `AI_ENABLED=true`,
`AI_PRIMARY_PROVIDER=anthropic`, `ANTHROPIC_MODEL=claude-opus-5`, and
`ANTHROPIC_API_KEY_PRESENT=True`, followed by `CONFIG_VALID=True`.
The filter prints only these fields; never share the unfiltered resolved
configuration because it contains credentials. Avoid `config --environment`
for the same reason. Shell environment variables take precedence over
`--env-file` values; an unexpected result must be resolved before activation.

This validates the requested Compose configuration, not the current container
environment, provider billing, or an actual AI review. Stop here during
preparation. Activating the settings requires a separately approved recreation
of `api` and `worker` after checking their running image identities, readiness
and in-flight work. A plain container restart does not apply new environment
variables. Do not run the full deployment workflow for this configuration check.

## Retain the overlay in subsequent deployments

Every future Compose operation that recreates these services must preserve the
existing project, base/TLS files and environment, and include both the AI
`--env-file` and the final AI `-f` above. A repository pull by itself does not
load the overlay. Omitting it on a later recreation can restore the original
disabled configuration.

`scripts/release/deploy.sh` does not automatically discover this overlay or
`/etc/palcert/ai.env`; this preparation does not change that deployment script
or the GitHub Actions workflows. Integrating a different deployment path must
preserve the same configuration explicitly.

## References

- [Docker Compose file merging](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/).
- [Interpolation and multiple environment files](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
- [Read-only Compose configuration rendering](https://docs.docker.com/reference/cli/docker/compose/config/).
- [Container restart does not apply configuration changes](https://docs.docker.com/reference/cli/docker/compose/restart/).
- [PalCert environment schema](../../packages/config/src/env.schema.ts).
