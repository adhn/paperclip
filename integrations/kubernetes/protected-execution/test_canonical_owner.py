import concurrent.futures
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from canonical_owner import CanonicalOwner, OwnerError, ROOTS


def group(value=b'original'):
    return {root: value + root.encode() for root in ROOTS}


def crash(directory, phase):
    owner = CanonicalOwner(directory, fault=lambda actual: os._exit(27) if actual == phase else None)
    owner.publish('crashed', 0, group())


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.owner = CanonicalOwner(self.temp.name)

    def tearDown(self):
        self.owner.close()
        self.temp.cleanup()

    def test_whole_group_restart_replay_conflict(self):
        receipt = self.owner.publish('first', 0, group())
        self.assertEqual(set(receipt['roots']), set(ROOTS))
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.publish('first', 0, group()), receipt)
        self.assertEqual(self.owner.inspect('first')['state'], 'published')
        with self.assertRaises(OwnerError):
            self.owner.publish('first', 0, group(b'changed'))

    def test_lifetime_lock(self):
        with self.assertRaises(OwnerError):
            CanonicalOwner(self.temp.name)

    def test_stale_partial_boolean_refuse(self):
        for roots, generation in ((group(), 1), ({'workspace': b'x'}, 0), (group(), True)):
            with self.assertRaises(OwnerError):
                self.owner.publish('bad', generation, roots)
        self.assertEqual(self.owner.inspect('bad'), {'state': 'absent'})

    def test_concurrent_cas(self):
        def publish(number):
            try:
                return self.owner.publish(str(number), 0, group(str(number).encode()))
            except OwnerError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(publish, range(4)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.owner.snapshot()['generation'], 1)

    def test_real_process_crashes_recovery(self):
        self.owner.close()
        for phase in ('group_durable', 'head_durable', 'head_replaced', 'publication_durable'):
            with tempfile.TemporaryDirectory() as directory:
                process = multiprocessing.get_context('fork').Process(target=crash, args=(directory, phase))
                process.start()
                process.join(5)
                if process.is_alive():
                    process.kill()
                    process.join()
                    self.fail('crash child timeout; killed and joined')
                self.assertEqual(process.exitcode, 27)
                owner = CanonicalOwner(directory)
                try:
                    inspected = owner.inspect('crashed')
                    expected = 'uncertain' if phase in ('group_durable', 'head_durable') else 'published'
                    self.assertEqual(inspected['state'], expected)
                    if expected == 'uncertain':
                        with self.assertRaises(OwnerError):
                            owner.publish('crashed', 0, group())
                        with self.assertRaises(OwnerError):
                            owner.publish('different', 0, group())
                        self.assertEqual(owner.snapshot()['generation'], 0)
                    else:
                        self.assertEqual(owner.snapshot()['generation'], 1)
                finally:
                    owner.close()

    def test_corruption_refuses(self):
        receipt = self.owner.publish('first', 0, group())
        path = Path(self.temp.name) / receipt['version'] / 'workspace'
        path.chmod(0o600)
        path.write_bytes(b'corrupt')
        with self.assertRaises(OwnerError):
            self.owner.snapshot()

    def test_private_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory).chmod(0o755)
            with self.assertRaises(OwnerError):
                CanonicalOwner(directory)

    def test_failure_poisoned_retains_intent(self):
        def fault(phase):
            raise OSError('injected')
        self.owner.fault = fault
        with self.assertRaises(OSError):
            self.owner.publish('fault', 0, group())
        with self.assertRaises(OwnerError):
            self.owner.snapshot()
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('fault')['state'], 'uncertain')

    def test_peer_auth_and_unsupported_request(self):
        import socket
        from canonical_owner import serve_connection
        for uid, payload in ((os.getuid() + 1, b'{}'), (os.getuid(), b'{"action":"arbitrary-path-write"}')):
            server, client = socket.socketpair()
            try:
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
                with self.assertRaises(OwnerError):
                    serve_connection(self.owner, server, uid)
            finally:
                server.close()
                client.close()

    def test_actual_socket_reply_loss_retains_commit_and_exact_retry(self):
        import base64
        import json
        import socket
        from canonical_owner import serve_connection
        payload = {'action': 'publish', 'operation_id': 'reply-lost',
                   'expected_generation': 0,
                   'roots': {key: base64.b64encode(value).decode()
                             for key, value in group().items()}}
        server, client = socket.socketpair()
        client.sendall(json.dumps(payload).encode())
        client.shutdown(socket.SHUT_WR)
        client.close()  # lose the reply after sending the complete exact body
        try:
            with self.assertRaises(OSError):
                serve_connection(self.owner, server, os.getuid())
        finally:
            server.close()
        retained = self.owner.inspect('reply-lost')
        self.assertEqual(retained['state'], 'published')
        self.assertEqual(self.owner.snapshot()['generation'], 1)
        server, client = socket.socketpair()
        try:
            client.sendall(json.dumps(payload).encode())
            client.shutdown(socket.SHUT_WR)
            serve_connection(self.owner, server, os.getuid())
            self.assertEqual(json.loads(client.recv(65536))['result'], retained['receipt'])
            self.assertEqual(self.owner.snapshot()['generation'], 1)
        finally:
            server.close()
            client.close()

    def test_persistent_process_owns_multiple_requests(self):
        import base64
        import json
        import socket
        import time
        from canonical_owner import serve
        self.owner.close()
        context = multiprocessing.get_context('fork')
        stop = context.Event()
        endpoint = str(Path(self.temp.name) / 'service.sock')
        process = context.Process(target=serve, args=(self.temp.name, endpoint, os.getuid(), stop))
        process.start()
        try:
            deadline = time.monotonic() + 3
            while not Path(endpoint).exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            def request(payload):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(endpoint)
                    client.sendall(json.dumps(payload).encode())
                    client.shutdown(socket.SHUT_WR)
                    return json.loads(client.recv(65536))
            receipt = request({'action': 'publish', 'operation_id': 'service', 'expected_generation': 0,
                               'roots': {key: base64.b64encode(value).decode() for key, value in group().items()}})
            self.assertEqual(receipt['result']['generation'], 1)
            self.assertEqual(request({'action': 'inspect', 'operation_id': 'service'})['result']['state'], 'published')
        finally:
            stop.set()
            process.join(3)
            if process.is_alive():
                process.kill()
                process.join()
        self.assertEqual(process.exitcode, 0)

    def test_absolute_socket_deadline(self):
        import struct
        from unittest.mock import Mock, patch
        from canonical_owner import serve_connection
        connection = Mock()
        connection.getsockopt.return_value = struct.pack('3i', 1, os.getuid(), 1)
        connection.recv.return_value = b'x'
        with patch('canonical_owner.time.monotonic', side_effect=[10, 11, 12.1]):
            with self.assertRaisesRegex(OwnerError, 'deadline'):
                serve_connection(self.owner, connection, os.getuid())
        self.assertEqual(connection.recv.call_count, 1)

    def test_deny_persistent_inspection_available(self):
        self.owner.publish('before', 0, group())
        with self.assertRaises(OwnerError):
            self.owner.deny(0)
        self.owner.deny(1)
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('before')['state'], 'published')
        with self.assertRaises(OwnerError):
            self.owner.publish('after', 1, group())

    def test_deny_uncertainty_poison_and_restart_hold(self):
        from unittest.mock import patch
        with patch('canonical_owner.sync_directory', side_effect=OSError('injected deny sync failure')):
            with self.assertRaises(OSError):
                self.owner.deny(0)
        with self.assertRaises(OwnerError):
            self.owner.snapshot()
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('missing')['state'], 'absent')
        with self.assertRaises(OwnerError):
            self.owner.publish('after', 0, group())


class TreeOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.owner = CanonicalOwner(self.temp.name)
        from canonical_tree import encode
        self.roots = {root: encode({'schema': 1, 'entries': [
            {'path': '.', 'kind': 'dir', 'mode': 0o700},
            {'path': 'data', 'kind': 'file', 'mode': 0o600, 'data': 'eA=='}]}) for root in ROOTS}

    def tearDown(self):
        self.owner.close()
        self.temp.cleanup()

    def test_trees_actual_materialization_cas_restart_export_and_detachment(self):
        receipt = self.owner.publish_trees('trees', 0, self.roots)
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.publish_trees('trees', 0, self.roots), receipt)
        with tempfile.TemporaryDirectory() as target:
            self.assertEqual(self.owner.export_trees(1, target)['generation'], 1)
            Path(target, 'workspace/data').write_bytes(b'changed attempt')
            canonical = Path(self.temp.name, receipt['version'], 'trees/workspace/data')
            self.assertEqual(canonical.read_bytes(), b'x')
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('stale', 0, self.roots)
        self.assertEqual(self.owner.snapshot()['generation'], 1)

    def external_git_roots(self):
        import base64
        from canonical_tree import encode
        roots = dict(self.roots)
        roots['workspace'] = encode({'schema': 1, 'entries': [
            {'path': '.', 'kind': 'dir', 'mode': 0o700},
            {'path': '.git', 'kind': 'dir', 'mode': 0o700},
            {'path': '.git/config', 'kind': 'file', 'mode': 0o600,
             'data': base64.b64encode(b'[include]\npath=/external/config\n').decode()}]})
        return roots

    def test_new_external_git_refuses_before_intent_and_does_not_poison_owner(self):
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('unsafe', 0, self.external_git_roots())
        self.assertEqual(self.owner.inspect('unsafe'), {'state': 'absent'})
        self.assertFalse(Path(self.temp.name, 'intent-unsafe').exists())
        self.assertEqual(self.owner.publish_trees('safe', 0, self.roots)['generation'], 1)

    def test_retained_legacy_tree_inspection_retry_and_deny_survive_stricter_export_policy(self):
        from unittest.mock import patch
        from canonical_tree import validate
        roots = self.external_git_roots()
        # Simulate the previous structural-only acceptance policy. Physical
        # materialization, intent, HEAD, integrity and receipt logic remain real.
        with patch('canonical_owner.validate_application_subset', validate):
            receipt = self.owner.publish_trees('legacy', 0, roots)
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('legacy'), {'state': 'published', 'receipt': receipt})
        self.assertEqual(self.owner.publish_trees('legacy', 0, roots), receipt)
        with tempfile.TemporaryDirectory() as target:
            with self.assertRaises(OwnerError):
                self.owner.export_trees(1, target)
            self.assertEqual(list(Path(target).iterdir()), [])
        self.assertEqual(self.owner.inspect('legacy')['receipt'], receipt)
        self.owner.deny(1)
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('legacy')['receipt'], receipt)
        self.assertEqual(self.owner.publish_trees('legacy', 0, roots), receipt)
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('new-after-deny', 1, self.roots)

    def test_materialized_integrity_corruption_refuses(self):
        receipt = self.owner.publish_trees('trees', 0, self.roots)
        Path(self.temp.name, receipt['version'], 'trees/session/data').write_bytes(b'bad')
        with self.assertRaises(OwnerError):
            self.owner.inspect('trees')

    def test_tree_format_bound_to_exact_intent(self):
        self.owner.publish_trees('trees', 0, self.roots)
        with self.assertRaises(OwnerError):
            self.owner.publish('trees', 0, self.roots)
        self.assertEqual(self.owner.snapshot()['generation'], 1)

    def test_unsupported_tree_refuses_without_intent(self):
        roots = dict(self.roots, config=b'not a tree')
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('invalid', 0, roots)
        self.assertEqual(self.owner.inspect('invalid'), {'state': 'absent'})

    def test_deny_refuses_new_detached_launch_export(self):
        self.owner.publish_trees('trees', 0, self.roots)
        self.owner.deny(1)
        with tempfile.TemporaryDirectory() as target:
            with self.assertRaises(OwnerError):
                self.owner.export_trees(1, target)
            self.assertEqual(list(Path(target).iterdir()), [])
        self.assertEqual(self.owner.inspect('trees')['state'], 'published')

    def test_tree_failure_retains_global_uncertain_intent(self):
        self.owner.fault = lambda phase: (_ for _ in ()).throw(OSError('fault'))
        with self.assertRaises(OSError):
            self.owner.publish_trees('trees', 0, self.roots)
        self.owner.close()
        self.owner = CanonicalOwner(self.temp.name)
        self.assertEqual(self.owner.inspect('trees')['state'], 'uncertain')
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('other', 0, self.roots)

    def test_export_inside_canonical_tree_refuses_before_mutation(self):
        from canonical_tree import encode
        roots = dict(self.roots)
        roots['workspace'] = encode({'schema': 1, 'entries': [
            {'path': '.', 'kind': 'dir', 'mode': 0o700},
            {'path': 'empty', 'kind': 'dir', 'mode': 0o700}]})
        receipt = self.owner.publish_trees('trees', 0, roots)
        destination = Path(self.temp.name, receipt['version'], 'trees/workspace/empty')
        with self.assertRaises(OwnerError):
            self.owner.export_trees(1, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertEqual(self.owner.snapshot()['generation'], 1)

    def test_export_refuses_symlink_member_or_ancestor_before_mutation(self):
        self.owner.publish_trees('trees', 0, self.roots)
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            target = parent / 'real'
            target.mkdir(mode=0o700)
            (parent / 'alias').symlink_to(target, target_is_directory=True)
            for destination in (parent / 'alias', parent / 'alias' / 'child'):
                if destination.name == 'child':
                    (target / 'child').mkdir(mode=0o700)
                with self.subTest(destination=destination), self.assertRaises(OwnerError):
                    self.owner.export_trees(1, destination)
            self.assertEqual(list(target.iterdir()), [target / 'child'])
            self.assertEqual(list((target / 'child').iterdir()), [])
        self.assertEqual(self.owner.inspect('trees')['state'], 'published')

    def test_export_refuses_lexical_aliases_before_mutation(self):
        self.owner.publish_trees('trees', 0, self.roots)
        with tempfile.TemporaryDirectory() as parent:
            for destination in (parent + '/.', parent + '//', parent + '/../' + Path(parent).name,
                                '/' + parent, 'relative/path'):
                with self.subTest(destination=destination), self.assertRaises(OwnerError):
                    self.owner.export_trees(1, destination)
            self.assertEqual(list(Path(parent).iterdir()), [])

    def test_export_materialization_stays_on_opened_descriptor_after_name_replacement(self):
        from unittest.mock import patch
        from production.descriptor_paths import open_directory
        self.owner.publish_trees('trees', 0, self.roots)
        with tempfile.TemporaryDirectory() as parent:
            parent = Path(parent)
            original, moved, other = (parent / name for name in ('original', 'moved', 'other'))
            original.mkdir(mode=0o700)
            other.mkdir(mode=0o700)
            def replaced(path):
                fd = open_directory(path)
                original.rename(moved)
                original.symlink_to(other, target_is_directory=True)
                return fd
            with patch('canonical_owner.open_directory', side_effect=replaced):
                self.owner.export_trees(1, original)
            self.assertEqual(list(other.iterdir()), [])
            self.assertEqual(set(p.name for p in moved.iterdir()), set(ROOTS))
            self.assertEqual((moved / 'workspace/data').read_bytes(), b'x')
            self.assertEqual(self.owner.snapshot()['generation'], 1)

    def test_failed_export_path_walk_releases_intermediate_descriptors(self):
        self.owner.publish_trees('trees', 0, self.roots)
        with tempfile.TemporaryDirectory() as parent:
            destination = Path(parent) / 'absent' / 'child'
            before = set(os.listdir('/proc/self/fd'))
            for _ in range(10):
                with self.assertRaises(OwnerError):
                    self.owner.export_trees(1, destination)
            self.assertEqual(set(os.listdir('/proc/self/fd')), before)

    def test_new_nested_git_metadata_refuses_before_intent_and_preserves_prior(self):
        from canonical_tree import encode
        receipt = self.owner.publish_trees('accepted', 0, self.roots)
        unsafe = encode({'schema': 1, 'entries': [
            {'path': '.', 'kind': 'dir', 'mode': 0o700},
            {'path': '.git', 'kind': 'dir', 'mode': 0o700},
            {'path': '.git/nested', 'kind': 'dir', 'mode': 0o700},
            {'path': '.git/nested/.git', 'kind': 'dir', 'mode': 0o700}]})
        roots = dict(self.roots, workspace=unsafe)
        with self.assertRaises(OwnerError):
            self.owner.publish_trees('rejected', 1, roots)
        self.assertEqual(self.owner.inspect('rejected'), {'state': 'absent'})
        self.assertEqual(self.owner.inspect('accepted')['receipt'], receipt)
        self.assertEqual(self.owner.snapshot()['generation'], 1)
