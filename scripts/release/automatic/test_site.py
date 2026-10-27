import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import site_adapter as adapter
import site_config as config


class SealedConfigurationTests(unittest.TestCase):
    def test_only_api_location_timeout_changes(self):
        original = (
            b"server {\nlocation /api/ { proxy_read_timeout 120s; }\n"
            b"location /files/ { proxy_read_timeout 300s; }\n"
            b"location / { proxy_read_timeout 60s; }\n}\n"
        )
        changed = config.api_proxy_timeout(original, 300)
        self.assertEqual(changed, original.replace(b"120s", b"300s"))
        for text in (b"", original + original, b"location /api/ { }"):
            with self.assertRaises(ValueError):
                config.api_proxy_timeout(text, 300)

    def test_inputs_are_regular_files_never_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / "real"
            real.write_bytes(b"private fixture")
            (root / "link").symlink_to(real)
            self.assertEqual(config.read_regular(real), b"private fixture")
            with self.assertRaises(ValueError):
                config.read_regular(root / "link")
            with self.assertRaises(ValueError):
                config.read_regular(root)

    def test_external_compose_inputs_fail_closed(self):
        for keyword in (
            "include",
            "extends",
            "env_file",
            "configs",
            "secrets",
            "develop",
            "build",
        ):
            with self.subTest(keyword=keyword), self.assertRaises(ValueError):
                config.reject_external_config(f"  {keyword}: outside.yml\n".encode())

    def fixture(self, root):
        files = tuple(root / f"original-{i}.yml" for i in range(3))
        envs = tuple(root / f"original-{i}.env" for i in range(2))
        for file in (*files, *envs):
            file.write_bytes(b"VALUE=private$value\n")
        proxy = root / "release-proxy.conf"
        proxy.write_bytes(b"location /api/ { proxy_read_timeout 120s; }\n")
        services = {s: {"image": "fixture:old"} for s in config.SERVICES}
        for name in ("api", "worker"):
            services[name]["environment"] = {
                "AI_ENABLED": "true",
                "AI_PRIMARY_PROVIDER": "anthropic",
                "ANTHROPIC_MODEL": "claude-opus-5",
                "ANTHROPIC_API_KEY": "private$value",
            }
        services["proxy"]["volumes"] = [
            {
                "type": "bind",
                "source": str(proxy),
                "target": "/etc/nginx/conf.d/default.conf",
                "read_only": True,
            }
        ]
        return files, envs, proxy, {"services": services, "name": "palcert-prod"}

    def test_sealing_preserves_originals_and_refuses_later_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files, envs, proxy, model = self.fixture(root)
            site = root / "sealed"
            calls = []

            def docker(args):
                calls.append(args)
                value = copy.deepcopy(model)
                if str(site / "binds.json") in args:
                    value["services"]["proxy"]["volumes"][0]["source"] = str(
                        site / "bind-0"
                    )
                return json.dumps(value).encode()

            with (
                patch.object(config, "COMPOSE_FILES", files),
                patch.object(config, "ENV_FILES", envs),
                patch.object(config, "WORKDIR", root),
            ):
                record = config.seal(site, docker)
            self.assertEqual(
                proxy.read_bytes(), b"location /api/ { proxy_read_timeout 120s; }\n"
            )
            self.assertIn(b"300s", (site / "bind-0").read_bytes())
            self.assertEqual((site / "env-0").read_bytes(), envs[0].read_bytes())
            self.assertEqual(config.validate(site, trust=lambda _: None), record)
            self.assertTrue(
                all(args[-3:] == ["config", "--format", "json"] for args in calls)
            )
            envs[0].write_bytes(b"CHANGED=1\n")
            with self.assertRaisesRegex(ValueError, "original configuration changed"):
                config.validate(site, trust=lambda _: None)
            with self.assertRaisesRegex(ValueError, "already exists"):
                config.seal(site, docker)

    def test_changed_render_never_writes_success_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files, envs, _, model = self.fixture(root)
            site = root / "sealed"
            with (
                patch.object(config, "COMPOSE_FILES", files),
                patch.object(config, "ENV_FILES", envs),
                patch.object(config, "WORKDIR", root),
            ):
                with self.assertRaisesRegex(ValueError, "changed more"):
                    config.seal(site, lambda _: json.dumps(model).encode())
            self.assertFalse((site / "site.json").exists())


