# Android device key enrollment candidate

Base: sealed Android product `85dd17a2bd611ef414227440389881f531084a8d`.
Branch: `candidate/android-mobile-key-enrollment-20261008`. Mobile changes only;
the Linux packaging work and original device-tested prototype are preserved.

## Phone flow

After a verified connection is ready, More → 设置密钥登录 shows the selected
host, port, account and server fingerprint. Generation has its own confirmation;
opening this screen creates nothing. A new software Ed25519 key is generated in
Rust/JNI, then wrapped by a separate random-ID Android Keystore AES-256-GCM key.
Private bytes remain in native code and `noBackupFilesDir`; public metadata is
authenticated as associated data. The app exposes no private-key export, cloud
sync, shared filename or persistent document permission. Short-lived JVM strings
needed by the existing JNI authentication boundary cannot be forcibly wiped by
the JVM; native byte arrays are cleared on success and failure.

The list shows each public fingerprint, creation time, associated target and
last observed installation/verification status. Another key may be generated
before an old key is deleted. Status describes a past observation; it does not
prove the current server still authorizes the key. Copy for an administrator
copies only the OpenSSH public-key line.

Prepare installation performs a read-only preflight on a separate SSH exec
channel. A second confirmation displays the SSH target, verified server pin,
actual Unix account/UID, exact HOME/.ssh/authorized_keys path and Ed25519
fingerprint. Only this account and public key are considered. There is no sudo,
sshd configuration edit, chmod of existing objects, remote key removal, or
installation from an automatic reconnect.

Automatic installation conservatively requires a non-root Linux account,
Python 3, libacl, an absolute safe SSH HOME, and a recognized local filesystem.
Every path component is opened relative to an already-open directory using
O_NOFOLLOW. Owners, write permissions, access/default ACLs, file type, link count,
size, inode identity and content are checked. Root-owned sticky temporary
ancestors are supported; the actual home must belong to the authenticated Unix
user. Custom AuthorizedKeysFile/AuthorizedKeysCommand policies require an
administrator. Missing capabilities, symlinks, ACLs, unsafe permissions and
changed preflight content stop the automated path.

New directories/files use 0700/0600. Existing bytes, options and permissions are
preserved. A matching algorithm/blob, including a restricted matching entry,
is not duplicated with an unrestricted line. A nonblocking advisory flock and
one O_APPEND write avoid replacing the existing file. Network/unknown filesystems
are refused. Other same-account processes that ignore advisory locks can still
race the append; post-write identity failures and lost replies are reported as
uncertain, without automatic rollback or replay. The administrator-copy option
remains available when this conservative path cannot establish safety.

After a confirmed append, a separate new SSH transport uses only the stored key
and the original native host pin. It opens no PTY/shell and never falls back to
password. Public-key acceptance with additional authentication is reported
separately. Successful authentication does not establish shell/PTY access or
forced-command policy. The existing terminal and saved password remain usable.
Failure retains the local key and any observed server entry; it does not silently
revoke, duplicate or roll back a key.

Deletion has its own confirmation, clears the wrapping alias and encrypted
record, closes connections that used that key and cancels corresponding native
and UI recovery intents. It never removes the server's public-key line. Revoking
an old server key after rotation is an explicit administrator operation.

## Verification and delivery

Tests use generated keys, synthetic accounts and disposable local SSH fixtures.
They cover malformed keys, target/pin binding, separate generation/install
consent, encrypted metadata updates, missing Keystore keys, ciphertext/metadata
tampering, deletion, restricted-key deduplication, unsafe paths/links/permissions,
ACLs, stale confirmations, actual exec installation, fresh public-key-only
authentication, cancellation and additional-auth failures. Existing tmux,
foreground-service, lifecycle, networking, host-key, keyboard and touch acceptance
remain required. The cloud matrix still includes nine API31–37 phone/tablet
configurations, with exact source and ARM64 APK byte binding; no incomplete or
skipped runtime suite can produce a passed delivery receipt.

Runtime images are actual adb screencap PNGs using synthetic accounts. Each has
a metadata sidecar with dimensions, capture time, byte length and SHA-256. They
show the running emulator app, not generated design images. ARM64 packaging and
Linux JNI execution do not establish ARM64 Android runtime acceptance. OPPO
fold/unfold, the user's IME, Wi-Fi/cellular handover and a physical ARM64 runtime
remain user acceptance items. No real server, credential, phone installation,
permission grant, merge or release occurs in this cloud task.

## Primary references

- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [OpenSSH authorized_keys format and restrictions](https://man.openbsd.org/sshd.8)
- [Linux open/O_NOFOLLOW/O_APPEND behavior](https://man7.org/linux/man-pages/man2/open.2.html)
- [Linux ACL access by descriptor](https://man7.org/linux/man-pages/man3/acl_get_fd.3.html)
- [Linux default ACL behavior](https://man7.org/linux/man-pages/man3/acl_get_file.3.html)
- Existing [approved mobile/foldable design](../docs/design/android-mobile-ux/README.md)

This candidate was authored by an AI coding agent (fully vibe coded). It remains
a draft for review and device acceptance.
