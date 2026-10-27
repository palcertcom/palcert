#!/usr/bin/python3 -I
"""Root-owned, forced-command deployment receiver. No uploaded code is executed.

Site-specific hooks must be installed and reviewed on the server first. Missing
hooks or a disabled config refuse BEFORE touching production. Their stdout/stderr
stay in root-only logs, never in the public Actions log.
"""

import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.request

CONFIG = Path("/etc/palcert/deploy.json")
STATE = Path("/var/lib/palcert-deploy")
HOOKS = Path("/usr/local/lib/palcert-deploy/hooks")
PHASES = (
    "preflight",
    "pull",
    "drain",
    "backup",
    "rehearse",
    "apply",
    "verify",
    "resume",
)
NAMES = {
    "api": "api",
    "worker": "worker",
    "migrate": "migrate",
    "web": "web",
    "documentEngine": "document-engine",
}
MAX_REQUEST = 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(request, now=None):
    """Validate data only; neither paths nor shell fragments come from requests."""
    now = now or dt.datetime.now(dt.timezone.utc)
    require(request.get("version") == 1, "Unsupported request version")
    require(request.get("repository") == "palcertcom/palcert", "Wrong repository")
    sha = request.get("commit", "")
    require(
        isinstance(sha, str) and re.fullmatch("[a-f0-9]{40}", sha), "Invalid commit"
    )
    for field in ("runId", "attempt"):
        require(
            isinstance(request.get(field), str)
            and re.fullmatch("[1-9][0-9]{0,19}", request[field]),
            "Invalid run identity",
        )
    issued = dt.datetime.fromisoformat(request["issuedAt"].replace("Z", "+00:00"))
    require(-60 <= (now - issued).total_seconds() <= 600, "Expired deployment request")
    authorization = request["authorization"]
    require(
        authorization.get("commit") == sha
        and authorization.get("repository") == request["repository"]
        and type(authorization.get("pullRequest")) is int
        and authorization["pullRequest"] > 0
        and isinstance(authorization.get("mergedBy"), str)
        and re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9-]{0,99}(?:\[bot\])?", authorization["mergedBy"]
        ),
        "Missing merged PR authorization",
    )
    raw = request["manifestText"]
    require(isinstance(raw, str), "Missing manifest bytes")
    manifest = json.loads(raw)
    freeze = request["freeze"]
    staging = request["staging"]
    digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
    require(
        manifest.get("commit") == sha
        and freeze.get("commit") == sha
        and staging.get("commit") == sha,
        "Commit mismatch",
    )
    require(manifest.get("registry") == "ghcr.io", "Wrong registry")
    require(manifest.get("manifestVersion") == 1, "Unsupported manifest version")
    require(
        isinstance(manifest.get("releaseVersion"), str)
        and re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+\+" + sha[:7], manifest["releaseVersion"]
        ),
        "Invalid release version",
    )
    migration = manifest.get("migration", {})
    require(
        type(migration.get("count")) is int
        and migration["count"] > 0
        and re.fullmatch(r"[0-9]{14}_[a-z0-9_]+", migration.get("head", ""))
        and re.fullmatch(r"[a-f0-9]{64}", migration.get("checksum", "")),
        "Invalid migration metadata",
    )

    require(
        set(manifest.get("images", {})) == set(NAMES), "Exactly five images required"
    )
    require(
        freeze.get("manifest", {}).get("digest") == digest
        and staging.get("manifestDigest") == digest,
        "Manifest digest mismatch",
    )
    require(
        staging.get("environment") == "staging"
        and staging.get("outcome") == "success"
        and staging.get("releaseVersion") == manifest.get("releaseVersion")
        and freeze.get("releaseVersion") == manifest.get("releaseVersion")
        and staging.get("workflowRun")
        == f"https://github.com/palcertcom/palcert/actions/runs/{request['runId']}",
        "Missing successful staging evidence from this release run",
    )
    for component, name in NAMES.items():
        image = manifest["images"][component]
        require(
            image.get("repository") == f"palcertcom/palcert-{name}"
            and re.fullmatch("sha256:[a-f0-9]{64}", image.get("digest", "")),
            "Invalid image",
        )
        ref = f"ghcr.io/{image['repository']}@{image['digest']}"
        require(
            freeze.get("images", {}).get(component, {}).get("reference") == ref
            and freeze["images"][component].get("digest") == image["digest"]
            and staging.get("images", {}).get(component) == ref,
            "Substituted image",
        )
    return digest