class DrainTests(unittest.TestCase):
    def site(self):
        result = adapter.Site.__new__(adapter.Site)
        result.save = Mock()
        result.stop = Mock()
        result.assert_quiet = Mock()
        result.active_work = Mock(return_value=0)
        return result

    def test_pause_then_drain_active_work_before_stopping_worker(self):
        site = self.site()
        events = []
        states = iter(
            [
                {"paused": False, "active": 1},
                {"paused": True, "active": 1},
                {"paused": True, "active": 1},
                {"paused": True, "active": 0},
            ]
        )
        site.queue = lambda action: (events.append(action), next(states))[1]
        site.stop.side_effect = lambda service: events.append("stop:" + service)
        with patch.object(adapter.time, "sleep"):
            site.drain()
        self.assertEqual(
            events,
            [
                "status",
                "pause",
                "stop:proxy",
                "status",
                "status",
                "stop:worker",
                "stop:api",
                "stop:web",
                "stop:document-engine",
            ],
        )
        site.assert_quiet.assert_called_once()

    def test_existing_pause_belongs_to_operator(self):
        site = self.site()
        site.queue = Mock(return_value={"paused": True, "active": 0})
        with self.assertRaises(ValueError):
            site.drain()
        site.stop.assert_not_called()
        self.assertEqual(site.queue.call_count, 1)

    def test_timeout_does_not_kill_workers_or_resume_queue(self):
        site = self.site()
        site.queue = Mock(
            side_effect=[
                {"paused": False},
                {"paused": True},
                {"paused": True, "active": 1},
            ]
        )
        with patch.object(adapter.time, "monotonic", side_effect=[0, 601]):
            with self.assertRaisesRegex(ValueError, "did not drain"):
                site.drain()
        site.stop.assert_called_once_with("proxy")
        site.assert_quiet.assert_not_called()
        self.assertEqual(
            [c.args[0] for c in site.queue.call_args_list],
            ["status", "pause", "status"],
        )

    def test_stop_never_escalates_to_sigkill(self):
        site = adapter.Site.__new__(adapter.Site)
        value = {"Id": "a" * 64, "State": {"Running": True}}
        with (
            patch.object(adapter, "container", return_value=value),
            patch.object(
                adapter, "execute", side_effect=subprocess.TimeoutExpired("docker", 600)
            ) as run,
        ):
            with self.assertRaises(subprocess.TimeoutExpired):
                site.stop("worker")
        self.assertEqual(
            run.call_args.args[0], ["docker", "stop", "--timeout", "-1", "a" * 64]
        )
        self.assertEqual(run.call_count, 1)

    def test_missing_rehearsal_prevents_migration(self):
        site = self.site()
        with tempfile.TemporaryDirectory() as tmp:
            site.directory = Path(tmp)
            site.compose = Mock()
            with self.assertRaises(FileNotFoundError):
                site.apply()
            site.compose.assert_not_called()

    def test_failed_public_check_repauses_and_closes_ingress(self):
        site = self.site()
        with tempfile.TemporaryDirectory() as tmp:
            site.directory = Path(tmp)
            (site.directory / "queue-paused-by-deploy.json").write_text("{}")
            site.request = {"commit": "a" * 40}
            site.compose = Mock()
            site.queue = Mock(return_value={"paused": True})
            with patch.object(site, "wait_public", side_effect=OSError("unreachable")):
                with self.assertRaises(OSError):
                    site.resume()
            site.stop.assert_called_once_with("proxy")
            self.assertEqual(
                [c.args[0] for c in site.queue.call_args_list], ["status", "pause"]
            )


