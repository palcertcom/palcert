#!/usr/bin/python3 -I
"""Installed site hooks. All data/logs stay root-only; no uploaded shell runs.

This module is intentionally specific to the reviewed palcert-prod topology.
It refuses new schema transitions until their policy and rehearsal are reviewed.
"""

import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

if __name__ == "__main__":
    # The executable and its directory are installed root-owned, not writable
    # by the deployment account; -I otherwise omits the sibling module path.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import receive
import site_config as config

HERE = Path(__file__).resolve().parent
POLICY = HERE / "site-source"
BACKUPS = Path("/var/backups/palcert")
GIB = 1024**3
CORE = ("api", "worker", "web", "document-engine")
DATA = ("postgres", "redis", "minio", "clamav")
LIMITS = [
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "256",
]
require = receive.require


def execute(args, *, stdin=None, timeout=120, env=None):
    result = subprocess.run(
        args,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=env
        or {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            "LANG": "C.UTF-8",
        },
    )
    if result.returncode:
        # The receiver redirects this stream to a root-only phase log.
        sys.stderr.buffer.write(result.stderr)
        raise RuntimeError("site command failed")
    return result.stdout


def container(service):
    require(service in config.SERVICES, "unknown service")
    items = json.loads(execute(["docker", "inspect", f"{config.PROJECT}-{service}-1"]))
    require(len(items) == 1, "ambiguous service container")
    value = items[0]
    labels = value["Config"].get("Labels", {})
    require(
        labels.get("com.docker.compose.project") == config.PROJECT
        and labels.get("com.docker.compose.service") == service,
        "wrong container project",
    )
    return value


def environment(value):
    return dict(
        entry.split("=", 1) for entry in value["Config"].get("Env", []) if "=" in entry
    )


def migration_policy():
    directory = POLICY / "packages/database/prisma/migrations"
    return {
        p.name: hashlib.sha256((p / "migration.sql").read_bytes()).hexdigest()
        for p in sorted(directory.iterdir())
        if p.is_dir() and p.name[:1].isdigit()
    }


def query(sql):
    return (
        execute(
            [
                "docker",
                "exec",
                "-i",
                "-e",
                "PGOPTIONS=-c default_transaction_read_only=on "
                "-c statement_timeout=10000 -c lock_timeout=2000",
                container("postgres")["Id"],
                "sh",
                "-c",
                "exec psql -X -q -t -A --no-password -v ON_ERROR_STOP=1 "
                '-U "${POSTGRES_USER:-postgres}" '
                '-d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
            ],
            stdin=sql.encode(),
        )
        .decode()
        .strip()
    )


def history():
    rows = json.loads(
        query(
            "SELECT coalesce(json_agg(t ORDER BY migration_name), '[]'::json) "
            "FROM (SELECT migration_name, checksum, finished_at, rolled_back_at "
            "FROM public._prisma_migrations) t;"
        )
    )
    require(
        all(r["finished_at"] and not r["rolled_back_at"] for r in rows),
        "unfinished or rolled-back migration",
    )
    require(
        len({r["migration_name"] for r in rows}) == len(rows),
        "duplicate migration history",
    )
    policy = migration_policy()
    for row in rows:
        require(
            policy.get(row["migration_name"]) == row["checksum"],
            "migration checksum drift",
        )
    require(len(rows) in (81, 84), "unreviewed production schema level")
    require(
        [r["migration_name"] for r in rows] == list(policy)[: len(rows)],
        "migration history is not the reviewed prefix",
    )
    return rows


