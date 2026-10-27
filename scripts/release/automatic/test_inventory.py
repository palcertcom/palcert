import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import inventory


def container():
    return {
        "Name": "/palcert-prod-api-1",
        "Image": "sha256:" + "a" * 64,
        "Config": {
            "Image": "ghcr.io/example/api:old",
            "Labels": {
                "com.docker.compose.project": "palcert-prod",
                "com.docker.compose.service": "api",
            },
            "Env": [
                "DATABASE_URL=SECRET_SENTINEL",
                "ANTHROPIC_API_KEY=SECRET_SENTINEL",
                "ANTHROPIC_MODEL=claude-opus-5",
                "APP_COMMIT=b11ea2d",
            ],
            "Cmd": ["SECRET_SENTINEL"],
        },
        "State": {
            "Status": "running",
            "Error": "SECRET_SENTINEL",
            "Health": {"Status": "healthy", "Log": [{"Output": "SECRET_SENTINEL"}]},
        },
        "NetworkSettings": {"Networks": {"palcert-prod_internal": {}}, "Ports": {}},
        "Mounts": [],
    }


class InventoryDiagnosticTests(unittest.TestCase):
    def test_missing_file_does_not_hide_the_report(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(
                inventory.file_info(str(Path(directory) / "missing")),
                {"exists": False, "code": "FILE_MISSING"},
            )

    def test_command_errors_never_echo_values(self):
        cases = [
            (
                "required variable API_IMAGE is missing a value: SECRET_SENTINEL",
                "COMPOSE_REQUIRED_VARIABLE_MISSING",
            ),
            ("unknown flag: --format SECRET_SENTINEL", "UNSUPPORTED_COMMAND_OPTION"),
            (
                "Cannot connect to the Docker daemon SECRET_SENTINEL",
                "DOCKER_DAEMON_UNREACHABLE",
            ),
            (
                "open /private/SECRET_SENTINEL: no such file or directory",
                "REFERENCED_FILE_MISSING",
            ),
            ("yaml: line 24: invalid value SECRET_SENTINEL", "COMPOSE_YAML_INVALID"),
            ("unknown diagnostic SECRET_SENTINEL", "COMMAND_FAILED_DETAILS_WITHHELD"),
        ]
        for message, code in cases:
            with self.subTest(code=code):
                error = inventory.classify_failure(message, 1)
                self.assertEqual(error.details["code"], code)
                self.assertNotIn("SECRET_SENTINEL", json.dumps(error.details))
        error = inventory.classify_failure(cases[0][0], 1)
        self.assertEqual(error.details["requiredVariables"], ["API_IMAGE"])

    def test_timeout_has_no_captured_secret_output(self):
        failure = subprocess.TimeoutExpired(
            ["docker"], 45, output="SECRET_SENTINEL", stderr="SECRET_SENTINEL"
        )
        with patch.object(inventory.subprocess, "run", side_effect=failure):
            with self.assertRaises(inventory.ProbeError) as error:
                inventory.command(["docker", "--version"])
        self.assertEqual(error.exception.details["code"], "READ_ONLY_COMMAND_TIMED_OUT")
        self.assertNotIn("SECRET_SENTINEL", str(error.exception))

    def test_unexpected_shape_names_the_stage_without_echoing_input(self):
        report = {"probes": {}}

        def bad():
            raise KeyError("SECRET_SENTINEL")

        self.assertIsNone(inventory.probe(report, "compose-model", bad))
        self.assertEqual(report["probes"]["compose-model"]["exceptionType"], "KeyError")
        self.assertNotIn("SECRET_SENTINEL", json.dumps(report))

    def test_runtime_whitelist_hides_env_commands_and_health_logs(self):
        runtime = inventory.summarize_runtime([container()])
        self.assertEqual(runtime[0]["commit"], "b11ea2d")
        self.assertEqual(runtime[0]["ai"]["ANTHROPIC_MODEL"], "claude-opus-5")
        self.assertEqual(runtime[0]["health"], "healthy")
        self.assertNotIn("SECRET_SENTINEL", json.dumps(runtime))
        other = container()
        other["Config"]["Labels"]["com.docker.compose.project"] = "another-project"
        self.assertEqual(inventory.summarize_runtime([other]), [])

    def test_partial_config_failure_keeps_real_runtime_and_other_probes(self):
        calls = []

        def run(args):
            calls.append(args)
            if args[:2] == ["docker", "ps"]:
                return "a" * 12
            if args[:2] == ["docker", "inspect"]:
                return json.dumps([container()])
            if "config" in args:
                raise inventory.classify_failure(
                    "required variable API_IMAGE is missing a value: SECRET_SENTINEL", 1
                )
            return "read-only version/disk output"

        output = io.StringIO()
        with (
            patch.object(inventory.os, "geteuid", return_value=0),
            patch.object(inventory, "command", side_effect=run),
            patch.object(
                inventory, "file_info", return_value={"exists": True, "mode": "0o600"}
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(inventory.main(), 1)
        report = json.loads(output.getvalue())
        self.assertFalse(report["complete"])
        self.assertIsNone(report["services"])
        self.assertEqual(report["runtime"][0]["name"], "palcert-prod-api-1")
        self.assertEqual(
            report["probes"]["compose-model"]["requiredVariables"], ["API_IMAGE"]
        )
        self.assertEqual(report["probes"]["disk"]["status"], "ok")
        self.assertNotIn("SECRET_SENTINEL", output.getvalue())
        for args in calls:
            self.assertFalse(
                set(args) & {"up", "down", "restart", "rm", "run", "exec", "pull"}
            )


if __name__ == "__main__":
    unittest.main()
