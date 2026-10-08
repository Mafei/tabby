# Android direct SSH bridge

This is a prototype transport adapter using **russh 0.63.3**, the same Rust SSH
core as Tabby's desktop `russh` N-API package. It does not run Node on the phone,
use a gateway or save credentials. Optional deferred terminals and bounded
control exec channels support the separate mobile tmux controller.
Android carries a minimal [same-version channel-close repair](vendor/russh-0.63.3/TABBY-PATCH.md)
with the original archive checksum and exact diff; desktop dependencies are unchanged.

Library: `libtabby_ssh.so`. JNI class: `org.tabby.android.ssh.NativeSSH`.

```kotlin
external fun start(optionsJson: String): Long
external fun command(id: Long, commandJson: String)
external fun poll(id: Long): String
external fun destroy(id: Long)
```

`start` returns immediately. Invalid options/commands throw
`IllegalStateException` containing a stable error code. Neither native errors
nor this crate's logs include passwords, private keys, authentication responses,
server error strings, terminal input, or secret JSON.

Options (credentials are deliberately absent):

```json
{"host":"example.com","port":22,"username":"alice","generation":1,
 "authMode":"password","cols":80,"rows":24,"term":"xterm-256color"}
```

`authMode`: `password`, `privateKey`, or `keyboardInteractive`.
`deferTerminal` defaults to `false`: the original ordinary SSH authentication,
PTY/shell acquisition and `ready` event sequence is unchanged. With `true`,
verified authentication emits `state:authenticated,deferredTerminal:true` and
waits for an explicit `openTerminal` request. Control exec is available then;
terminal input/resize is unavailable until `ready`.
`expectedHostKey` is optional public key base64. **Kotlin supplies it from its
own known-host store, never from an untrusted Web caller.** A changed key is
rejected inside Rust even if the caller tries to accept it. Host certificates
and RSA/SHA-1 client authentication are outside this prototype's support.

Every event includes `connectionId` and `generation`. `poll` returns a JSON
array with at most 32 queued events plus bounded request completions and a final
connection state. Polling is nonblocking.
Events:

| Type | Fields |
| --- | --- |
| `state` | `state`: `connecting`, `authenticating`, `authenticated` (deferred only), `ready`, `closed`, or `error`; final states include stable `code` and `transportLost` |
| `hostKey` | `status`: `unknown` with `requestId`, or `known` without a request; `algorithm`, `fingerprint` (SHA256), `keyBase64` |
| `auth` | `requestId`, `mode`, `prompts`; keyboard interactive adds `name`, `instructions`, and `{prompt,echo}` entries |
| `data` | `data` base64 bytes; `extended` identifies stderr/extended data |
| `exit` | `exitStatus` |
| `execStarted` | `requestId`, only after the actual SSH exec Success acknowledgement |
| `execData` | `requestId`, `data` base64, `extended` for stderr; may precede Success |
| `execExit` | `requestId`, required `exitStatus`, `complete:true`; exactly once after channel close and all preceding request events have been polled |
| `execError` | `requestId`, stable `code`, `complete:false`, `truncated` |
| `terminalError` | `requestId`, stable `code`; recoverable acquisition failures preserve authenticated control state |

Each accepted control request has exactly one `execExit` or `execError`.
Nonzero exit status is a complete remote result. EOF alone is a half-close:
trailing output and ExitStatus are drained until Close. Missing ExitStatus,
signal termination or premature channel close is `exec_incomplete`. The mobile
framed-command adapter must require both its complete nonce frame and native
completion. Reaching a frame does not alone prove the channel completed.

Commands (each requires the exact connection `generation`):

```json
{"type":"hostKeyResponse","generation":1,"requestId":1,"accept":true}
{"type":"authResponse","generation":1,"requestId":2,"password":"temporary"}
{"type":"authResponse","generation":1,"requestId":2,"privateKey":"PEM/OpenSSH text","passphrase":"temporary"}
{"type":"authResponse","generation":1,"requestId":2,"responses":["temporary"]}
{"type":"write","generation":1,"data":"base64 bytes"}
{"type":"resize","generation":1,"cols":90,"rows":30}
{"type":"exec","generation":1,"requestId":10,"command":"stty size"}
{"type":"execCancel","generation":1,"requestId":10}
{"type":"openTerminal","generation":1,"requestId":11,"kind":"shell","cols":90,"rows":30}
{"type":"openTerminal","generation":1,"requestId":12,"kind":"exec","command":"generated guarded tmux attach command"}
{"type":"cancel","generation":1}
{"type":"close","generation":1}
```

