"""Seal the operator-reviewed site configuration without editing its originals.

The forced-command account must never get a path from an SSH request to a
user-writable Compose file. The operator prepares this root-only snapshot once;
rollouts consume the snapshot and refuse any drift in the original inputs.
"""

import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path

PROJECT = "palcert-prod"
WORKDIR = Path("/opt/palcert/docker")
SITE = Path("/etc/palcert/deployment-site")
COMPOSE_FILES = (
    WORKDIR / "docker-compose.production.yml",
    Path("/etc/palcert/docker-compose.origin-tls.yml"),
    WORKDIR / "docker-compose.ai.yml",
)
ENV_FILES = (Path("/etc/palcert/production.env"), Path("/etc/palcert/ai.env"))
SERVICES = {
    "api",
    "worker",
    "web",
    "document-engine",
    "migrate",
    "migrate-check",
    "proxy",
    "postgres",
    "redis",
    "minio",
    "clamav",
    "certs",
    "storage-init",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_regular(path):
    """No symlink at any level, no FIFO/device, bounded input, no torn read."""
    path = Path(path)
    require(path.is_absolute(), "absolute source path required")
    for item in (path, *path.parents):
        require(not stat.S_ISLNK(item.lstat().st_mode), "symlink in site input")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError("site input is not a regular file")
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode), "site input is not a regular file")
        require(before.st_size <= 8 * 1024 * 1024, "unexpectedly large site input")
        data = stream.read(8 * 1024 * 1024 + 1)
        after = os.fstat(stream.fileno())

    def signature(s):
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

    require(signature(before) == signature(after), "site input changed during read")
    require(signature(after) == signature(path.lstat()), "site input was replaced")
    require(len(data) == before.st_size, "incomplete site input")
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def compose_base(site=None):
    base = ["docker", "compose", "--project-directory", str(WORKDIR), "-p", PROJECT]
    envs = ENV_FILES if site is None else [site / "env-0", site / "env-1"]
    files = (
        COMPOSE_FILES if site is None else [site / f"compose-{i}.yml" for i in range(3)]
    )
    for path in envs:
        base += ["--env-file", str(path)]
    for path in files:
        base += ["-f", str(path)]
    if site is not None:
        base += ["-f", str(site / "binds.json")]
    return base


def run(args):
    result = subprocess.run(
        args,
        check=True,
        capture_output=True,
        timeout=45,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"},
    )
    return result.stdout


def assert_model(model):
    services = model.get("services", {})
    require(set(services) <= SERVICES, "unreviewed service in site topology")
    require(SERVICES - {"storage-init"} <= set(services), "missing production service")
    for name, config in services.items():
        require(not config.get("build"), "production must not build images")
        require(not config.get("privileged"), "privileged production service")
        require(
            config.get("network_mode") not in ("host", "service:docker"),
            "host network refused",
        )
        for volume in config.get("volumes", []):
            require(
                "docker.sock" not in volume.get("source", ""),
                "Docker socket mount refused",
            )
    for name in ("api", "worker"):
        env = services[name].get("environment", {})
        require(env.get("AI_ENABLED") == "true", "AI must stay enabled")
        require(env.get("AI_PRIMARY_PROVIDER") == "anthropic", "AI provider changed")
        require(env.get("ANTHROPIC_MODEL") == "claude-opus-5", "AI model changed")
        require(
            not any(k in env for k in ("APP_COMMIT", "APP_VERSION")),
            "release identity override",
        )


def reject_external_config(contents):
    # These features can cause Compose to read/execute sources outside the
    # sealed input set. Support one only after explicitly sealing its inputs.
    require(
        not re.search(
            rb"(?m)^\s*(?:include|extends|env_file|configs|secrets|develop|build)\s*:",
            contents,
        ),
        "external Compose inputs require explicit review",
    )


