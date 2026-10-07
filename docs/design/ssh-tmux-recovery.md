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

Current cloud scratch: Node 22 available; system package installation rejected and
npm/Yarn registries currently blocked by network policy. Pure Node/TS tests run here.
Native packaging and real tmux integration must be reported separately as CI checks
until this environment is prepared through its official installation/network channel.
