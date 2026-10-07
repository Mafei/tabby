#!/usr/bin/env python3
"""Local test-only PTY. stdin carries JSON controls; stdout is real terminal bytes."""

import base64
import errno
import fcntl
import json
import os
import select
import signal
import struct
import sys
import termios
import time


def resize(fd, rows, cols):
    rows = max(1, min(1000, int(rows)))
    cols = max(1, min(1000, int(cols)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def signal_child(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        # A cancellation can precede login_tty creating the child's group.
        # The unreaped child is still ours, so its PID cannot have been reused.
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def reap_until(pid, deadline):
    while time.monotonic() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done:
            return True
        time.sleep(0.01)
    return False


def terminate(pid):
    signal_child(pid, signal.SIGHUP)
    if not reap_until(pid, time.monotonic() + 0.5):
        signal_child(pid, signal.SIGKILL)
        if not reap_until(pid, time.monotonic() + 0.5):
            raise RuntimeError("PTY child did not terminate")


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False

    # Node can send SIGTERM as soon as the helper is spawned. Install before
    # fork so every parent-side startup cancellation reaches owned cleanup.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    master, slave = os.openpty()
    try:
        # Initialize before either process can accept a later window-change.
        resize(slave, rows, cols)
        pid = os.fork()
    except BaseException:
        os.close(master)
        os.close(slave)
        raise
    if pid == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.close(master)
        # Establish the session, controlling terminal and standard descriptors.
        # login_tty also closes the original slave descriptor.
        os.login_tty(slave)
        os.environ["PS1"] = "FIXTURE$ "
        os.execv("/bin/sh", ["/bin/sh", "-i"])
    try:
        os.close(slave)
        # Only nonsecret lifecycle metadata goes to stderr.
        sys.stderr.write(json.dumps({"type": "ptyReady", "pid": pid}) + "\n")
        sys.stderr.flush()
        pending = b""
        while running:
            readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                pending += data
                if len(pending) > 1024 * 1024:
                    raise ValueError("PTY control too large")
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    command = json.loads(line)
                    if command["type"] == "input":
                        payload = base64.b64decode(command["data"], validate=True)
                        view = memoryview(payload)
                        while view:
                            written = os.write(master, view)
                            view = view[written:]
                    elif command["type"] == "resize":
                        resize(master, command["rows"], command["cols"])
                    elif command["type"] == "stop":
                        running = False
    finally:
        os.close(master)
        terminate(pid)


if __name__ == "__main__":
    main()
