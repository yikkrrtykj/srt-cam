#!/usr/bin/env python3
"""Opt-in, single-channel native SRT stats for an EXISTING Docker Compose relay.

Default is dry-run. --apply backs up the active Compose file, validates it, and
force-recreates only the chosen srt-camN. Use only during an approved test window.
"""
import argparse
import datetime
import json
import pathlib
import re
import shlex
import subprocess
import sys


def run(args, check=True):
    p = subprocess.run(args, text=True, capture_output=True)
    if check and p.returncode:
        raise RuntimeError("command failed: " + " ".join(args) + "\n" + (p.stderr or p.stdout)[-900:])
    return p


def compose_command():
    if run(["docker", "compose", "version"], check=False).returncode == 0:
        return ["docker", "compose"]
    if run(["docker-compose", "version"], check=False).returncode == 0:
        return ["docker-compose"]
    raise RuntimeError("Docker Compose CLI not available")


def update_command(text, cam, live_command):
    # This repo's legacy YAML has one command: scalar per service. Do not parse
    # or rewrite other YAML, anchors, environment variables or service fields.
    boundaries = list(re.finditer(r"(?m)^  srt-cam(?:10|[1-9]):[ \t]*$", text))
    service_name = f"srt-cam{cam}"
    target = next((m for m in boundaries if m.group().strip() == service_name + ":"), None)
    if not target:
        raise ValueError(f"{service_name} service not found")
    idx = boundaries.index(target)
    end = boundaries[idx + 1].start() if idx + 1 < len(boundaries) else len(text)
    block = text[target.start():end]
    if not re.search(rf"(?m)^[ \t]+container_name:[ \t]+{re.escape(service_name)}[ \t]*$", block):
        raise ValueError("unexpected container_name; refusing unsafe edit")
    match = re.search(r'(?m)^([ \t]+command:[ \t]*)([^\n]+)$', block)
    if not match:
        raise ValueError("expected a single-line command scalar, not an unknown YAML layout")
    raw = match.group(2).strip()
    if raw.startswith("["):
        try:
            argv = json.loads(raw)
        except ValueError as exc:
            raise ValueError("unsupported command list") from exc
    elif raw.startswith('"') and raw.endswith('"'):
        argv = shlex.split(json.loads(raw))
    elif raw.startswith("'") and raw.endswith("'"):
        argv = shlex.split(raw[1:-1])
    else:
        argv = shlex.split(raw)
    if len(argv) == 4 and argv[:2] == ["-stats:3000", "-statspf:json"]:
        return text, True
    if len(argv) != 2 or not all(isinstance(x, str) and x.startswith("srt://") for x in argv):
        raise ValueError(f"unexpected {service_name} argv; refusing to replace")
    if live_command != argv:
        raise ValueError(f"running {service_name} command differs from active Compose file")
    new_argv = ["-stats:3000", "-statspf:json"] + argv
    new_block = block[:match.start(2)] + json.dumps(new_argv) + block[match.end(2):]
    return text[:target.start()] + new_block + text[end:], False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cam", type=int, required=True, help="SRT relay channel 1..10")
    ap.add_argument("--apply", action="store_true", help="back up active YAML and recreate only that channel")
    args = ap.parse_args()
    if args.cam not in range(1, 11):
        ap.error("--cam must be 1..10")
    name = f"srt-cam{args.cam}"
    inspect = json.loads(run(["docker", "inspect", name]).stdout)[0]
    if inspect.get("State", {}).get("Running") is not True:
        raise RuntimeError(f"{name} is not running")
    if inspect.get("Config", {}).get("Image") != "local-srt-gateway":
        raise RuntimeError("unexpected image; use manual review")
    labels = inspect.get("Config", {}).get("Labels") or {}
    proj = labels.get("com.docker.compose.project")
    files = (labels.get("com.docker.compose.project.config_files") or "").split(",")
    if not proj or len(files) != 1 or not files[0]:
        raise RuntimeError("Compose project/config path missing or multiple files; manual review required")
    path = pathlib.Path(files[0]).resolve()
    if not path.is_file():
        raise RuntimeError(f"active Compose file not found: {path}")
    old = path.read_text(encoding="utf-8")
    new, already = update_command(old, args.cam, inspect["Config"]["Cmd"])
    if already:
        print(f"PASS: {name} already has -stats:3000 -statspf:json; no restart")
        return
    print(f"Compose project: {proj}\nCompose file: {path}\nTarget: {name}, UDP {21110+args.cam}/{11110+args.cam}")
    print("New flags: -stats:3000 -statspf:json | no SRT URL or latency change")
    if not args.apply:
        print("DRY-RUN PASS: execute again with --apply to recreate ONLY this CAM (short outage expected)")
        return
    cli = compose_command()
    command = cli + ["-p", proj, "-f", str(path)]
    backup = pathlib.Path(str(path) + ".bak.native-stats." +
                          datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.write_text(old, encoding="utf-8")
    print(f"Backup: {backup}")
    path.write_text(new, encoding="utf-8")
    try:
        run(command + ["config", "--quiet"])
        run(command + ["up", "-d", "--no-deps", "--force-recreate", name])
        verify = json.loads(run(["docker", "inspect", name]).stdout)[0]
        argv = verify["Config"]["Cmd"]
        if (verify["State"].get("Running") is not True or argv[:2] != ["-stats:3000", "-statspf:json"]):
            raise RuntimeError("recreated container is not running with stats flags")
    except Exception as exc:
        print(f"FAIL: {exc}\nRestoring old YAML and attempting original CAM recovery.", file=sys.stderr)
        path.write_text(old, encoding="utf-8")
        restore = run(command + ["up", "-d", "--no-deps", "--force-recreate", name], check=False)
        print("ROLLBACK: " + ("PASS" if restore.returncode == 0 else "FAIL: " + restore.stderr[-800:]), file=sys.stderr)
        raise
    print(f"PASS: restarted only {name} with native SRT stats; original YAML preserved at {backup}")
    print(f"When sender and receiver are reconnected: sudo srt-status --srt {args.cam} --minutes 2")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        sys.exit(f"STOP: {exc}")
