"""Synthetic process cancellation; no remote/runtime/storage authority claim."""
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from production.gateway import Held, canonical
from production.operation_worker import OperationWorker
from production.stream_server import OwnedStreamControl, StreamWorkerHandler
from test_production_stream import (OPEN, CERT, PINS, RUNTIME, STORAGE,
                                    Backend, Native, StreamControl)


class Handler:
    def __init__(self):
        self.counter = 0

    def __call__(self, operation, arguments, deadline):
        if operation == "count":
            self.counter += 1
            return self.counter
        if operation == "block":
            time.sleep(20)
        if operation == "overflow":
            return "x" * 65536
        if operation in ("descendant", "crash-descendant"):
            process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])
            Path(arguments["pid"]).write_text(str(process.pid))
            if operation == "crash-descendant":
                os._exit(1)
            time.sleep(20)
        raise RuntimeError("synthetic_failure")


def handler_factory():
    return Handler()


def stream_factory():
    import hashlib
    events = []
    return StreamWorkerHandler(StreamControl(Native(events), Backend(events), PINS,
        hashlib.sha256(CERT).hexdigest(), "owned-stream", RUNTIME, STORAGE))


class BlockingNative(Native):
    def post(self, path, body):
        time.sleep(20)


def blocked_native_factory():
    import hashlib
    events = []
    return StreamWorkerHandler(StreamControl(BlockingNative(events), Backend(events), PINS,
        hashlib.sha256(CERT).hexdigest(), "blocked-stream", RUNTIME, STORAGE))


class RevokedBackend(Backend):
    def write_exact(self, *args):
        raise Held("revoked_at_effect")


def revoked_stream_factory():
    import hashlib
    events = []
    return StreamWorkerHandler(StreamControl(Native(events), RevokedBackend(events), PINS,
        hashlib.sha256(CERT).hexdigest(), "revoked-stream", RUNTIME, STORAGE))


