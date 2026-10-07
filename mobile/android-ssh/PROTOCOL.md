# Android direct SSH bridge

This is a prototype transport adapter using **russh 0.63.3**, the same Rust SSH
core as Tabby's desktop `russh` N-API package. It does not run Node on the phone,
use a gateway, save credentials, or implement mobile tmux management.

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
`expectedHostKey` is optional public key base64. **Kotlin supplies it from its
own known-host store, never from an untrusted Web caller.** A changed key is
rejected inside Rust even if the caller tries to accept it. Host certificates
and RSA/SHA-1 client authentication are outside this prototype's support.

Every event includes `connectionId` and `generation`. `poll` returns a JSON
array with at most 32 queued events plus a terminal state. Polling is nonblocking.
Events:

| Type | Fields |
| --- | --- |
| `state` | `state`: `connecting`, `authenticating`, `ready`, `closed`, or `error`; terminal states include stable `code` |
| `hostKey` | `status`: `unknown` with `requestId`, or `known` without a request; `algorithm`, `fingerprint` (SHA256), `keyBase64` |
| `auth` | `requestId`, `mode`, `prompts`; keyboard interactive adds `name`, `instructions`, and `{prompt,echo}` entries |
| `data` | `data` base64 bytes; `extended` identifies stderr/extended data |
| `exit` | `exitStatus` |
| `execData` / `execExit` / `execError` | `requestId` plus `data`/`exitStatus`/`code` |

The Rust-only exec interface is reserved for a later tmux adapter. The current
Android plugin does not expose it, and the isolated MVP fixture rejects exec;
successful remote exec is not part of this prototype's verified support.

Commands (each requires the exact connection `generation`):

```json
{"type":"hostKeyResponse","generation":1,"requestId":1,"accept":true}
{"type":"authResponse","generation":1,"requestId":2,"password":"temporary"}
{"type":"authResponse","generation":1,"requestId":2,"privateKey":"PEM/OpenSSH text","passphrase":"temporary"}
{"type":"authResponse","generation":1,"requestId":2,"responses":["temporary"]}
{"type":"write","generation":1,"data":"base64 bytes"}
{"type":"resize","generation":1,"cols":90,"rows":30}
{"type":"exec","generation":1,"requestId":10,"command":"stty size"}
{"type":"cancel","generation":1}
{"type":"close","generation":1}
```

The native wrapper must persist a newly accepted **public host key** before
forwarding acceptance, or reject if saving fails. Matching known keys are
accepted without another prompt. An initial rejection and rekey mismatch are
fatal; authentication is never started before host verification.

Authentication credentials are requested only after KEX succeeds. Imported
private keys must be read via a native file picker, held temporarily, and not
stored in profiles/localStorage/logs. This crate erases its secret wrappers on
best-effort drop; the JVM and russh may create temporary copies, so this is not a
guarantee of locked-memory storage.

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

Cancel/close/destroy immediately shut down the underlying TCP socket and abort
pending prompts. All TCP, KEX, authentication, key decoding, channel-open, PTY,
shell, exec and write/resize stages have deadlines. PTY/shell success requires
the actual server acknowledgement, not merely queuing a request. Because the
prototype owns one transport per terminal, an acquisition timeout closes that
transport, including channels that could otherwise open late. `destroy` is
idempotent and releases the connection ID; no events may be used after it.

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

**Android ELF/APK alignment remains unverified until the actual Android build.**
Before accepting an APK, inspect every shipped ABI's `.so` with the NDK's
`llvm-readelf -lW`/`llvm-objdump -p`: all LOAD segments must be at least 16 KiB
aligned, and verify GNU_RELRO page layout. Check the actual final APK with
`zipalign -c -P 16 -v 4 app.apk`; use AGP 8.5.1+ when packaging uncompressed
native libraries. Both ELF and ZIP checks are required. On an approved 16 KiB
emulator/device, confirm `adb shell getconf PAGE_SIZE` returns `16384`, then
exercise actual JNI loading and SSH lifecycle. Linker flags alone do not prove
runtime compatibility.
