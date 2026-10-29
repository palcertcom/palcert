"""Repair the 2026-10-29 public-health identity incident only.

Pins the reviewed adapter patch, checks the blocked release and rehearsal,
then resumes without rerunning migrations. All checks must pass before clearing
its block. This is deliberately not a general recovery or rollback command.
"""

import ast
import datetime as dt
import fcntl
import hashlib
import json
import os
import stat
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.error import HTTPError

os.umask(0o077)
sys.dont_write_bytecode = True
sys.path.insert(0, "/usr/local/lib/palcert-deploy")
import receive

state = Path("/var/lib/palcert-deploy")
folder = state / "1bebb4a82059-mjh6hltv"
commit = "1bebb4a82059f74fdccf9903b293331904060746"
target = Path("/usr/local/lib/palcert-deploy/site_adapter.py")
old_hash = "83b5a248669bc4c20522808c814ebefd4907931fd0ef4fd40938d86b5aae6a11"
new_hash = "c046334ce1b2af590432e9073c99fd79c7d18850035d499953eebf0af86308cd"
source = (
    "https://raw.githubusercontent.com/palcertcom/palcert/"
    "d3cf9ca40fd1fe3a160939a0ffaa31dcc8c36d43/"
    "scripts/release/automatic/site_adapter.py"
)
stage = "checks"
try:
    with (state / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        blocked = json.loads((state / "blocked.json").read_text())
        progress = json.loads((folder / "progress.json").read_text())
        receive.require(
            blocked["commit"] == commit and blocked["requestDirectory"] == str(folder),
            "Different blocked deployment",
        )
        receive.require(
            progress == {"phase": "resume", "outcome": "failure"},
            "Unexpected deployment phase",
        )
        proof = json.loads((folder / "rehearsal-passed.json").read_text())
        receive.require(
            proof["commit"] == commit and (folder / "backup.json").is_file(),
            "Missing backup or rehearsal evidence",
        )

        stage = "install"
        receive.trusted(target)
        original = target.read_bytes()
        actual_hash = hashlib.sha256(original).hexdigest()
        receive.require(
            actual_hash in (old_hash, new_hash), "Installed adapter differs"
        )
        if actual_hash != new_hash:
            request = urllib.request.Request(
                source, headers={"User-Agent": "PalCert-Deployment/1.0"}
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                replacement = response.read(131073)
            receive.require(
                hashlib.sha256(replacement).hexdigest() == new_hash,
                "Downloaded file checksum mismatch",
            )
            ast.parse(replacement)
            backup = folder / "site-adapter.before-identity.py"
            if backup.exists():
                receive.require(backup.read_bytes() == original, "Backup differs")
            else:
                backup.write_bytes(original)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temp:
                temp.write(replacement)
                temp.flush()
                os.fsync(temp.fileno())
                os.fchmod(temp.fileno(), stat.S_IMODE(target.stat().st_mode))
                temporary = temp.name
            os.replace(temporary, target)
        print("ADAPTER_UPDATED", flush=True)

        import site_adapter as adapter

        site = adapter.Site(folder)
        receive.require(site.request["commit"] == commit, "Different requested release")
        stage = "verify"
        site.verify()
        print("INTERNAL_VERIFICATION_OK", flush=True)
        stage = "resume"
        site.resume()
        stage = "record"
        receipt = {
            "outcome": "success",
            "commit": commit,
            "manifestDigest": "sha256:"
            + hashlib.sha256(site.request["manifestText"].encode()).hexdigest(),
            "runId": site.request["runId"],
            "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        receive.atomic_json(folder / "receipt.json", receipt)
        receive.atomic_json(state / "current.json", receipt)
        receive.atomic_json(
            folder / "progress.json", {"phase": "resume", "outcome": "success"}
        )
        (state / "blocked.json").unlink()
        print("RECOVERY_SUCCESS", flush=True)
except Exception as error:
    print("STOPPED_AT =", stage, type(error).__name__, flush=True)
    if isinstance(error, HTTPError):
        print("HTTP_STATUS =", error.code, flush=True)
    elif isinstance(error, ValueError):
        print("DETAIL =", str(error), flush=True)
    raise SystemExit(1)
