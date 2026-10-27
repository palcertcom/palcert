#!/usr/bin/env python3
"""Exercise site hooks against CI's disposable stack, never a production host.

Registry authorization is tested separately by the receiver boundary tests.
This harness uses the five images just built by this job, a throwaway AI key
(no provider call), and the stack's own test CA. The actual phase methods,
Compose sealing, queue control, backup, DB restore and cutover are exercised.
"""

import hashlib
import json
import os
import shutil
import ssl
import tempfile
import urllib.request
from pathlib import Path

import site_adapter as adapter
import site_config as config


class BuiltImageSite(adapter.Site):
    def __init__(self, directory, commit, ca):
        # No request reaches the production receiver. This is a local-image
        # integration fixture; it deliberately has no GitHub/SSH credentials.
        self.directory = directory
        self.request = {"commit": commit}
        names = list(adapter.migration_policy())
        self.manifest = {
            "migration": {
                "count": len(names),
                "head": names[-1],
                "checksum": hashlib.sha256("\n".join(names).encode()).hexdigest(),
            }
        }
        self.images = {
            name: f"palcert/{name}:ci"
            for name in ("api", "worker", "web", "migrate", "document-engine")
        }
        self.overlay = directory / "images.json"
        self.ca = ca

    def pull(self):
        # The images were built/loaded in this very job; all content/revision
        # checks still run. No registry publication or deployment is simulated.
        self.check_images()

    def public_health(self):
        context = ssl.create_default_context(cafile=str(self.ca))
        with urllib.request.urlopen(
            "https://localhost:8443/health/ready", context=context, timeout=30
        ) as response:
            return json.load(response)


def rehearse_initial_schema(site, root, repo):
    """An independent 81-migration test DB; never downgrade the running stack."""
    print("site-rehearsal: building separate 81-migration fixture", flush=True)
    source = repo / "packages/database/prisma"
    fixture = root / "prisma81"
    fixture.mkdir(mode=0o755)
    (fixture / "migrations").mkdir(mode=0o755)
    shutil.copy2(source / "schema.prisma", fixture / "schema.prisma")
    shutil.copy2(
        source / "migrations/migration_lock.toml",
        fixture / "migrations/migration_lock.toml",
    )
    for name in list(adapter.migration_policy())[:81]:
        shutil.copytree(source / "migrations" / name, fixture / "migrations" / name)
    adapter.execute(
        [
            "docker",
            "exec",
            "-i",
            adapter.container("postgres")["Id"],
            "psql",
            "-X",
            "--no-password",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "palcert",
            "-d",
            "palcert",
        ],
        stdin=b"CREATE DATABASE palcert_ci81;\n",
    )
    model = site.model()
    # These credentials belong only to the disposable test stack.
    env = {
        k: str(v)
        for k, v in model["services"]["api"]["environment"].items()
        if k.startswith("STORAGE_") or k == "NODE_EXTRA_CA_CERTS"
    }
    old_url = model["services"]["migrate"]["environment"]["DATABASE_ADMIN_URL"]
    old_url = old_url.replace("/palcert?", "/palcert_ci81?")
    adapter.require("/palcert_ci81?" in old_url, "test database URL mismatch")
    env["DATABASE_ADMIN_URL"] = old_url
    env["DATABASE_URL"] = old_url
    output = root / "initial-schema-backup"
    output.mkdir(mode=0o700)
    mounts = [
        (fixture, "/fixture", "ro"),
        (output, "/backup", "rw"),
        ("palcert-release_certs", "/certs", "ro"),
    ]
    site.operator(
        "node",
        "/app/node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--schema",
        "/fixture/schema.prisma",
        env=env,
        network="palcert-release_internal",
        mounts=mounts,
    )
    site.operator(
        "node",
        "apps/api/scripts/backup.mjs",
        "--out",
        "/backup",
        "--label",
        "ci-81-schema-fixture",
        env=env,
        network="palcert-release_internal",
        mounts=mounts,
    )
    backups = list(output.glob("palcert-*/backup.json"))
    adapter.require(len(backups) == 1, "initial schema backup missing")
    evidence = root / "initial-schema-rehearsal"
    evidence.mkdir(mode=0o700)
    adapter.execute(
        ["bash", str(repo / "scripts/release/rehearse-database-upgrade.sh")],
        env={
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            "SOURCE_BACKUP": str(backups[0].parent),
            "REHEARSAL_WORK": str(evidence),
            "MIGRATE_IMAGE": site.images["migrate"],
            "RECOVERY_TOOLS_IMAGE": site.images["migrate"],
            "POSTGRES_IMAGE": adapter.container("postgres")["Image"],
            "RECOVERY_EMBEDDED_TOOLS": "1",
            "AUTOMATIC_REHEARSAL": "1",
            "EXPECT_SOURCE": "81",
            "EXPECT_RELEASE": "84",
        },
        timeout=900,
    )
    print("site-rehearsal: independent 81->84 restore/migration proof PASS")