class RunningConfigurationTests(unittest.TestCase):
    def test_disconnected_ai_planning_still_counts_as_active_work(self):
        site = adapter.Site.__new__(adapter.Site)
        with patch.object(adapter, "query", side_effect=["0", "t", "1"]):
            self.assertEqual(site.active_work(), 1)
        with patch.object(adapter, "query", side_effect=["0", "f"]) as sql:
            self.assertEqual(site.active_work(), 0)
            self.assertEqual(sql.call_count, 2)

    def test_live_environment_network_and_storage_drift_are_refused(self):
        site = adapter.Site.__new__(adapter.Site)
        expected = {
            "environment": {"DATABASE_URL": "private-fixture"},
            "networks": {"internal": {}},
            "volumes": [{"type": "volume", "source": "db", "target": "/data"}],
        }
        model = {
            "services": {
                name: expected for name in (*adapter.CORE, *adapter.DATA, "proxy")
            },
            "networks": {"internal": {"name": "reviewed-network"}},
            "volumes": {"db": {"name": "reviewed-db"}},
        }
        live = {
            "Config": {"Env": ["DATABASE_URL=private-fixture", "IMAGE_DEFAULT=ok"]},
            "NetworkSettings": {"Networks": {"reviewed-network": {}}},
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "reviewed-db",
                    "Destination": "/data",
                    "RW": True,
                }
            ],
        }
        with patch.object(adapter, "container", return_value=live):
            site.match_running(model, {"binds": {}})
        for fault in ("environment", "network", "volume", "read-only"):
            changed = copy.deepcopy(live)
            if fault == "environment":
                changed["Config"]["Env"] = ["DATABASE_URL=different-database"]
            elif fault == "network":
                changed["NetworkSettings"]["Networks"]["unexpected-network"] = {}
            elif fault == "volume":
                changed["Mounts"][0]["Name"] = "wrong-db"
            else:
                changed["Mounts"][0]["RW"] = False
            with (
                self.subTest(fault=fault),
                patch.object(adapter, "container", return_value=changed),
                self.assertRaises(ValueError),
            ):
                site.match_running(model, {"binds": {}})

    def test_migration_checksum_failed_history_and_new_schema_are_refused(self):
        policy = {f"2026{i:010d}_fixture": "a" * 64 for i in range(84)}
        rows = [
            {
                "migration_name": n,
                "checksum": c,
                "finished_at": "2026-10-27",
                "rolled_back_at": None,
            }
            for n, c in policy.items()
        ]
        with patch.object(adapter, "migration_policy", return_value=policy):
            for count in (81, 84):
                with patch.object(
                    adapter, "query", return_value=json.dumps(rows[:count])
                ):
                    self.assertEqual(len(adapter.history()), count)
            checksum = copy.deepcopy(rows[:81])
            checksum[0]["checksum"] = "b" * 64
            unfinished = copy.deepcopy(rows[:81])
            unfinished[-1]["finished_at"] = None
            for invalid in (checksum, unfinished, rows[:82], rows[:81] + rows[:1]):
                with (
                    patch.object(adapter, "query", return_value=json.dumps(invalid)),
                    self.assertRaises(ValueError),
                ):
                    adapter.history()

    def test_public_health_waits_for_startup_but_refuses_wrong_commit(self):
        site = adapter.Site.__new__(adapter.Site)
        site.request = {"commit": "a" * 40}
        site.public_health = Mock(
            side_effect=[
                OSError("starting"),
                {"status": "ok", "release": {"commit": "b" * 40}},
            ]
        )
        with (
            patch.object(adapter.time, "sleep"),
            self.assertRaisesRegex(ValueError, "wrong"),
        ):
            site.wait_public()
        self.assertEqual(site.public_health.call_count, 2)


if __name__ == "__main__":
    unittest.main()
