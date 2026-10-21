"""Request stop and return success only after the owning supervisor reaps all children."""
import fcntl
import json
from pathlib import Path
import sys
import time

root = Path(sys.argv[1])
root.mkdir(mode=0o700, parents=True, exist_ok=True)
with (root / 'lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    (root / 'requested').touch(mode=0o600)
    if not (root / 'started.json').exists():
        # The startup lock prevents a provider from slipping past this tombstone.
        (root / 'stopped.json').write_text(json.dumps({'stopped': True, 'reason': 'cancelled_before_start'}))
deadline = time.monotonic() + 12
while time.monotonic() < deadline:
    try:
        receipt = json.loads((root / 'stopped.json').read_text())
        if receipt.get('stopped') is True:
            print(json.dumps(receipt))
            sys.exit(0)
    except FileNotFoundError:
        pass
    if (root / 'error.json').exists():
        sys.exit('Remote supervisor failed; termination is unverified')
    time.sleep(0.05)
sys.exit('Remote termination is unverified: no descendant-stop receipt within 12 seconds')
