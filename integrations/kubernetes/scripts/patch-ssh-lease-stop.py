#!/usr/bin/env python3
"""Bind supervisor proof to an exact lease, after the descendant-stop backport."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
context = Path(sys.argv[1]).resolve()
for name, digest in json.loads((root / 'images/controller/ssh-lease-source-sha256.json').read_text()).items():
    assert hashlib.sha256((context / name).read_bytes()).hexdigest() == digest, 'Unexpected post-cancellation source: ' + name
patch = str((root / 'images/controller/ssh-lease-stop.patch').resolve())
subprocess.run(['git', '-C', str(context), 'apply', '--check', patch], check=True)
subprocess.run(['git', '-C', str(context), 'apply', patch], check=True)
print('Applied exact-source SSH lease termination binding')