def api_proxy_timeout(contents, seconds):
    require(type(seconds) is int and 180 <= seconds <= 660, "invalid API proxy timeout")
    pattern = rb"(\blocation\s+/api/\s*\{)([^{}]*)(\})"
    matches = list(re.finditer(pattern, contents))
    require(len(matches) == 1, "ambiguous API proxy location")
    match = matches[0]
    body, count = re.subn(
        rb"\bproxy_read_timeout\s+[0-9]+s\s*;",
        f"proxy_read_timeout {seconds}s;".encode(),
        match[2],
    )
    require(count == 1, "ambiguous API timeout directive")
    return contents[: match.start(2)] + body + contents[match.end(2) :]


def seal(site=SITE, execute=run, api_timeout_seconds=300):
    require(not site.exists(), "site snapshot already exists; do not overwrite")
    inputs = {p: read_regular(p) for p in (*COMPOSE_FILES, *ENV_FILES)}
    for path in COMPOSE_FILES:
        reject_external_config(inputs[path])
    model = json.loads(execute(compose_base() + ["config", "--format", "json"]))
    assert_model(model)
    bindings = {}
    overrides = {}
    for name, config in model["services"].items():
        volumes = []
        for volume in config.get("volumes", []):
            if volume.get("type") != "bind":
                continue
            source = Path(volume["source"])
            inputs.setdefault(source, read_regular(source))
            # Explicitly retain the bind's mode/target/flags. Only the source
            # moves to a sealed copy containing identical bytes.
            filename = bindings.setdefault(source, f"bind-{len(bindings)}")
            replacement = dict(volume, source=str(site / filename))
            volumes.append(replacement)
        if volumes:
            overrides[name] = {"volumes": volumes}
    site.mkdir(mode=0o700)
    for i, path in enumerate(COMPOSE_FILES):
        write_private(site / f"compose-{i}.yml", inputs[path])
    for i, path in enumerate(ENV_FILES):
        write_private(site / f"env-{i}", inputs[path])
    for path, filename in bindings.items():
        # Preserve executable scripts used by one-shot containers. Read-only
        # mounted configurations/certificates need to be readable by their
        # original in-container users; the root-only parent protects host access.
        contents = inputs[path]
        if path == WORKDIR / "release-proxy.conf":
            contents = api_proxy_timeout(contents, api_timeout_seconds)
        write_private(site / filename, contents)
        os.chmod(site / filename, stat.S_IMODE(path.stat().st_mode) & 0o755)
    write_private(site / "binds.json", json.dumps({"services": overrides}).encode())
    sealed = json.loads(execute(compose_base(site) + ["config", "--format", "json"]))
    expected = json.loads(json.dumps(model))
    for config in expected["services"].values():
        for volume in config.get("volumes", []):
            if volume.get("type") == "bind":
                volume["source"] = str(site / bindings[Path(volume["source"])])
    require(sealed == expected, "sealed Compose changed more than bind source paths")
    for path, data in inputs.items():
        require(
            read_regular(path) == data, "original configuration changed during sealing"
        )
    # Marker written last. An interrupted preparation is unusable, not a
    # partially valid site. No existing snapshot is deleted or overwritten.
    record = {
        "version": 1,
        "sources": {str(p): sha(data) for p, data in inputs.items()},
        "sealed": {p.name: sha(p.read_bytes()) for p in site.iterdir()},
        "binds": {str(p): filename for p, filename in bindings.items()},
        "apiTimeoutSeconds": api_timeout_seconds,
    }
    write_private(site / "site.json", json.dumps(record, indent=2).encode())
    return record


def trusted(path):
    for item in (path, *path.parents):
        info = item.lstat()
        require(
            not stat.S_ISLNK(info.st_mode)
            and info.st_uid == 0
            and not info.st_mode & 0o022,
            "untrusted sealed configuration directory",
        )


def validate(site=None, trust=trusted):
    site = SITE if site is None else site
    trust(site / "site.json")
    record = json.loads(read_regular(site / "site.json"))
    for name, digest in record["sealed"].items():
        require(Path(name).name == name, "invalid sealed filename")
        path = site / name
        trust(path)
        require(sha(read_regular(path)) == digest, "sealed configuration changed")
    for path, digest in record["sources"].items():
        require(
            sha(read_regular(Path(path))) == digest,
            "original configuration changed; operator review required",
        )
    return record