`exec` and `openTerminal` share strictly increasing, non-reusable caller
request IDs in `1..2^53-1`; rejected admission does not consume an ID.
`execCancel` bypasses the ordinary input queue and cancels only that request.
Cancellation of an already completed ID is idempotent. Unknown future IDs are
`stale_request`. There is one PTY terminal per connection; `openTerminal` is
available only in deferred mode, with no outstanding control cleanup. Shell
requests prohibit `command`; exec requires a nonempty, NUL-free command of at
most 16 KiB UTF-8. Optional dimensions inherit start values and remain 1..1000.
The term comes from start. Deferred `ready` and `exit` include
`requestId,terminalKind`. Ready proves PTY plus shell/exec acknowledgements,
not the result of the tmux identity guard running inside that command.

First-contact approval in deferred mode emits a second `hostKey:known` event
with the exact handshake public key before authentication. A binding uses that
full raw `keyBase64`, not a display fingerprint or a Web-provided trusted pin.

The native wrapper must persist a newly accepted **public host key** before
forwarding acceptance, or reject if saving fails. Matching known keys are
accepted without another prompt. An initial rejection and rekey mismatch are
fatal; authentication is never started before host verification.

Authentication credentials are requested only after KEX succeeds. Imported
private keys must be read via a native file picker, held temporarily, and not
stored in profiles/localStorage/logs. This crate erases its secret wrappers on
best-effort drop; the JVM and russh may create temporary copies, so this is not a
guarantee of locked-memory storage.

The Android picker uses a separate process-wide single-flight import coordinator.
Its absolute 30-second deadline starts after document selection, not during user
browsing. Provider read/query work stays off the UI thread and waits for actual
foreground resume; delivery rechecks the request and foreground state. Provider
cancellation and descriptor close use bounded independent workers. A provider
that ignores cancellation retains the single import permit until actual cleanup,
including after Activity recreation; cancellation never creates replacement
reader threads or delivers late key bytes to the vault. Temporary byte buffers
are erased when the read/handoff cleanup actually runs. If a provider never
returns, a canceled import can remain unavailable until process restart, and
its partial buffer cannot be promised erased at the deadline.

Encrypted OpenSSH keys have a maximum bcrypt cost of 64 rounds; encrypted
PKCS#8 keys are outside prototype support. Key text is limited to 64 KiB and RSA
client keys to 8192 bits. Two global key-decoder permits remain held until the
actual CPU task ends, including after cancellation, so repeated cancellation
cannot create unbounded decoder threads. JNI and async session tasks catch
unexpected Rust panics and expose a stable `native_panic` code.
This crate is the prototype's only Rust component and installs a payload-free
process-global Rust panic hook; JVM diagnostics are unchanged. This prevents
the default hook from printing a secret-bearing dependency panic before it is
caught, at the cost of Rust panic backtrace/payload logs. The unit suite captures
a synthetic sensitive-marker panic in a subprocess to verify suppression.

Wrong generations and expired prompt IDs are rejected. The wrapper must never
silently drop `command_queue_full`: queue or retry input in order, with a bounded
application queue, and expose failure if delivery becomes impossible. Writes
are limited to 48 KiB per command. Data is emitted in 16 KiB chunks through a
32-event bounded queue, propagating consumer backpressure to SSH. At most four
connections and two exec channels per connection can exist.
Control requests have a fixed 10-second absolute operation deadline from
admission, including channel acquisition, SSH acknowledgement, output/backpressure
and complete close. Failure cleanup has a separate maximum of one second,
so completion may arrive slightly later; stdout plus stderr is limited to 1 MiB. These limits cannot be
raised by command options. Completed request slots remain bounded and retain
their permits until resource cleanup and completion delivery. The Android
wrapper applies the same output sequence/ACK window to `data` and `execData`;
discarded canceled-request bytes still require ACK.

Cancel/close/destroy immediately shut down the underlying TCP socket and abort
pending prompts. All TCP, KEX, authentication, key decoding, channel-open, PTY,
shell, exec and write/resize stages have deadlines. PTY/shell success requires
the actual server acknowledgement, not merely queuing a request. Because the
prototype owns one transport per terminal, an acquisition timeout closes that
transport, including channels that could otherwise open late. `destroy` is
idempotent and releases the connection ID; no events may be used after it.

Per-request exec cancellation preserves an already-sent channel-open future
until its bounded acquisition deadline. A late channel is closed without
executing the command. If cleanup cannot finish, only this connection's socket
is reset with `channel_cleanup_timeout` and `transportLost:false`; other Tabs
are independent. Ordinary request cancellation/output limits close their known
channel. This promises client resource cleanup, not killing arbitrary detached
remote processes. A timed-out session creation has uncertain outcome and must
never be automatically replayed.

