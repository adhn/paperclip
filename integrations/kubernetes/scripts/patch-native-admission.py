#!/usr/bin/env python3
"""Apply candidate native admission ONLY in explicit test build contexts.

Production prepare-controller.py deliberately does not call this script.
Preflight every input before writing anything; do not reapply to patched trees.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 2:
    sys.exit('Usage: patch-native-admission.py EXISTING_TEST_BUILD_CONTEXT')
context = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parents[1] / 'images/controller/admission-native'
manifest = json.loads((overlay / 'manifest.json').read_text())
def require(condition, message):
    # Python -O / PYTHONOPTIMIZE must not remove source/refusal protection.
    if not condition:
        raise RuntimeError(message)

require(subprocess.check_output(['git', '-C', str(context), 'rev-parse', 'HEAD'], text=True).strip() == manifest['sourceRevision'], 'Unexpected source revision')
for name, digest in manifest['baselineSha256'].items():
    require(hashlib.sha256((context / name).read_bytes()).hexdigest() == digest, 'Unexpected baseline: ' + name)
for name, digest in manifest['filesSha256'].items():
    require(hashlib.sha256((overlay / 'source' / name).read_bytes()).hexdigest() == digest, 'Changed candidate: ' + name)
    if name not in manifest['baselineSha256']:
        require(not (context / name).exists(), 'Candidate already exists: ' + name)
for name in manifest['filesSha256']:
    destination = context / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes((overlay / 'source' / name).read_bytes())
for name in manifest['remove']:
    (context / name).unlink()
print('Applied test-only native admission schema and queue-claim integration; production activation remains disabled')