class WorkerContracts(unittest.TestCase):
    def test_stop_reports_permission_and_io_errors_after_independent_cleanup(self):
        import errno
        import socket
        from unittest.mock import Mock
        for failing in ('group', 'process'):
            with self.subTest(failing=failing):
                parent, child = socket.socketpair()
                self.addCleanup(parent.close)
                self.addCleanup(child.close)
                worker = OperationWorker.__new__(OperationWorker)
                worker._channel, worker._started = parent, True
                worker._poisoned, worker._stopped = False, False
                worker._process = Mock(pid=12345)
                original = OSError(errno.EPERM if failing == 'group' else errno.EIO, 'stop failed')
                if failing == 'process':
                    worker._process.kill.side_effect = original
                with patch('production.operation_worker.os.killpg', side_effect=original if failing == 'group' else None) as killpg:
                    with self.assertRaises(OSError) as caught:
                        worker._stop()
                    self.assertIs(caught.exception, original)
                    worker._stop()
                killpg.assert_called_once_with(12345, signal.SIGKILL)
                worker._process.kill.assert_called_once_with()
                worker._process.join.assert_called_once_with(timeout=0.2)
                self.assertEqual(parent.fileno(), -1)
                self.assertIsNone(worker._channel)

    def test_prestart_failure_closes_both_actual_endpoints_without_pid_action(self):
        import socket
        from unittest.mock import Mock

        class SetupInterrupted(BaseException):
            pass

        for phase in ('process', 'start'):
            with self.subTest(phase=phase):
                parent, child = socket.socketpair()
                self.addCleanup(parent.close)
                self.addCleanup(child.close)
                original = SetupInterrupted(phase)
                process = Mock()
                process.start.side_effect = original
                context = Mock()
                context.Process.side_effect = original if phase == 'process' else None
                context.Process.return_value = process
                with patch('production.operation_worker.socket.socketpair', return_value=(parent, child)), \
                     patch('production.operation_worker.multiprocessing.get_context', return_value=context), \
                     patch('production.operation_worker.os.killpg') as killpg:
                    with self.assertRaises(SetupInterrupted) as caught:
                        OperationWorker(handler_factory)
                self.assertIs(caught.exception, original)
                self.assertEqual(parent.fileno(), -1)
                self.assertEqual(child.fileno(), -1)
                killpg.assert_not_called()
                process.kill.assert_not_called()
                process.join.assert_not_called()

    def test_setup_cleanup_attempts_independent_sockets_and_preserves_error(self):
        import socket
        from unittest.mock import Mock
        parent, child = socket.socketpair()
        self.addCleanup(parent.close)
        self.addCleanup(child.close)
        original = RuntimeError('spawn serialization failed')

        class LostClose:
            def __init__(self, endpoint):
                self.endpoint, self.closes = endpoint, 0

            def setblocking(self, value):
                self.endpoint.setblocking(value)

            def close(self):
                self.closes += 1
                self.endpoint.close()
                raise RuntimeError('endpoint close acknowledgement lost')

        endpoints = (LostClose(parent), LostClose(child))
        context = Mock()
        context.Process.return_value.start.side_effect = original
        with patch('production.operation_worker.socket.socketpair', return_value=endpoints), \
             patch('production.operation_worker.multiprocessing.get_context', return_value=context):
            with self.assertRaises(RuntimeError) as caught:
                OperationWorker(handler_factory)
        self.assertIs(caught.exception, original)
        self.assertEqual([endpoint.closes for endpoint in endpoints], [1, 1])
        self.assertEqual([parent.fileno(), child.fileno()], [-1, -1])

    def test_poststart_failure_stops_actual_owned_process_and_closes_channel(self):
        import multiprocessing
        import socket
        context = multiprocessing.get_context('spawn')
        processes = []
        endpoints = socket.socketpair()
        self.addCleanup(endpoints[0].close)
        self.addCleanup(endpoints[1].close)

        class Context:
            def Process(self, **kwargs):
                process = context.Process(**kwargs)
                processes.append(process)
                return process

        with patch('production.operation_worker.socket.socketpair', return_value=endpoints), \
             patch('production.operation_worker.multiprocessing.get_context', return_value=Context()), \
             patch.object(OperationWorker, '_receive', side_effect=RuntimeError('startup reply lost')):
            with self.assertRaisesRegex(Held, 'worker_start_held'):
                OperationWorker(handler_factory)
        self.assertEqual(len(processes), 1)
        process = processes[0]
        try:
            self.assertFalse(process.is_alive())
            self.assertEqual([endpoint.fileno() for endpoint in endpoints], [-1, -1])
        finally:
            if process.is_alive():
                process.kill()
            process.join(timeout=1)

    def worker(self):
        worker = OperationWorker(handler_factory)
        self.addCleanup(worker.close)
        return worker

    def assert_descendant_stopped(self, pid):
        status = Path(f"/proc/{pid}/stat")
        until = time.monotonic() + 1
        while time.monotonic() < until:
            try:
                state = status.read_text().split()[2]
            except (FileNotFoundError, ProcessLookupError):
                return
            if state == "Z":
                return
            time.sleep(0.01)
        self.fail("owned test descendant remained running")

    def test_persistent_worker_retains_state_and_bounded_messages(self):
        worker = self.worker()
        self.assertEqual(worker.call("count", {}, time.monotonic() + 1), 1)
        self.assertEqual(worker.call("count", {}, time.monotonic() + 1), 2)
        with self.assertRaises(Held):
            worker.call("count", {"large": "x" * 65536}, time.monotonic() + 1)
        self.assertEqual(worker.call("count", {}, time.monotonic() + 1), 3)

    def test_synchronous_backend_timeout_terminates_worker_and_never_replaces(self):
        worker = self.worker()
        started = time.monotonic()
        with self.assertRaises(Held):
            worker.call("block", {}, started + 0.1)
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertFalse(worker._process.is_alive())
        with self.assertRaises(Held):
            worker.call("count", {}, time.monotonic() + 1)

    def test_explicit_cancellation_stops_owned_operation(self):
        worker = self.worker()
        cancelled = threading.Event()
        timer = threading.Timer(0.1, cancelled.set)
        timer.start()
        try:
            with self.assertRaises(Held):
                worker.call("block", {}, time.monotonic() + 2, cancelled)
        finally:
            timer.cancel()
        self.assertFalse(worker._process.is_alive())

    def test_overflow_and_backend_failure_poison_instead_of_replay(self):
        for operation in ("overflow", "fail"):
            worker = self.worker()
            with self.assertRaises(Held):
                worker.call(operation, {}, time.monotonic() + 1)
            self.assertFalse(worker._process.is_alive())
            with self.assertRaises(Held):
                worker.call("count", {}, time.monotonic() + 1)

    def test_worker_group_descendant_is_killed_at_deadline(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / "child"
            with self.assertRaises(Held):
                worker.call("descendant", {"pid": str(pidfile)}, time.monotonic() + 0.3)
            pid = int(pidfile.read_text())
            self.assert_descendant_stopped(pid)

    def test_crashed_adapter_does_not_leave_owned_descendant_running(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / "child"
            with self.assertRaises(Held):
                worker.call("crash-descendant", {"pid": str(pidfile)}, time.monotonic() + 0.3)
            pid = int(pidfile.read_text())
            self.assert_descendant_stopped(pid)

    def test_owned_stream_persists_exact_acquire_write_close_capability(self):
        import base64
        import hashlib
        owner = OwnedStreamControl(stream_factory)
        self.addCleanup(owner.close)
        def call(path, body):
            return owner.dispatch(path, canonical(body), CERT, time.monotonic() + 2)
        reply = call("/v1/stdin/open", OPEN)
        data = b"exact bytes\x00"
        write = dict(handle=reply["handle"], receiptHash=reply["receiptHash"], sequence=0,
                     dataHash=hashlib.sha256(data).hexdigest(), data=base64.b64encode(data).decode())
        self.assertEqual(call("/v1/stdin/write", write)["bytes"], len(data))
        self.assertEqual(call("/v1/stdin/close", dict(handle=reply["handle"],
                         receiptHash=reply["receiptHash"]))["status"], "closed")

    def test_attachment_client_forwards_exact_bytes_through_owned_control(self):
        from production.gateway import Attachment
        owner = OwnedStreamControl(stream_factory)
        self.addCleanup(owner.close)
        class Transport:
            def post(self, path, body):
                return owner.dispatch(path, canonical(body), CERT, time.monotonic() + 2)
        transport = Transport()
        reply = transport.post("/v1/stdin/open", OPEN)
        attachment = Attachment(transport, reply["handle"], reply["receiptHash"])
        self.assertEqual(attachment.write(b"first\x00bytes"), 11)
        self.assertEqual(attachment.write(b"second"), 6)
        attachment.cleanup()

    def test_owned_revoked_write_retains_exact_close_only(self):
        from production.gateway import Attachment
        owner = OwnedStreamControl(revoked_stream_factory)
        self.addCleanup(owner.close)
        class Transport:
            def post(self, path, body):
                return owner.dispatch(path, canonical(body), CERT, time.monotonic() + 2)
        transport = Transport()
        reply = transport.post("/v1/stdin/open", OPEN)
        attachment = Attachment(transport, reply["handle"], reply["receiptHash"])
        with self.assertRaises(Held):
            attachment.write(b"revoked")
        with self.assertRaises(Held):
            attachment.write(b"revoked")
        attachment.cleanup()
        self.assertTrue(owner._worker._process.is_alive())

    def test_native_claim_stream_synchronous_block_is_also_owned(self):
        owner = OwnedStreamControl(blocked_native_factory)
        self.addCleanup(owner.close)
        started = time.monotonic()
        with self.assertRaises(Held):
            owner.dispatch("/v1/stdin/open", canonical(OPEN), CERT, started + 0.1)
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertFalse(owner._worker._process.is_alive())

    def test_stopped_worker_before_request_read_cannot_block_send(self):
        worker = self.worker()
        worker._channel.setsockopt(__import__("socket").SOL_SOCKET, __import__("socket").SO_SNDBUF, 1024)
        os.killpg(worker._process.pid, signal.SIGSTOP)
        started = time.monotonic()
        with self.assertRaises(Held):
            worker.call("count", {"large": "x" * 60000}, started + 0.1)
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertFalse(worker._process.is_alive())

    def test_nonfinite_or_boolean_deadline_refuses_before_dispatch(self):
        worker = self.worker()
        for deadline in (True, float("nan"), float("inf"), "1"):
            with self.assertRaises(Held):
                worker.call("count", {}, deadline)
        self.assertEqual(worker.call("count", {}, time.monotonic() + 1), 1)

    def test_cancelled_lock_wait_does_not_stop_another_owner(self):
        worker = self.worker()
        cancelled = threading.Event()
        worker._lock.acquire()
        timer = threading.Timer(0.05, cancelled.set)
        timer.start()
        try:
            started = time.monotonic()
            with self.assertRaises(Held):
                worker.call("count", {}, started + 2, cancelled)
            self.assertLess(time.monotonic() - started, 0.4)
            self.assertTrue(worker._process.is_alive())
        finally:
            timer.cancel()
            worker._lock.release()
        self.assertEqual(worker.call("count", {}, time.monotonic() + 1), 1)

    def test_partial_reply_body_cannot_block_receive(self):
        worker = self.worker()
        os.killpg(worker._process.pid, signal.SIGSTOP)
        # Inject a complete header plus incomplete body on an independent socket
        # to exercise the same full-frame reader without a cooperating worker.
        import socket
        left, right = socket.socketpair()
        left.setblocking(False)
        original = worker._channel
        worker._channel = left
        try:
            right.sendall(struct.pack("!I", 100) + b"{")
            started = time.monotonic()
            with self.assertRaises(Held):
                worker._receive(started + 0.1, None)
            self.assertLess(time.monotonic() - started, 0.4)
        finally:
            worker._channel = original
            left.close()
            right.close()


if __name__ == "__main__":
    unittest.main()
