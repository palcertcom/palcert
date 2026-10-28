import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import receive
import inventory


def fixture():
    sha = "a" * 40
    images = {
        k: {"repository": f"palcertcom/palcert-{v}", "digest": "sha256:" + str(i) * 64}
        for i, (k, v) in enumerate(receive.NAMES.items())
    }
    manifest = {
        "manifestVersion": 1,
        "migration": {
            "count": 84,
            "head": "20261025000000_financial_service_reports",
            "checksum": "d" * 64,
        },
        "commit": sha,
        "registry": "ghcr.io",
        "releaseVersion": "0.1.0+aaaaaaa",
        "images": images,
    }
    raw = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
    refs = {k: f"ghcr.io/{v['repository']}@{v['digest']}" for k, v in images.items()}
    return {
        "version": 1,
        "repository": "palcertcom/palcert",
        "commit": sha,
        "runId": "123",
        "attempt": "1",
        "issuedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "authorization": {
            "repository": "palcertcom/palcert",
            "commit": sha,
            "pullRequest": 4,
            "mergedBy": "palcertcom",
        },
        "manifestText": raw,
        "freeze": {
            "commit": sha,
            "releaseVersion": "0.1.0+aaaaaaa",
            "manifest": {"digest": digest},
            "images": {
                k: {"reference": v, "digest": images[k]["digest"]}
                for k, v in refs.items()
            },
        },
        "staging": {
            "commit": sha,
            "releaseVersion": "0.1.0+aaaaaaa",
            "environment": "staging",
            "outcome": "success",
            "manifestDigest": digest,
            "images": refs,
            "workflowRun": "https://github.com/palcertcom/palcert/actions/runs/123",
        },
    }