class Site:
    def __init__(self, directory):
        self.directory = Path(directory)
        receive.trusted(self.directory)
        require(self.directory.parent == receive.STATE, "invalid request directory")
        self.request = json.loads((self.directory / "request.json").read_text())
        # The receiver has already authorized the request. It can legitimately
        # be older than ten minutes by the backup/rehearsal phase.
        receive.validate(
            self.request,
            dt.datetime.fromisoformat(self.request["issuedAt"].replace("Z", "+00:00")),
        )
        self.manifest = json.loads(self.request["manifestText"])
        self.images = {
            receive.NAMES[k]: v["reference"]
            for k, v in self.request["freeze"]["images"].items()
        }
        self.overlay = self.directory / "images.json"

    def save(self, name, data):
        receive.atomic_json(self.directory / name, data)

    def model(self):
        config.validate()
        return json.loads(
            execute(config.compose_base(config.SITE) + ["config", "--format", "json"])
        )

    def compose(self, *args):
        config.validate()
        return execute(
            config.compose_base(config.SITE) + ["-f", str(self.overlay), *args],
            timeout=600,
        )

    def queue(self, action):
        return json.loads(
            execute(
                ["docker", "exec", "-i", container("api")["Id"], "node", "-", action],
                stdin=(HERE / "queue-control.cjs").read_bytes(),
                timeout=30,
            )
        )

    def stop(self, service):
        value = container(service)
        if not value["State"]["Running"]:
            return
        # -1 never escalates to SIGKILL. On timeout only the Docker client is
        # killed by subprocess; the daemon's graceful stop is still pending.
        # The receiver's durable blocked marker requires operator recovery.
        execute(["docker", "stop", "--timeout", "-1", value["Id"]], timeout=600)
        ended = container(service)
        require(
            not ended["State"]["Running"]
            and not ended["State"].get("OOMKilled")
            and ended["State"].get("ExitCode") in (0, 143),
            "unclean service shutdown",
        )

    def active_work(self):
        active = int(
            query(
                "SELECT (SELECT count(*) FROM processing_jobs WHERE status = 'RUNNING')"
                " + (SELECT count(*) FROM ai_reviews WHERE status = 'RUNNING');"
            )
        )
        if (
            query(
                "SELECT to_regclass('public.smartfix_planning_reservations') "
                "IS NOT NULL;"
            )
            == "t"
        ):
            # READY plans may legitimately await a user's approval. PLANNING
            # means a provider call can still be running after client disconnect.
            active += int(
                query(
                    "SELECT count(*) FROM smartfix_planning_reservations "
                    "WHERE status = 'PLANNING';"
                )
            )
        return active

    def assert_quiet(self):
        require(
            all(not container(s)["State"]["Running"] for s in (*CORE, "proxy")),
            "application still running",
        )
        require(self.active_work() == 0, "processing or AI ledger has running work")

    def operator(self, *args, network="none", env=None, mounts=()):
        command = [
            "docker",
            "run",
            "--rm",
            "--network",
            network,
            *LIMITS,
            "--user",
            "0:0",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=128m",
            "-w",
            "/app/operator",
        ]
        if env:
            # Values live only in this root process and Docker's environment.
            # Passing `-e NAME` avoids putting values in command-line arguments.
            for key in env:
                command += ["-e", key]
        for source, target, mode in mounts:
            command += ["-v", f"{source}:{target}:{mode}"]
        merged_env = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            **(env or {}),
        }
        return execute(
            [*command, self.images["migrate"], *args], env=merged_env, timeout=600
        )

    def match_running(self, model, record):
        original_bind = {
            str(config.SITE / name): source for source, name in record["binds"].items()
        }
        for service in (*CORE, *DATA, "proxy"):
            expected = model["services"][service]
            actual = container(service)
            env = environment(actual)
            require(
                all(
                    env.get(k) == v for k, v in expected.get("environment", {}).items()
                ),
                "running environment differs from the sealed configuration",
            )
            expected_networks = {
                model["networks"][name]["name"] for name in expected.get("networks", {})
            }
            require(
                set(actual["NetworkSettings"]["Networks"]) == expected_networks,
                "running network topology differs",
            )
            mounts = {m["Destination"]: m for m in actual["Mounts"]}
            for mount in expected.get("volumes", []):
                live = mounts.get(mount["target"], {})
                require(
                    live.get("Type") == mount["type"]
                    and live.get("RW") is not mount.get("read_only", False),
                    "running mount type or permissions differ",
                )
                source = mount["source"]
                if mount["type"] == "volume":
                    require(
                        live.get("Name") == model["volumes"][source]["name"],
                        "running volume differs",
                    )
                else:
                    require(
                        live.get("Source") in {source, original_bind.get(source)},
                        "running bind source differs",
                    )

    def preflight(self):
        model = self.model()
        config.assert_model(model)
        require(
            shutil.disk_usage("/var/lib/docker").free >= 12 * GIB,
            "less than 12 GiB before image pull",
        )
        require(
            len(migration_policy()) == 84,
            "installed schema policy is not 84 migrations",
        )
        names = list(migration_policy())
        expected = {
            "count": 84,
            "head": names[-1],
            "checksum": hashlib.sha256("\n".join(names).encode()).hexdigest(),
        }
        require(self.manifest["migration"] == expected, "unreviewed migration set")
        for service in (*CORE, *DATA, "proxy"):
            value = container(service)
            require(value["State"]["Running"], "a production service is stopped")
            if service != "proxy":
                require(
                    value["State"].get("Health", {}).get("Status") == "healthy",
                    "production is not healthy",
                )
        record = config.validate()
        self.match_running(model, record)
        timeout_ms = int(
            model["services"]["api"]["environment"].get(
                "ANTHROPIC_TIMEOUT_MS", "120000"
            )
        )
        require(
            record["apiTimeoutSeconds"] >= timeout_ms / 1000 + 60,
            "API timeout lacks AI completion margin",
        )
        require(
            container("proxy")["Config"].get("StopSignal") == "SIGQUIT",
            "proxy cannot drain gracefully",
        )
        require(
            not self.queue("status")["paused"],
            "queue was already paused by an operator",
        )
        state = {
            "historyCount": len(history()),
            "postgresImage": container("postgres")["Image"],
        }
        self.save("site-before.json", state)
        services = {k: {"image": v} for k, v in self.images.items()}
        services["migrate-check"] = {"image": self.images["migrate"]}
        self.save("images.json", {"services": services})

    def pull(self):
        for reference in self.images.values():
            execute(["docker", "pull", reference], timeout=900)
            require(
                shutil.disk_usage("/var/lib/docker").free >= 6 * GIB,
                "image pull exhausted reserved space",
            )
        self.check_images()

    def check_images(self):
        for reference in self.images.values():
            value = json.loads(execute(["docker", "image", "inspect", reference]))[0]
            require(
                value["Config"]
                .get("Labels", {})
                .get("org.opencontainers.image.revision")
                == self.request["commit"],
                "image commit differs",
            )
        script = """
const fs=require('fs'), c=require('crypto'), p='/app/prisma/migrations';
const entries=fs.readdirSync(p).filter(n=>/^[0-9]/.test(n)).sort().map(n=>[
  n,c.createHash('sha256').update(fs.readFileSync(p+'/'+n+'/migration.sql'))
    .digest('hex')]);
console.log(JSON.stringify(Object.fromEntries(entries)));
"""
        actual = json.loads(self.operator("node", "-e", script))
        require(
            actual == migration_policy(),
            "image migration contents differ from reviewed policy",
        )
        self.operator(
            "sh",
            "-c",
            "test -f apps/api/scripts/backup.mjs && "
            "pg_dump --version | grep -q ' 17\\.'",
        )

    def drain(self):
        require(not self.queue("status")["paused"], "unexpected existing pause")
        self.save("queue-paused-by-deploy.json", {"willPause": True})
        require(self.queue("pause")["paused"], "queue pause failed")
        self.stop("proxy")  # graceful Nginx QUIT waits for already accepted HTTP
        deadline = time.monotonic() + 600
        while True:
            state = self.queue("status")
            require(state["paused"], "queue unexpectedly resumed")
            if state["active"] == 0 and self.active_work() == 0:
                break
            require(time.monotonic() < deadline, "active jobs did not drain")
            time.sleep(2)
        for service in ("worker", "api", "web", "document-engine"):
            self.stop(service)
        self.assert_quiet()
        self.save("drained.json", {"at": dt.datetime.now(dt.timezone.utc).isoformat()})

    def backup(self):
        self.assert_quiet()
        receive.trusted(BACKUPS)
        destination = BACKUPS / self.directory.name
        destination.mkdir(mode=0o700)
        model = self.model()
        api_env = model["services"]["api"]["environment"]
        migrate_env = model["services"]["migrate"]["environment"]
        backup_env = {
            k: str(v)
            for k, v in api_env.items()
            if k.startswith("STORAGE_") or k == "NODE_EXTRA_CA_CERTS"
        }
        backup_env["DATABASE_ADMIN_URL"] = migrate_env["DATABASE_ADMIN_URL"]
        mounts = [(destination, "/backup", "rw")]
        for v in model["services"]["api"].get("volumes", []):
            if v["target"] == "/certs":
                volume = model["volumes"][v["source"]]["name"]
                mounts.append((volume, "/certs", "ro"))
        self.operator(
            "node",
            "apps/api/scripts/backup.mjs",
            "--out",
            "/backup",
            "--label",
            "production-pre-deploy",
            network=f"{config.PROJECT}_internal",
            env=backup_env,
            mounts=mounts,
        )
        copies = list(destination.glob("palcert-*/backup.json"))
        require(len(copies) == 1, "ambiguous backup")
        backup = copies[0].parent
        self.operator(
            "node",
            "apps/api/scripts/verify-backup.mjs",
            "--from",
            f"/backup/{backup.name}",
            "--deep",
            mounts=mounts,
        )
        execute(
            [
                "tar",
                "--create",
                "--file",
                str(destination / "site-configuration.tar"),
                "--directory",
                str(config.SITE),
                ".",
            ]
        )
        # The original environment, TLS key and proxy bytes are inside the
        # sealed snapshot. Named certs/KMS volumes are required separately.
        for volume_name in (f"{config.PROJECT}_certs", f"{config.PROJECT}_storage-kms"):
            volume = json.loads(execute(["docker", "volume", "inspect", volume_name]))[
                0
            ]
            source = Path(volume["Mountpoint"])
            require(
                source == Path("/var/lib/docker/volumes") / volume_name / "_data",
                "unexpected security volume path",
            )
            execute(
                [
                    "tar",
                    "--create",
                    "--file",
                    str(destination / f"{volume_name}.tar"),
                    "--directory",
                    str(source),
                    ".",
                ]
            )
        archive_digests = {}
        for archive in destination.glob("*.tar"):
            execute(["tar", "--list", "--file", str(archive)])
            with archive.open("rb") as stream:
                archive_digests[archive.name] = hashlib.file_digest(
                    stream, "sha256"
                ).hexdigest()
                os.fsync(stream.fileno())
        require(len(archive_digests) == 3, "configuration archive incomplete")
        receive.atomic_json(destination / "archive-sha256.json", archive_digests)
        self.save(
            "backup.json",
            {"path": str(backup), "configurationDirectory": str(destination)},
        )

    def rehearse(self):
        self.assert_quiet()
        before = json.loads((self.directory / "site-before.json").read_text())
        backup = json.loads((self.directory / "backup.json").read_text())
        output = self.directory / "rehearsal"
        output.mkdir(mode=0o700)
        env = {
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            "LANG": "C.UTF-8",
            "SOURCE_BACKUP": backup["path"],
            "REHEARSAL_WORK": str(output),
            "MIGRATE_IMAGE": self.images["migrate"],
            "RECOVERY_TOOLS_IMAGE": self.images["migrate"],
            "POSTGRES_IMAGE": before["postgresImage"],
            "RECOVERY_EMBEDDED_TOOLS": "1",
            "AUTOMATIC_REHEARSAL": "1",
            "EXPECT_SOURCE": str(before["historyCount"]),
            "EXPECT_RELEASE": "84",
        }
        execute(
            ["bash", str(POLICY / "scripts/release/rehearse-database-upgrade.sh")],
            env=env,
            timeout=900,
        )
        self.save(
            "rehearsal-passed.json",
            {"backup": backup["path"], "commit": self.request["commit"]},
        )

    def apply(self):
        self.assert_quiet()
        proof = json.loads((self.directory / "rehearsal-passed.json").read_text())
        require(proof["commit"] == self.request["commit"], "rehearsal commit mismatch")
        self.compose("run", "--rm", "--no-deps", "migrate")
        self.compose("run", "--rm", "--no-deps", "migrate-check")
        require(len(history()) == 84, "migration application did not converge")
        self.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", *CORE)

    def verify(self):
        self.model()  # source drift and sealed file trust checked on every phase
        deadline = time.monotonic() + 180
        while True:
            states = [container(s) for s in CORE]
            if all(
                v["State"].get("Health", {}).get("Status") == "healthy" for v in states
            ):
                break
            require(
                time.monotonic() < deadline, "new application did not become healthy"
            )
            time.sleep(2)
        for service in CORE:
            value = container(service)
            image = json.loads(
                execute(["docker", "image", "inspect", self.images[service]])
            )[0]
            require(
                value["Image"] == image["Id"], "running image differs from the manifest"
            )
            if service in ("api", "worker"):
                env = environment(value)
                require(
                    env.get("AI_ENABLED") == "true"
                    and env.get("AI_PRIMARY_PROVIDER") == "anthropic"
                    and env.get("ANTHROPIC_MODEL") == "claude-opus-5",
                    "AI configuration drift",
                )
        require(len(history()) == 84, "unexpected schema after cutover")
        script = """
(async()=>{
  const services=[['api',4000],['worker',4100],['document-engine',8000]];
  for(const [host,port] of services){
    const r=await fetch(`http://${host}:${port}/health/ready`,{
      signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error('not ready');
    const b=await r.json();
    if(b.status!=='ok'||(host!=='document-engine'&&
       b.release?.commit!==process.env.APP_COMMIT))throw Error('release mismatch');
  }
})().catch(()=>process.exit(1));
"""
        execute(
            ["docker", "exec", container("api")["Id"], "node", "-e", script], timeout=80
        )
        if not (self.directory / "queue-paused-by-deploy.json").exists():
            # A successful-manifest retry reaches verify alone in a fresh
            # request directory. It must prove service is still public.
            require(container("proxy")["State"]["Running"], "proxy is stopped")
            require(not self.queue("status")["paused"], "queue is paused")
            self.wait_public()

    def public_health(self):
        with urllib.request.urlopen(
            "https://app.palcert.com/health/ready", timeout=30
        ) as response:
            return json.load(response)

    def wait_public(self):
        deadline = time.monotonic() + 60
        while True:
            try:
                body = self.public_health()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(2)
        require(
            body.get("status") == "ok"
            and body.get("release", {}).get("commit") == self.request["commit"],
            "public origin has wrong health or release",
        )

    def resume(self):
        require(
            (self.directory / "queue-paused-by-deploy.json").is_file(),
            "deployment did not own the pause",
        )
        require(self.queue("status")["paused"], "queue unexpectedly unpaused")
        try:
            self.compose(
                "up", "-d", "--no-deps", "--no-build", "--pull", "never", "proxy"
            )
            self.wait_public()
            require(not self.queue("resume")["paused"], "queue could not resume")
        except Exception:
            try:
                self.queue("pause")
            finally:
                self.stop("proxy")
            raise
        receive.atomic_json(
            config.SITE / "current-images.json", json.loads(self.overlay.read_text())
        )


def main():
    os.umask(0o077)
    require(os.geteuid() == 0 and len(sys.argv) == 3, "root hook invocation required")
    phase, directory = sys.argv[1:]
    require(phase in receive.PHASES, "invalid phase")
    receive.trusted(HERE)
    for path in (
        HERE / "site_adapter.py",
        HERE / "site_config.py",
        HERE / "queue-control.cjs",
    ):
        receive.trusted(path)
    getattr(Site(directory), phase)()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"site hook refused ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
