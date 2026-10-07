# SSH tmux desktop recovery (phase 1)

Scope: existing Electron Windows/Linux/macOS architecture; remote Unix tmux,
current authenticated account and explicitly chosen default, named or path socket.
No installation on remote hosts, cloud service, credential sync or new password store.
SSH authentication and host-key prompts remain Tabby's existing flow.

## Flow and ownership

After authentication, a bounded no-PTY exec channel detects tmux and lists sessions.
A modal offers ordinary SSH, an existing session, or an explicitly named new session.
Creation is single-flight and uses `new-session -d`, never `-A`; the server's atomic
result decides duplicates. Names are quoted shell arguments; controls, dots and
colons are rejected for new names. Existing names are transported as UTF-8 hex and
rendered as escaped text. Session IDs, not names, are targets.

A binding belongs to one tab/shell channel, never the SSH profile or shared transport.
It contains endpoint, verified host-key fingerprint, resolved authenticated username,
Unix UID, canonical socket path, server PID/start time, session ID/creation time,
attachment mode and tab UUID. The default socket is resolved on the remote host.
Server PID/start time are conservative lifecycle markers, not cryptographic fencing.
Duplicate bindings focus the existing tab. `includeState:true` saves the binding;
Duplicate without that option starts selection again. Only tabs saved by existing
TabRecoveryService are restored. A renamed session retains identity; a missing,
recreated or restarted server/session stops restoration with an error, never creation.
A restore cannot preserve processes across server reboot; ordinary SSH reconnect starts
a new shell. Existing tmux programs receive neither login scripts nor cwd commands.
New sessions may use tmux `-c` for cwd.

Occupied sessions offer shared, read-only, or explicit takeover (`attach-session -d`).
Automatic restoration/retry stops for an occupied session and requests a choice.
Automatic attachment never uses `-d`; this avoids mutual eviction but is not strict
exclusion and does not permanently revoke the old client. Identity and occupancy are
checked again immediately before attach. tmux has no cross-server fencing transaction;
a server replacement between check and attach remains a narrow race.

## Execution and retry

Subscribe before requestExec. Random nonce start/end frames and command status isolate
login noise without relying on unavailable russh exit-status events. Bound time,
stdout/stderr bytes and cancellation; reject truncated, invalid or incomplete frames.
Numeric metadata is parsed strictly and names are hex encoded.

Transport loss is recorded before deferred SSH destruction; shell EOF/close, user
Disconnect, detach/takeover and local last-reference destruction are distinct.
Only transport loss schedules exponential backoff with jitter. A per-tab single-flight
connection and cancellation generation prevent stale completion/events from changing
new state. Auth/host-key rejection, missing tmux/session and occupancy stop retry.
Explicit reconnect may retry; creation is never replayed after an uncertain outcome.

Embedded keyboard-interactive prompts belong to the SSH transport and are rejected
on destruction as well as cleared from the tab on cancellation. Destroy also releases
the native client handle: russh's pending keyboard-interactive response wait can
ignore Disconnect, so retaining the handle would keep the cancelled callback/session
cycle alive. Shell acquisition
(open/activation, PTY, X11 and agent requests) has a 10-second deadline and responds
to shell or transport cancellation. A late acquired channel is activated only for
cleanup and never starts a shell. Shell/exec startup requests are also bounded.
Jump-host destruction explicitly propagates transport loss to its dependent targets;
target cancellation is registered before jump lookup/authentication and direct-tcpip
acquisition. Forward acquisition has the same deadline/cancellation boundary and
late cleanup; rejection and target startup failure release the jump reference.
russh retains its client mutex during native channel-open requests. An abandoned
request temporarily excludes that transport from new multiplexed acquisitions;
reconnect authenticates a fresh transport while existing tabs keep the old one.
The exclusion ends when the native request settles, and a late channel is closed.
The wrapper cannot forcibly cancel that native request while preserving other tabs.
local teardown remains distinct. Native teardown, resize and write rejections after
TCP loss are consumed.

## Acceptance cases

- Detect missing tmux, empty server, default/named/path socket and invalid metadata.
- Quote spaces, quotes, shell substitutions and Unicode; reject controls and illegal
  new names; existing arbitrary names remain display-only data.
- Atomic duplicate creation and concurrent create produce one session; button single-flight.
- Choose existing/new/plain SSH; repeated same binding focuses one tab; different
  endpoint/account/socket/server identities remain separate.
- Restore last-open tabs; rename succeeds; same-name replacement, missing session,
  reboot and changed host key/account fail. Duplicate has no saved binding.
- Shared/read-only/takeover are explicit; occupied auto-restore pauses; takeover/detach
  channel closure never causes reconnection wars.
- Auth failure/cancel and host-key rejection permit manual retry/cancel and never loop.
- Repeated transport losses back off; cancellation cancels timers; single-flight and
  old-generation events cannot mutate new connection state.
- Existing tmux attach runs no cwd/login scripts; new tmux cwd uses `-c`.
- Run test:ssh-term, test:unit, build:typings, lint, build; local tmux subprocess tests
  use a dedicated test socket, never production SSH. CI Node 22, artifact-only desktop
  builds; fork never executes upstream publish/docs/release jobs.

## Validation boundary

Saved cloud environment: Node 22 and 24, the installed russh 0.1.38 native client, JS
dependencies and a tmux 3.5a binary unpacked in a temporary directory are usable.
Desktop native development libraries and a GUI are absent. The fork CI uses Node 22
and installs its own native build dependencies; it also runs `test:ssh-integration`.

Node integration tests import the actual SSHSession, SSHShellSession, SSHTabComponent,
connectable tab lifecycle and terminal middleware. Angular/Electron rendering and
credential-storage APIs are stand-ins; no production credentials are read. Deferred
native-channel fixtures cover cancellation, rejection and timeout at each acquisition
stage while another tab keeps the transport alive. Pending direct-tcpip tests cover
cancel/reject/timeout/transport loss, jump reference balance, late cleanup and target
startup failure. A held native direct-tcpip test verifies reconnect with a fresh
transport while preserving the shared jump and discarding a late forward.
Loopback-only SSH2 servers with
in-memory disposable host keys exercise the real russh client, keyboard-interactive
cancel/reconnect, actual TCP interruption, and two targets sharing a jump transport.
Tests explicitly collect unreachable native handles to exercise finalizers without
depending on Node memory pressure; they exit naturally without force-exit.
Python PTYs exercise real tmux attached shared/read-only/takeover clients, automatic
identity recovery, occupied restore pause, rename, missing/replaced identity, escaped
names and explicit atomic creation. Socket directories are private test fixtures.
Regression checks against 7d90f7b5 reproduce the retained auth prompt, hung PTY flight,
and missing jump-target retry; the fixed paths pass these checks.

These tests and unsigned artifacts do not establish Electron GUI behavior on any
desktop platform. Real production OpenSSH/PAM/agent/X11 combinations remain outside
the fixture coverage. PID/start-time identity does not survive server replacement
across reboot and does not provide hard fencing.
