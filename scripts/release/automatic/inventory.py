#!/usr/bin/python3 -I
"""Read-only production inventory. Prints an allowlist, never resolved secrets."""

import json
import os
import re
from pathlib import Path
import subprocess

FILES = [
    "/opt/palcert/docker/docker-compose.production.yml",
    "/etc/palcert/docker-compose.origin-tls.yml",
    "/opt/palcert/docker/docker-compose.ai.yml",
]


class ProbeError(Exception):
    def __init__(self, code, exit_code=None, variables=(), line=None):
        self.details = {"code": code}
        if exit_code is not None:
            self.details["exitCode"] = exit_code
        if variables:
            self.details["requiredVariables"] = sorted(set(variables))
        if line is not None:
            self.details["yamlLine"] = line
        super().__init__(code)


def classify_failure(stderr, exit_code):
    # Only fixed labels and validated variable names/line numbers may leave
    # this function. Docker errors can echo credentials and resolved values.
    variables = re.findall(r"required variable ([A-Za-z_][A-Za-z0-9_]{0,99})\b", stderr)
    if variables:
        return ProbeError("COMPOSE_REQUIRED_VARIABLE_MISSING", exit_code, variables)
    lower = stderr.lower()
    if "unknown flag" in lower or "unknown shorthand flag" in lower:
        return ProbeError("UNSUPPORTED_COMMAND_OPTION", exit_code)
    if "is not a docker command" in lower or "unknown command" in lower:
        return ProbeError("DOCKER_COMPOSE_UNAVAILABLE", exit_code)
    if (
        "cannot connect to the docker daemon" in lower
        or "is the docker daemon running" in lower
    ):
        return ProbeError("DOCKER_DAEMON_UNREACHABLE", exit_code)
    if "permission denied" in lower:
        return ProbeError("PERMISSION_DENIED", exit_code)
    if "no such file or directory" in lower:
        return ProbeError("REFERENCED_FILE_MISSING", exit_code)
    line = re.search(r"yaml: line ([0-9]{1,7}):", lower)
    if line:
        return ProbeError("COMPOSE_YAML_INVALID", exit_code, line=int(line.group(1)))
    return ProbeError("COMMAND_FAILED_DETAILS_WITHHELD", exit_code)


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    except FileNotFoundError:
        raise ProbeError("EXECUTABLE_NOT_FOUND") from None
    except PermissionError:
        raise ProbeError("PERMISSION_DENIED") from None
    except subprocess.TimeoutExpired:
        raise ProbeError("READ_ONLY_COMMAND_TIMED_OUT") from None
    if result.returncode:
        raise classify_failure(result.stderr, result.returncode)
    return result.stdout


def probe(report, stage, action):
    try:
        result = action()
        report["probes"][stage] = {"status": "ok"}
        return result
    except ProbeError as error:
        report["probes"][stage] = {"status": "failed", **error.details}
    except Exception as error:
        # Never stringify the exception: KeyError/JSON errors can include input.
        report["probes"][stage] = {
            "status": "failed",
            "code": "UNEXPECTED_OUTPUT",
            "exceptionType": type(error).__name__,
        }
    return None


def safe_ai_value(key, value):
    value = str(value)
    patterns = {
        "AI_ENABLED": r"(?:true|false)",
        "AI_PRIMARY_PROVIDER": r"(?:anthropic|openai)",
        "ANTHROPIC_MODEL": r"claude-[a-z0-9._:-]{1,90}",
        "ANTHROPIC_TIMEOUT_MS": r"[0-9]{1,9}",
    }
    return (
        value if re.fullmatch(patterns[key], value) else "<unexpected value withheld>"
    )


def summarize_services(config):
    services = {}
    for name, service in config["services"].items():
        # Raw config contains credentials. Do NOT print it, environments or commands.
        services[name] = {
            "image": service.get("image"),
            "networks": list(service.get("networks", {})),
            "mounts": [
                {
                    "type": m.get("type"),
                    "source": m.get("source"),
                    "target": m.get("target"),
                }
                for m in service.get("volumes", [])
            ],
            "ports": [
                {
                    "target": p.get("target"),
                    "published": p.get("published"),
                    "host_ip": p.get("host_ip"),
                }
                for p in service.get("ports", [])
            ],
            "hasHealthcheck": bool(service.get("healthcheck")),
            "hasBuildDefinition": "build" in service,
        }
        if name in ("api", "worker"):
            env = service.get("environment", {})
            services[name]["ai"] = {
                key: safe_ai_value(key, env[key])
                for key in (
                    "AI_ENABLED",
                    "AI_PRIMARY_PROVIDER",
                    "ANTHROPIC_MODEL",
                    "ANTHROPIC_TIMEOUT_MS",
                )
                if key in env
            }
            services[name]["overridesReleaseIdentity"] = any(
                k in env for k in ("APP_COMMIT", "APP_VERSION")
            )
    return services


