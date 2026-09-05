#!/usr/bin/env python3
"""Atomically manage one exact ClawPilot loopback block in a hosts file."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
from typing import NoReturn


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def hostnames(line: str) -> list[str]:
    payload = line.split("#", 1)[0].strip()
    if not payload:
        return []
    fields = payload.split()
    return fields[1:] if len(fields) > 1 else []


def names_domain(line: str, domain: str) -> bool:
    canonical = domain.rstrip(".").casefold()
    return any(
        candidate.rstrip(".").casefold() == canonical
        for candidate in hostnames(line)
    )


def parse(
    lines: list[str], domain: str, begin: str, end: str
) -> tuple[list[str], bool]:
    outside: list[str] = []
    managed: list[str] = []
    inside = False
    blocks = 0

    for line in lines:
        if line == begin:
            if inside:
                fail("Nested ClawPilot hosts markers are not allowed")
            inside = True
            blocks += 1
            if blocks > 1:
                fail("Duplicate ClawPilot hosts blocks are not allowed")
            continue
        if line == end:
            if not inside:
                fail("ClawPilot hosts end marker has no matching begin marker")
            inside = False
            continue
        if names_domain(line, domain) and not inside:
            fail(f"Unmanaged hosts mapping for {domain} must be removed first")
        if inside:
            managed.append(line)
        else:
            outside.append(line)

    if inside:
        fail("ClawPilot hosts begin marker has no matching end marker")

    expected = [f"127.0.0.1 {domain}", f"::1 {domain}"]
    if blocks == 1 and managed != expected:
        fail(
            "ClawPilot hosts block must contain exactly the IPv4 and IPv6 "
            "loopback mappings"
        )
    return outside, blocks == 1


def render(lines: list[str]) -> str:
    return "\n".join(lines).rstrip() + "\n"


def write_atomic(path: Path, content: str) -> None:
    metadata = path.stat()
    descriptor, temporary = tempfile.mkstemp(
        prefix="hosts.clawpilot.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(temporary, metadata.st_mode & 0o7777)
        if os.geteuid() == 0:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    if len(sys.argv) != 6:
        fail(
            "usage: manage-local-development-hosts.py "
            "<enable|disable|verify> <hosts-file> <domain> <begin> <end>"
        )
    action, path_text, domain, begin, end = sys.argv[1:]
    if action not in {"enable", "disable", "verify"}:
        fail("hosts action must be enable, disable, or verify")
    path = Path(path_text)
    lines = path.read_text(encoding="utf-8").splitlines()
    outside, enabled = parse(lines, domain, begin, end)

    if action == "verify":
        if not enabled:
            fail("Exact ClawPilot loopback hosts block is not enabled")
        return

    output = list(outside)
    if action == "enable":
        if output and output[-1] != "":
            output.append("")
        output.extend([begin, f"127.0.0.1 {domain}", f"::1 {domain}", end])
    write_atomic(path, render(output))


if __name__ == "__main__":
    main()
