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


def command(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(
            "Inventory command failed; no configuration output was printed"
        )
    return result.stdout


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


def main():
    if os.geteuid() != 0:
        raise RuntimeError(
            "Run through sudo to read the existing root-only compose inputs"
        )
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
    config = json.loads(command(base + ["config", "--format", "json"]))
    report = {
        "project": "palcert-prod",
        "services": summarize_services(config),
        "protectedFiles": {
            p: {
                "exists": Path(p).is_file(),
                "mode": oct(Path(p).stat().st_mode & 0o777),
            }
            for p in FILES + ["/etc/palcert/production.env", "/etc/palcert/ai.env"]
        },
        "docker": command(["docker", "--version"]).strip(),
        "compose": command(["docker", "compose", "version"]).strip(),
        "disk": command(["df", "-h", "/opt/palcert"]).strip(),
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit(
            "Inventory could not complete. Check Docker, file paths and sudo; no secrets printed."
        )