def file_info(path):
    try:
        info = Path(path).stat()
        return {
            "exists": Path(path).is_file(),
            "mode": oct(info.st_mode & 0o777),
            "ownerUid": info.st_uid,
            "symlink": Path(path).is_symlink(),
        }
    except FileNotFoundError:
        return {"exists": False, "code": "FILE_MISSING"}
    except PermissionError:
        return {"exists": None, "code": "PERMISSION_DENIED"}


def summarize_runtime(containers):
    result = []
    for container in containers:
        config = container.get("Config") or {}
        labels = config.get("Labels") or {}
        if labels.get("com.docker.compose.project") != "palcert-prod":
            continue
        state = container.get("State") or {}
        env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
        identity = env.get("APP_COMMIT", "")
        result.append(
            {
                "name": container.get("Name", "").lstrip("/"),
                "service": labels.get("com.docker.compose.service"),
                "state": state.get("Status"),
                "health": (state.get("Health") or {}).get("Status"),
                "image": config.get("Image"),
                "imageId": container.get("Image"),
                "commit": identity
                if re.fullmatch(r"[a-f0-9]{7,40}", identity)
                else None,
                "composeFiles": labels.get("com.docker.compose.project.config_files"),
                "workingDirectory": labels.get(
                    "com.docker.compose.project.working_dir"
                ),
                "networks": list(
                    (container.get("NetworkSettings") or {}).get("Networks", {})
                ),
                "mounts": [
                    {
                        "type": m.get("Type"),
                        "source": m.get("Source"),
                        "target": m.get("Destination"),
                        "readOnly": not m.get("RW", False),
                    }
                    for m in container.get("Mounts", [])
                ],
                "ports": (container.get("NetworkSettings") or {}).get("Ports", {}),
                "ai": {
                    key: safe_ai_value(key, env[key])
                    for key in (
                        "AI_ENABLED",
                        "AI_PRIMARY_PROVIDER",
                        "ANTHROPIC_MODEL",
                        "ANTHROPIC_TIMEOUT_MS",
                    )
                    if key in env
                },
            }
        )
    return result


def runtime_inventory():
    ids = command(
        [
            "docker",
            "ps",
            "--all",
            "--filter",
            "label=com.docker.compose.project=palcert-prod",
            "--format",
            "{{.ID}}",
        ]
    ).split()
    if not ids:
        return []
    if not all(re.fullmatch(r"[a-f0-9]{12,64}", cid) for cid in ids):
        raise ProbeError("UNEXPECTED_CONTAINER_IDS")
    # Inspect is read-only. Only summarize_runtime's allowlist is printed.
    return summarize_runtime(json.loads(command(["docker", "inspect", *ids])))


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run this read-only inventory with sudo.")
    report = {"inventoryVersion": 2, "project": "palcert-prod", "probes": {}}
    report["protectedFiles"] = {
        path: file_info(path)
        for path in FILES + ["/etc/palcert/production.env", "/etc/palcert/ai.env"]
    }
    report["docker"] = probe(
        report, "docker-client", lambda: command(["docker", "--version"]).strip()
    )
    report["compose"] = probe(
        report,
        "compose-plugin",
        lambda: command(["docker", "compose", "version"]).strip(),
    )
    # Useful even if Compose cannot currently resolve its saved model (for
    # example because the initial launch used image variables in its shell).
    report["runtime"] = probe(report, "running-project", runtime_inventory)
    base = [
        "docker",
        "compose",
        "-p",
        "palcert-prod",
        "--env-file",
        "/etc/palcert/production.env",
    ]
    for file in FILES:
        base += ["-f", file]
    report["services"] = probe(
        report,
        "compose-model",
        lambda: summarize_services(
            json.loads(command(base + ["config", "--format", "json"]))
        ),
    )
    report["disk"] = probe(
        report, "disk", lambda: command(["df", "-h", "/opt/palcert"]).strip()
    )
    report["complete"] = all(
        p["status"] == "ok" for p in report["probes"].values()
    ) and all(p["exists"] is True for p in report["protectedFiles"].values())
    print(json.dumps(report, indent=2))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # An unexpected top-level failure is still identifiable without input.
        raise SystemExit(
            f"Inventory top-level failure ({type(error).__name__}); no raw configuration printed."
        )
