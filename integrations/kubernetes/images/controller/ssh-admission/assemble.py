"""Assemble the fenced supervisor from the PR #3 subreaper, preserving its loop."""
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent


def sources():
    protocol = (DIRECTORY / 'protocol.py').read_text()
    supervisor = (DIRECTORY.parent / 'ssh-cancellation/supervisor.py').read_text()
    start = supervisor.index('root = Path(sys.argv[1])')
    end = supervisor.index('leader_status = None')
    supervisor = supervisor[:start] + '''fence = Path(sys.argv[1])
if not fence.is_absolute() or fence.resolve() != fence:
    raise ValueError('noncanonical_fence_root')
binding = binding_from(json.loads(sys.argv[3]))
# Descendant ownership must work before a launch authorization is consumed.
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
requested = False

def request_stop(signum, frame):
    global requested
    requested = True

for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, request_stop)

def write_state(name, value):
    durable_store(root / name, {**value, 'binding': binding})

# No implicit initialization. Delayed starts fail if the runner epoch is absent.
with (fence / 'epoch.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    root = attempt_directory(fence, binding, 'start')
    write_state('started.json', {'pid': os.getpid()})
    child = subprocess.Popen(['sh', '-c', sys.argv[2]], start_new_session=True)
    # Epoch takeover cannot interleave between the check and this Popen.
    # stdin is inherited unchanged. Crash after consumption remains uncertain.

''' + supervisor[end:]
    stop = '''import sys
import time
fence = Path(sys.argv[1])
if not fence.is_absolute() or fence.resolve() != fence:
    raise ValueError('noncanonical_fence_root')
binding = binding_from(json.loads(sys.argv[2]))
with (fence / 'epoch.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    root = attempt_directory(fence, binding, 'stop')
    durable_store(root / 'requested', {'binding': binding})
    if not (root / 'started.json').exists():
        # Journal consumption and tombstone share the launch lock; late replay
        # cannot launch. This is exact pre-start prevention, not a process scan.
        durable_store(root / 'stopped.json', {'stopped': True,
                      'reason': 'cancelled_before_start', 'binding': binding})
deadline = time.monotonic() + 12
while time.monotonic() < deadline:
    try:
        receipt = json.loads((root / 'stopped.json').read_text())
        if receipt.get('stopped') is True and receipt.get('binding') == binding:
            print(json.dumps(receipt))
            sys.exit(0)
    except FileNotFoundError:
        pass
    if (root / 'error.json').exists():
        sys.exit('Remote supervisor failed; termination is unverified')
    time.sleep(.05)
sys.exit('Remote termination is unverified: no exact descendant-stop receipt')
'''
    control = '''import sys
epoch_change(Path(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]))
'''
    return {name: protocol + '\n' + code for name, code in
            [('supervisor', supervisor), ('stop', stop), ('epoch', control)]}
