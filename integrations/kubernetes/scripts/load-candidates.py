#!/usr/bin/env python3
"""Validate operator-built archive provenance before CI loads/tests/publishes it."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'images/candidates.json').read_text())
inputs=json.loads((root/'images/inputs.json').read_text())
assert manifest['sourceRevision']==inputs['sourceRevision']
assert set(manifest['images'])=={'controller','runner-codex','runner-claude','runner-gemini','lan-proxy'}
assert manifest['registryPrefix']=='ghcr.io/adhn/paperclip-eval'
for name,expected in manifest['inputHashes'].items():
 path=(root/name).resolve()
 assert path.is_relative_to(root)
 assert hashlib.sha256(path.read_bytes()).hexdigest()==expected, name
archives=Path(sys.argv[1]).resolve()
for name,record in manifest['images'].items():
 path=(archives/record['asset']).resolve()
 assert path.parent==archives and path.stat().st_size==record['bytes']
 with path.open('rb') as stream: actual=hashlib.file_digest(stream,'sha256').hexdigest()
 assert actual==record['sha256'],name
 subprocess.run(['docker','load','--input',str(path)],check=True,stdout=subprocess.DEVNULL)
 image=json.loads(subprocess.check_output(['docker','image','inspect',record['localRef']]))[0]
 assert image['Id']==record['imageId'] and image['Architecture']=='amd64'
 labels=image['Config']['Labels']
 assert labels['org.opencontainers.image.source']=='https://github.com/adhn/homelab'
 assert labels['org.opencontainers.image.revision']==manifest['sourceRevision']
print(json.dumps(manifest,indent=2))
