"""Bounded local operation ownership, never evidence of remote cancellation.

The caller must supply a protected, importable factory (multiprocessing spawn);
this module does not establish factory provenance or install a listener. The
factory creates all adapters inside the worker, after local process-group setup.
An uncertain call permanently poisons this owner; there is no body replay.
"""
import json
import errno
import math
import multiprocessing
import os
import signal
import select
import socket
import struct
import threading
import time

from production.gateway import Held, canonical


LIMIT = 65536


class _ApplicationRefused(Held):
    pass


def _child_receive(channel):
    def read(size):
        data = bytearray()
        while len(data) < size:
            part = channel.recv(size - len(data))
            if not part:
                raise EOFError()
            data.extend(part)
        return bytes(data)
    size = struct.unpack("!I", read(4))[0]
    if not 0 < size <= LIMIT:
        raise Held("worker_frame_overflow")
    return read(size)


def _child_send(channel, encoded):
    channel.sendall(struct.pack("!I", len(encoded)) + encoded)


def _run(channel, factory):
    try:
        handler = factory()
        _child_send(channel, b'{"ready":true}')
        while True:
            request = json.loads(_child_receive(channel))
            try:
                result = handler(request["operation"], request["arguments"], request["deadline"])
                encoded = canonical({"result": result})
            except Held:
                # Completed application refusal is distinct from lost ownership.
                # StreamControl has already retained ticket/write-held state;
                # exact close-only remains possible in this same adapter.
                encoded = b'{"refused":true}'
            if len(encoded) > LIMIT:
                raise Held("worker_response_overflow")
            _child_send(channel, encoded)
    except BaseException:
        # No backend errors or physical facts are exposed across this boundary.
        try:
            _child_send(channel, b'{"held":true}')
        except BaseException:
            pass
    finally:
        channel.close()


def _serve(channel, factory):
    # Inert session leader anchors PGID while the adapter lives or dies. The
    # adapter never executes in the leader and cannot return its PID for reuse.
    os.setsid()
    _child_send(channel, b'{"group":true}')
    child_pid = os.fork()
    if child_pid == 0:
        try:
            _run(channel, factory)
        finally:
            os._exit(0)
    channel.close()
    os.waitpid(child_pid, 0)
    # Keep group identity reserved after normal/abrupt adapter death until the
    # owning parent terminates us. No factory/body runs in this supervisor.
    while True:
        signal.pause()