def main():
    adapter.require(
        os.geteuid() == 0
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("GITHUB_REPOSITORY") == "palcertcom/palcert",
        "this test only runs on the repository's ephemeral hosted CI runner",
    )
    adapter.require(
        not Path("/etc/palcert").exists() and not Path("/opt/palcert").exists(),
        "a production installation must never run this fixture",
    )
    os.umask(0o077)
    repo = Path(__file__).resolve().parents[3]
    root = Path(tempfile.mkdtemp(prefix="palcert-ci-site-", dir="/var/lib"))
    config.PROJECT = "palcert-release"
    config.WORKDIR = repo / "docker"
    config.SITE = root / "sealed"
    adapter.POLICY = repo
    adapter.BACKUPS = root / "backups"
    adapter.BACKUPS.mkdir(mode=0o700)
    empty = root / "empty.json"
    empty.write_text('{"services": {}}')
    ai = root / "ai.json"
    ai.write_text(
        json.dumps(
            {
                "services": {
                    name: {
                        "environment": {
                            "AI_ENABLED": "true",
                            "AI_PRIMARY_PROVIDER": "anthropic",
                            "ANTHROPIC_MODEL": "claude-opus-5",
                            "ANTHROPIC_API_KEY": "ci-fixture-never-sent-to-provider",
                        }
                    }
                    for name in ("api", "worker")
                }
            }
        )
    )
    env1, env2 = root / "production.env", root / "ai.env"
    env1.write_bytes((repo / "release.env").read_bytes())
    env2.write_text("")
    config.ENV_FILES = (env1, env2)
    config.COMPOSE_FILES = (repo / "docker/docker-compose.release.yml", empty, ai)
    config.seal(config.SITE)
    # Match the fixture's AI environment before preflight. No real provider
    # credentials exist and the integration test makes no AI request.
    adapter.execute(
        config.compose_base(config.SITE)
        + [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "--wait",
            "--wait-timeout",
            "180",
            "api",
            "worker",
        ],
        timeout=210,
    )
    ca = root / "ca.crt"
    adapter.execute(["docker", "cp", "palcert-release-api-1:/certs/ca.crt", str(ca)])
    directory = root / "request"
    directory.mkdir(mode=0o700)
    site = BuiltImageSite(directory, os.environ["GITHUB_SHA"], ca)
    for phase in adapter.receive.PHASES:
        print(f"site-rehearsal: starting {phase}", flush=True)
        getattr(site, phase)()
        print(f"site-rehearsal: passed {phase}", flush=True)
    adapter.require(not site.queue("status")["paused"], "queue left paused")
    # Test failure closure with a real running proxy and real Redis queue.
    site.queue("pause")
    original_health = site.public_health
    site.public_health = lambda: {"status": "ok", "release": {"commit": "wrong"}}
    try:
        site.resume()
    except ValueError:
        adapter.require(site.queue("status")["paused"], "failed probe resumed work")
        adapter.require(
            not adapter.container("proxy")["State"]["Running"],
            "failed probe left traffic open",
        )
    else:
        raise AssertionError("wrong release was accepted")
    site.public_health = original_health
    site.resume()
    # Verify-only retry does not depend on the prior request's overlay/proofs.
    retry = root / "retry"
    retry.mkdir(mode=0o700)
    BuiltImageSite(retry, os.environ["GITHUB_SHA"], ca).verify()
    config.validate()
    print("site-rehearsal: full 84->84 cycle, failure closure and retry PASS")
    rehearse_initial_schema(site, root, repo)


if __name__ == "__main__":
    main()
