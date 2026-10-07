"""A disposable local PTY for localhost SSH/tmux tests. No production SSH use."""
import os
import pty
import select
import signal
import sys

pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = sys.argv[1]
    os.execl('/bin/sh', 'sh', '-c', sys.argv[2])

def stop(_signal, _frame):
    raise SystemExit()

signal.signal(signal.SIGTERM, stop)
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin.fileno()], [], [])
        for source in ready:
            try:
                data = os.read(source, 65536)
            except OSError:
                data = b''
            if not data:
                raise SystemExit()
            os.write(sys.stdout.fileno() if source == fd else fd, data)
finally:
    os.close(fd)
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