Terminal EOF/Close while SSH remains live ends the Tab with
`closed/remote_closed,transportLost:false`; tmux detach or takeover therefore
does not trigger automatic reconnect. Unexpected network IO/EOF or keepalive
failure is `error/transport_lost,true`; explicit SSH disconnect is
`error/remote_disconnect,true`, and protocol failures are
`error/transport_failed,false`. Local cancel, hostkey/auth failure and timeout
cleanup remain false. `Handle.is_closed` alone never establishes loss: the core
waits boundedly for the disconnect reason and independently observes actual TCP
EOF/errors. Closure without either proof is `transport_closed,false` and does
not enable retry. If a control request or terminal acquisition is interrupted
by a confirmed transport ending, its `execError` or `terminalError` carries
the same transport reason as the final connection state. Request completion
can be delivered first; controllers must preserve the connection until that
final state arrives instead of guessing a loss from a generic channel error.
Automatic recovery requires the foreground controller's
original series and still-available transient credentials; background clears
them, and private-key/keyboard-interactive recovery may pause for reauthentication.

Android lifecycle pause/destroy calls `destroy`; foreground reconnection is a
new ID/generation. This crate makes no background keepalive promise.

## Build and real transport verification

Linux requires Rust 1.89+, a C compiler for `ring`, Node with the repository's
`ssh2` dependency, and Python 3. No user server or credential is involved:

```sh
cargo test --locked --features jni
```

The integration test starts the isolated SSH fixture and a real Python PTY;
it exercises the same exported `start`/`command`/`poll` lifecycle APIs as JNI.
The default fixture still rejects control exec. `deferred_ssh` starts its own
explicit `--profile control` fixture and covers real stdout/stderr, actual ACK,
nonzero complete exits, missing status, bounded output/timeouts, cancellation,
late channel cleanup, missing peer close ACK, plain PTY fallback and independent
connection lifecycles. Actual TCP loss, SSH disconnect and protocol corruption
are checked during running exec, session acquisition, exec ACK and all four
terminal acquisition stages, including request/final-state reason parity.
Android compilation uses an already installed, license-approved NDK:

```sh
ANDROID_NDK_HOME=/path/to/ndk ./build-android.sh arm64-v8a
ANDROID_NDK_HOME=/path/to/ndk ./build-android.sh x86_64
```

The build script downloads nothing and accepts no SDK licenses. Linux transport
tests do not establish Android JNI, system IME, or true-device touch acceptance.

The script explicitly appends `-Wl,-z,max-page-size=16384` and
`-Wl,-z,common-page-size=16384` via Cargo Rust flags. This follows
[Android's 16 KiB guidance](https://developer.android.com/guide/practices/page-sizes)
for NDK r27 and below and keeps alignment explicit on newer NDKs. Existing
encoded, global, or target environment Rust flags retain Cargo's precedence;
their contents are not evaluated as shell code.

The deferred-control API 26 release builds for `arm64-v8a` and `x86_64` passed actual
ELF checks: four LOAD segments per library have 16 KiB alignment, GNU_RELRO ends
on a 16 KiB boundary, the Android note identifies API 26 / NDK r27d 13750724,
and each library exports all four JNI methods. Dependencies are only Android's
`libdl.so`, `libm.so`, and `libc.so`. This establishes cross-compilation and ELF
layout; it does not establish Android JNI execution or 16 KiB runtime behavior.

| ABI | Verified release library SHA-256 |
| --- | --- |
| `arm64-v8a` | `dc69788e34b134ae131984c770b045ab6a2d4bee2daae8b1640ffa140deebb3a` |
| `x86_64` | `d2a9170f8ee93cb75ef182b2f2d727d9da4305be93df3f687cfa7ce56ea26072` |

**Final APK ZIP alignment and 16 KiB Android runtime remain unverified here.**
Before accepting an APK, inspect every shipped ABI's `.so` with the NDK's
`llvm-readelf -lW`/`llvm-objdump -p`: all LOAD segments must be at least 16 KiB
aligned, and verify GNU_RELRO page layout. Check the actual final APK with
`zipalign -c -P 16 -v 4 app.apk`; use AGP 8.5.1+ when packaging uncompressed
native libraries. Both ELF and ZIP checks are required. On an approved 16 KiB
emulator/device, confirm `adb shell getconf PAGE_SIZE` returns `16384`, then
exercise actual JNI loading and SSH lifecycle. Linker flags alone do not prove
runtime compatibility.
