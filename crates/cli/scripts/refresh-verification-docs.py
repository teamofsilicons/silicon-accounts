#!/usr/bin/env python3
"""Refresh verification help excerpts from a built accounts CLI, retaining hand-written notes.

Run from anywhere: python3 crates/cli/scripts/refresh-verification-docs.py [path/to/accounts]
The canonical command spellings remain the headings, even when visible aliases are available.
"""
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
binary = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "target/debug/accounts"
reference = root / "docs/reference/cli.md"
env = {**os.environ, "NO_COLOR": "1", "ACCOUNTS_TELEMETRY": "0"}

def help_for(*args):
    return subprocess.check_output([str(binary), *args, "--help"], env=env, text=True)

text = reference.read_text()
root_help = help_for()
tree = root_help.split("Command tree (`accounts <command> --help` explains each one, with examples):\n\n", 1)[1].split("\nDocs bundled in this CLI", 1)[0].rstrip()
text, count = re.subn(r"(## Command tree\n\nAs `accounts --help` prints it:\n\n```text\n).*?(\n```)", lambda m: m[1] + tree + m[2], text, count=1, flags=re.S)
assert count == 1, "command tree marker changed"
for command in ("apps", "proofs", "proofs list", "proofs revoke", "app", "app proof", "app proof user-verification", "app proof app-verification"):
    description = help_for(*command.split()).split("\nUsage:", 1)[0].strip()
    description = "\n\n".join(" ".join(paragraph.splitlines()) for paragraph in description.split("\n\n"))
    pattern = rf"(^#{{3,5}} `accounts {re.escape(command)}`\n\n).*?(\n\n```text\n)"
    text, count = re.subn(pattern, lambda m: m[1] + description + m[2], text, count=1, flags=re.M | re.S)
    assert count == 1, f"section missing: {command}"
reference.write_text(text)
print("Updated command tree and verification help excerpts from", binary)