class OperationWorker:
    """One persistent owned process group, one in-flight operation, bounded local ownership.

    A deadline/cancel terminates the local process group. This does not retract
    already submitted RPCs or queued remote I/O. Native occupancy and external
    uncertainty must survive worker death, restart and operator inspection.
    Factories/adapters must not escape the owned group or install child daemons.
    """
    def __init__(self, factory, startup_seconds=3):
        if type(startup_seconds) not in (int, float) or not math.isfinite(startup_seconds) or not 0 < startup_seconds <= 3:
            raise Held("bounded_worker_start_required")
        self._lock, self._poisoned, self._stopped = threading.Lock(), False, False
        self._channel, self._process, self._started = None, None, False
        child = None
        try:
            context = multiprocessing.get_context("spawn")
            self._channel, child = socket.socketpair()
            self._channel.setblocking(False)
            self._process = context.Process(target=_serve, args=(child, factory), daemon=True)
            self._process.start()
            self._started = True
            # Detach before close; an ambiguous close must never be retried.
            transferred, child = child, None
            transferred.close()
        except BaseException:
            if child is not None:
                try:
                    child.close()
                except BaseException:
                    pass
            try:
                self._stop()
            except BaseException:
                pass
            raise  # Preserve the original setup failure.
        try:
            startup_deadline = time.monotonic() + startup_seconds
            result = self._receive(startup_deadline, None)
            if result != {"group": True}:
                raise Held("worker_group_held")
            result = self._receive(startup_deadline, None)
            if result != {"ready": True}:
                raise Held("worker_start_held")
        except BaseException:
            try:
                self._stop()
            except BaseException:
                pass
            raise Held("worker_start_held") from None

    def _stop(self):
        self._poisoned = True
        if self._stopped:
            return
        self._stopped = True
        # Inert leader remains alive after adapter crash, reserving group identity.
        # Before setsid, this ID is not a group; killpg safely returns ESRCH.
        # External supervisor death/reaping is outside this local ownership proof;
        # deployment still needs reviewed lifecycle containment, never release.
        first_error = None
        actions = []
        # No numeric PID/group operation unless Process.start returned success.
        if self._started:
            actions.extend(((lambda: os.killpg(self._process.pid, signal.SIGKILL), True),
                            (self._process.kill, True),
                            (lambda: self._process.join(timeout=0.2), False)))
        channel, self._channel = self._channel, None
        if channel is not None:
            actions.append((channel.close, False))
        for action, ignore_oserror in actions:
            try:
                action()
            except BaseException as error:
                if ignore_oserror and isinstance(error, OSError) and error.errno == errno.ESRCH:
                    continue  # Includes ESRCH after an already-dead process.
                if first_error is None:
                    first_error = error
        if first_error is not None:
            raise first_error

    @staticmethod
    def _check(deadline, cancel):
        if type(deadline) not in (int, float) or not math.isfinite(deadline):
            raise Held("finite_operation_deadline_required")
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (cancel is not None and cancel.is_set()):
            raise Held("operation_cancelled_or_expired")
        return remaining

    def _io(self, deadline, cancel, size=None, output=None):
        data = bytearray() if output is None else memoryview(output)
        offset = 0
        while (len(data) if output is None else offset) < (size if output is None else len(data)):
            remaining = self._check(deadline, cancel)
            readable, writable, _ = select.select([self._channel] if output is None else [],
                [self._channel] if output is not None else [], [], min(remaining, 0.02))
            try:
                if readable:
                    part = self._channel.recv(size - len(data))
                    if not part:
                        raise Held("worker_eof")
                    data.extend(part)
                elif writable:
                    count = self._channel.send(data[offset:])
                    if count <= 0:
                        raise Held("worker_send_closed")
                    offset += count
            except BlockingIOError:
                continue
        self._check(deadline, cancel)
        return bytes(data) if output is None else None

    def _receive(self, deadline, cancel):
        size = struct.unpack("!I", self._io(deadline, cancel, size=4))[0]
        if not 0 < size <= LIMIT:
            raise Held("worker_frame_overflow")
        return json.loads(self._io(deadline, cancel, size=size))

    def call(self, operation, arguments, deadline, cancel=None):
        self._check(deadline, cancel)
        deadline = min(deadline, time.monotonic() + 3)
        encoded = canonical(dict(operation=operation, arguments=arguments, deadline=deadline))
        if len(encoded) > LIMIT:
            raise Held("worker_request_overflow")
        # Waiting callers own no submitted effect. Cancel their wait without
        # terminating another caller's in-flight worker or resetting ownership.
        while True:
            remaining = self._check(deadline, cancel)
            if self._lock.acquire(timeout=min(remaining, 0.02)):
                break
        try:
            if self._poisoned:
                raise Held("worker_permanently_held")
            if cancel is not None and cancel.is_set():
                self._stop()
                raise Held("operation_cancelled")
            self._io(deadline, cancel, output=struct.pack("!I", len(encoded)) + encoded)
            response = self._receive(deadline, cancel)
            if response == {"refused": True}:
                raise _ApplicationRefused("worker_application_refused")
            if type(response) is not dict or set(response) != {"result"}:
                raise Held("worker_operation_held")
            return response["result"]
        except _ApplicationRefused:
            raise Held("worker_application_refused") from None
        except BaseException:
            self._stop()
            raise Held("worker_operation_unknown_held") from None
        finally:
            self._lock.release()

    def close(self):
        # Lifecycle owner calls after requests are quiesced. Never implies native
        # release, successful stream close, restoration or remote effect stop.
        if not self._lock.acquire(timeout=3.5):
            raise Held("worker_close_busy_held")
        try:
            self._stop()
        finally:
            self._lock.release()