class ReceiverTests(unittest.TestCase):
    def test_accepts_valid_request(self):
        request = fixture()
        self.assertEqual(
            receive.validate(request), request["freeze"]["manifest"]["digest"]
        )

    def test_refuses_tampering(self):
        changes = [
            ("commit", "../escape"),
            ("repository", "foreign/repo"),
            ("runId", "123;sh"),
            ("issuedAt", "2020-01-01T00:00:00+00:00"),
        ]
        for key, value in changes:
            with self.subTest(key=key):
                request = fixture()
                request[key] = value
                with self.assertRaises(ValueError):
                    receive.validate(request)
        for part, key, value in [
            ("staging", "outcome", "failure"),
            ("staging", "environment", "production"),
            ("freeze", "commit", "b" * 40),
            ("staging", "manifestDigest", "bad"),
        ]:
            with self.subTest(part=part, key=key):
                request = fixture()
                request[part][key] = value
                with self.assertRaises(ValueError):
                    receive.validate(request)

    def test_missing_or_substituted_image(self):
        for component in receive.NAMES:
            with self.subTest(component=component):
                request = fixture()
                request["staging"]["images"][component] = (
                    "ghcr.io/palcertcom/palcert-api:latest"
                )
                with self.assertRaises(ValueError):
                    receive.validate(request)
                request = fixture()
                manifest = json.loads(request["manifestText"])
                del manifest["images"][component]
                request["manifestText"] = json.dumps(manifest)
                with self.assertRaises(ValueError):
                    receive.validate(request)

    def test_every_failed_phase_blocks_all_later_phases(self):
        for index, failed_phase in enumerate(receive.PHASES):
            with self.subTest(phase=failed_phase), tempfile.TemporaryDirectory() as tmp:
                state = Path(tmp)
                directory = state / "request"
                directory.mkdir()
                called = []

                def run(phase):
                    called.append(phase)
                    if phase == failed_phase:
                        raise RuntimeError("simulated failure")

                with self.assertRaises(RuntimeError):
                    receive.run_phases(directory, fixture(), state, run)
                self.assertEqual(called, list(receive.PHASES[: index + 1]))
                self.assertFalse((state / "current.json").exists())
                self.assertEqual((state / "blocked.json").exists(), index >= 2)

    def test_success_and_idempotent_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            directory = state / "request"
            directory.mkdir()
            request = fixture()
            phases = []
            first = receive.run_phases(directory, request, state, phases.append)
            self.assertEqual(phases, list(receive.PHASES))
            self.assertFalse((state / "blocked.json").exists())
            phases.clear()
            second = receive.run_phases(
                directory, copy.deepcopy(request), state, phases.append
            )
            self.assertEqual(first, second)
            self.assertEqual(phases, ["verify"])

    def test_failed_cutover_requires_operator_even_for_another_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            (state / "blocked.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "operator"):
                receive.run_phases(
                    state, fixture(), state, lambda _: self.fail("must not execute")
                )

    def test_disabled_server_never_invokes_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"enabled": false}')
            with (
                patch.object(receive, "CONFIG", config),
                patch.object(receive, "trusted"),
            ):
                with self.assertRaisesRegex(ValueError, "not enabled"):
                    receive.configuration()

    def test_server_independently_checks_github(self):
        request = fixture()

        def responses(path):
            if path == "actions/runs/123":
                return {
                    "head_sha": request["commit"],
                    "head_branch": "main",
                    "event": "push",
                    "run_attempt": 1,
                    "path": ".github/workflows/release.yml",
                }
            if path == "commits/main":
                return {"sha": request["commit"]}
            if path == "pulls/4":
                return {
                    "merged_at": "2026-10-27",
                    "merge_commit_sha": request["commit"],
                    "base": {
                        "ref": "main",
                        "repo": {"full_name": "palcertcom/palcert"},
                    },
                    "merged_by": {"login": "palcertcom"},
                }
            return {
                "total_count": 2,
                "jobs": [
                    {"name": "Build, scan and publish", "conclusion": "success"},
                    {
                        "name": "Promote the merged release / Stage the published immutable images",
                        "conclusion": "success",
                    },
                ],
            }

        receive.github_authority(request, responses)

        def failed_gate(path):
            result = responses(path)
            if "jobs" in result:
                result["jobs"][0]["conclusion"] = "failure"
            return result

        with self.assertRaisesRegex(ValueError, "gate"):
            receive.github_authority(request, failed_gate)

        def stale(path):
            return {"sha": "b" * 40} if path == "commits/main" else responses(path)

        with self.assertRaisesRegex(ValueError, "Stale"):
            receive.github_authority(request, stale)

    def test_missing_site_hook_refuses_before_any_cutover(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text('{"enabled": true}')

            def check(path, executable=False):
                if executable:
                    raise FileNotFoundError("site adapter not yet installed")

            with (
                patch.object(receive, "CONFIG", config),
                patch.object(receive, "STATE", Path(tmp)),
                patch.object(receive, "trusted", side_effect=check),
            ):
                with self.assertRaises(FileNotFoundError):
                    receive.configuration()

    def test_ssh_wrapper_refuses_shell_and_scp(self):
        for command in ("", "sh", "scp -t /tmp/payload", "palcert-deploy; id"):
            result = subprocess.run(
                ["sh", str(Path(__file__).with_name("ssh-command.sh"))],
                env={"SSH_ORIGINAL_COMMAND": command},
                capture_output=True,
            )
            self.assertEqual(result.returncode, 64)


if __name__ == "__main__":
    unittest.main()


class InventoryTests(unittest.TestCase):
    def test_whitelist_never_exports_secrets_or_service_commands(self):
        config = {
            "services": {
                "api": {
                    "image": "example/api:previous",
                    "environment": {
                        "ANTHROPIC_API_KEY": "SECRET_SENTINEL",
                        "DATABASE_URL": "SECRET_SENTINEL",
                        "ANTHROPIC_MODEL": "claude-opus-5",
                        "AI_ENABLED": "true",
                    },
                    "command": "SECRET_SENTINEL",
                    "healthcheck": {"test": "SECRET_SENTINEL"},
                }
            }
        }
        report = json.dumps(inventory.summarize_services(config))
        self.assertNotIn("SECRET_SENTINEL", report)
        self.assertNotIn("ANTHROPIC_API_KEY", report)
        self.assertIn("claude-opus-5", report)
        config["services"]["api"]["environment"]["ANTHROPIC_MODEL"] = "SECRET_SENTINEL"
        self.assertNotIn(
            "SECRET_SENTINEL", json.dumps(inventory.summarize_services(config))
        )