def github_authority(request, get=None):
    """Recheck public GitHub evidence on the host, including late/stale arrivals."""

    def fetch(path):
        req = urllib.request.Request(
            "https://api.github.com/repos/palcertcom/palcert/" + path,
            headers={
                "User-Agent": "PalCert-deployment-receiver",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    get = get or fetch
    run = get(f"actions/runs/{request['runId']}")
    require(
        run.get("head_sha") == request["commit"]
        and run.get("head_branch") == "main"
        and run.get("event") == "push"
        and run.get("run_attempt") == int(request["attempt"])
        and run.get("path", "").split("@")[0] == ".github/workflows/release.yml",
        "Not the current main Release run",
    )
    require(get("commits/main").get("sha") == request["commit"], "Stale main release")
    pr = get(f"pulls/{request['authorization']['pullRequest']}")
    require(
        pr.get("merged_at")
        and pr.get("merge_commit_sha") == request["commit"]
        and pr.get("base", {}).get("ref") == "main"
        and pr.get("base", {}).get("repo", {}).get("full_name") == "palcertcom/palcert"
        and pr.get("merged_by", {}).get("login")
        == request["authorization"]["mergedBy"],
        "Merge authorization does not match GitHub",
    )
    # Latest execution of EACH job, including successful dependencies retained
    # when only the failed production job is rerun on the same source commit.
    jobs = get(f"actions/runs/{request['runId']}/jobs?filter=latest&per_page=100")
    require(jobs.get("total_count", 0) <= 100, "Job evidence is incomplete")
    for name in ("Build, scan and publish", "Stage the published immutable images"):
        matches = [j for j in jobs["jobs"] if j["name"].split(" / ")[-1] == name]
        require(
            len(matches) == 1 and matches[0].get("conclusion") == "success",
            f"Mandatory release gate has not passed: {name}",
        )


def trusted(path, executable=False):
    """Reject symlinks and any non-root-writable owner/parent, including config."""
    require(path.is_absolute(), "An installed path must be absolute")
    for entry in (path, *path.parents):
        info = entry.lstat()
        require(
            not stat.S_ISLNK(info.st_mode)
            and info.st_uid == 0
            and not info.st_mode & 0o022,
            f"Unsafe ownership/mode: {entry}",
        )
    if executable:
        require(
            path.is_file() and os.access(path, os.X_OK),
            f"Missing executable hook: {path.name}",
        )


def configuration():
    trusted(CONFIG)
    config = json.loads(CONFIG.read_text())
    require(
        config.get("enabled") is True,
        "Production deployment is not enabled on this server",
    )
    trusted(STATE)
    require(STATE.is_dir(), "Deployment state directory is missing")
    for phase in PHASES:
        trusted(HOOKS / phase, executable=True)
    return config


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        tmp = stream.name
    os.replace(tmp, path)


def run_phases(directory, request, state=STATE, runner=None):
    """A pre-drain crash is retryable; after drain, explicit operator recovery is required."""
    require(
        not (state / "blocked.json").exists(),
        "A previous cutover needs operator recovery",
    )
    digest = validate(request)
    current_path = state / "current.json"

    def execute(phase):
        with (directory / f"{phase}.log").open("ab") as log:
            subprocess.run(
                [str(HOOKS / phase), str(directory)],
                check=True,
                cwd="/opt/palcert/docker",
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env={
                    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                    "HOME": "/root",
                    "LANG": "C.UTF-8",
                    "PALCERT_DEPLOY_COMMIT": request["commit"],
                },
            )

    runner = runner or execute
    if current_path.exists():
        current = json.loads(current_path.read_text())
        if current.get("manifestDigest") == digest:
            # Do not replay migrations, backups or financial operations on retry.
            runner("verify")
            return current

    for phase in PHASES:
        # Persist BEFORE attempting drain, including abrupt SSH/host/process loss.
        if phase == "drain":
            atomic_json(
                state / "blocked.json",
                {
                    "commit": request["commit"],
                    "phase": phase,
                    "requestDirectory": str(directory),
                },
            )
        atomic_json(directory / "progress.json", {"phase": phase, "outcome": "running"})
        try:
            runner(phase)
        except Exception:
            atomic_json(
                directory / "progress.json", {"phase": phase, "outcome": "failure"}
            )
            raise RuntimeError(
                f"Deployment stopped at {phase}; inspect root-only server logs"
            ) from None
    receipt = {
        "outcome": "success",
        "commit": request["commit"],
        "manifestDigest": digest,
        "runId": request["runId"],
        "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    atomic_json(directory / "receipt.json", receipt)
    atomic_json(current_path, receipt)
    (state / "blocked.json").unlink()
    return receipt


def main():
    os.umask(0o077)
    require(
        os.geteuid() == 0, "Receiver must be installed as a restricted root command"
    )
    require(len(sys.argv) == 1, "The receiver accepts no command arguments")
    configuration()  # Fail before reading or acting on a request when not installed.
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    require(len(raw) <= MAX_REQUEST, "Request too large")
    request = json.loads(raw)
    validate(request)
    with (STATE / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        github_authority(request)
        directory = Path(
            tempfile.mkdtemp(prefix=f"{request['commit'][:12]}-", dir=STATE)
        )
        atomic_json(directory / "request.json", request)
        (directory / "release-manifest.json").write_text(request["manifestText"])
        atomic_json(directory / "release-freeze.json", request["freeze"])
        atomic_json(directory / "staging-deployment.json", request["staging"])
        print(json.dumps(run_phases(directory, request)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never dump request values, hook output, subprocess env or configuration.
        print(
            f"palcert-deploy: refused ({type(error).__name__}); inspect server configuration and phase logs",
            file=sys.stderr,
        )
        sys.exit(1)
