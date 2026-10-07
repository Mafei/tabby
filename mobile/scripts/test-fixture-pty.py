#!/usr/bin/env python3
"""Local test-only PTY. stdin carries JSON controls; stdout is real terminal bytes."""

import base64
import errno
import fcntl
import json
import os
import pty
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


def terminate(pid):
    try:
        os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            return
        time.sleep(0.01)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    pid, master = pty.fork()
    if pid == 0:
        resize(0, rows, cols)
        os.environ["PS1"] = "FIXTURE$ "
        os.execv("/bin/sh", ["/bin/sh", "-i"])
    resize(master, rows, cols)
    # Only nonsecret lifecycle metadata goes to stderr.
    sys.stderr.write(json.dumps({"type": "ptyReady", "pid": pid}) + "\n")
    sys.stderr.flush()
    pending = b""
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
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
