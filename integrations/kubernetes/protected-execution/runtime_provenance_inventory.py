"""Bounded retained-file inventory only: never query hosts or invoke runtimes.

Hashing a source/build candidate does not verify its provenance or relationship
to a saved binary hash. No archive unpack, directory walk, subprocess or network.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

MAX_FILES = 32
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
_EVAL = '.work/homelab-admission/clusters/homelab/infrastructure/paperclip-evaluation/'
_RETAINED = '.handoff-state/2026-10-20/retirement-design/'
DEFAULT_ARTIFACTS = tuple((name, 'saved-observation') for name in (
    *(_RETAINED + 'runtime-host-' + host + '.json' for host in ('think1', 'think2', 'think3')),
    _RETAINED + 'runtime-host-checkpoint.json', _RETAINED + 'runtime-current-inventory.json',
    _EVAL + 'docs/runtime-host-inventory-2026-10-20.md',
    _EVAL + 'docs/runtime-current-inventory-2026-10-20.md',
)) + ((_RETAINED + 'runtime-host-probe.py', 'observation-collector-source'),)
CLASSES = frozenset({'saved-observation', 'observation-collector-source',
                     'runtime-source-candidate', 'build-provenance-candidate'})
MISSING_INPUTS = (
    'immutable snap8702 source/build manifest and authenticated binary mapping',
    'exact containerd1.6.36 fork/commit/patches/toolchain and dependencies',
    'exact runc and runc-v2 shim source/build mapping',
    'kata actual binary/source/version/handler and recovery implementation',
    'NVIDIA actual wrapper/source/version and runtime effect chain',
    'think3 second-daemon service/executable/source/config/client ownership',
    'complete lower-shim socket/client/old-incarnation and boot recovery map',
)


class InventoryError(ValueError):
    pass


def _parts(path):
    if (type(path) is not str or not path or len(path) > 1024
            or path.startswith('/') or '\\' in path or '\x00' in path):
        raise InventoryError('relative retained path required')
    parts = path.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise InventoryError('noncanonical retained path')
    return parts


def _read(root_fd, path):
    """Open beneath trusted root; refuse symlink components and special files."""
    parts = _parts(path)
    parent = os.dup(root_fd)
    descriptor = None
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE_BYTES:
            raise InventoryError('regular bounded artifact required')
        chunks = []
        count = 0
        while count <= MAX_FILE_BYTES:
            chunk = os.read(descriptor, min(65536, MAX_FILE_BYTES + 1 - count))
            if not chunk:
                break
            chunks.append(chunk); count += len(chunk)
        after = os.fstat(descriptor)
        if (count > MAX_FILE_BYTES or count != before.st_size or
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise InventoryError('artifact changed or oversized')
        return b''.join(chunks)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise InventoryError('artifact unavailable or unsafe') from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def inventory(root, artifacts=DEFAULT_ARTIFACTS):
    """Hash explicitly selected files, never discover or certify runtime source.

    Root is a trusted local workspace root supplied by the operator. Input classes
    are labels; all runtime-source/build candidates remain unverified even if
    present. Missing selection is not a claim of absence elsewhere/on archives.
    """
    if type(artifacts) not in (tuple, list) or not 1 <= len(artifacts) <= MAX_FILES:
        raise InventoryError('bounded explicit artifact selection required')
    seen = set()
    for item in artifacts:
        if type(item) not in (tuple, list) or len(item) != 2:
            raise InventoryError('artifact and class required')
        path, category = item
        _parts(path)
        if type(category) is not str or category not in CLASSES or path in seen:
            raise InventoryError('unknown class or duplicate artifact')
        seen.add(path)
    descriptor = os.open(Path(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    rows, total = [], 0
    try:
        for path, category in sorted(artifacts):
            data = _read(descriptor, path)
            row = dict(path=path, category=category, status='missing' if data is None else 'retained',
                       verifiedRuntimeProvenance=False)
            if data is not None:
                total += len(data)
                if total > MAX_TOTAL_BYTES:
                    raise InventoryError('aggregate byte bound exceeded')
                row.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            rows.append(row)
    finally:
        os.close(descriptor)
    return dict(kind='retained-runtime-inventory-v1', scope='explicit local retained artifacts only',
                files=rows, totalBytes=total, runtimeProvenanceVerified=False,
                operationalAcceptance=False, requiredUnverifiedInputs=list(MISSING_INPUTS))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='trusted local Paperclip workspace')
    parser.add_argument('--candidate', action='append', default=[], metavar='CLASS:RELATIVE_PATH')
    args = parser.parse_args()
    artifacts = list(DEFAULT_ARTIFACTS)
    for candidate in args.candidate:
        category, separator, path = candidate.partition(':')
        if not separator:
            parser.error('candidate requires CLASS:RELATIVE_PATH')
        artifacts.append((path, category))
    try:
        result = inventory(args.root, artifacts)
    except (InventoryError, OSError) as error:
        parser.exit(2, 'inventory refused: ' + str(error) + '\n')
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
