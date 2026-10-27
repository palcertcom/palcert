#!/usr/bin/python3 -I
"""Operator-only preparation; never enables deployment or starts services."""

import fcntl
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receive
import site_config


def main():
    os.umask(0o077)
    receive.require(
        os.geteuid() == 0 and len(sys.argv) == 1, "root operator preparation required"
    )
    receive.trusted(receive.CONFIG)
    receive.require(
        json.loads(receive.CONFIG.read_text()).get("enabled") is False,
        "receiver must remain disabled",
    )
    receive.trusted(receive.STATE)
    with (receive.STATE / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receive.require(
            not (receive.STATE / "blocked.json").exists(), "resolve prior cutover first"
        )
        site_config.seal()
    print("Site snapshot prepared; originals unchanged; deployment remains DISABLED.")
    print("Sealed proxy: API read timeout 300s; other locations unchanged.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            f"Site preparation refused ({type(error).__name__}); no secrets printed.",
            file=sys.stderr,
        )
        sys.exit(1)
