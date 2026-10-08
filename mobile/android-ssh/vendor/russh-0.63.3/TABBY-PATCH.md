# Android-only russh 0.63.3 repair

This library source comes from the original crates.io `russh` **0.63.3** package:

- Archive: <https://static.crates.io/crates/russh/russh-0.63.3.crate>
- Original archive SHA-256: `036204edbd199552a5b3832f63c60dcdf395dc44c7f06b4af1c0e8139cc11bce`
- Patch: [tabby-channel-close.patch](tabby-channel-close.patch)
- Patch SHA-256: `45fa7c1413f9843aa4354e55397692838994b74a4463a2a1064c50b6af32d646`
- Patched `src/client/encrypted.rs` SHA-256: `bd6e021f3edaa9f749aad5527948d6aaa237bd641e3855951946dd1caaa7cf26`

All 60 original library source files, both original Cargo manifests and README
are retained. Only the guarded added branch in `client/encrypted.rs` differs from
the archive's library code. Unused upstream examples, integration tests and
benchmarks are omitted. Package/version and dependency requirements are
unchanged. Android's own Cargo dependency uses this path and exact version;
the desktop dependency remains on its original source. Android's lockfile only
removes the registry source/checksum from the russh entry; other versions stay
locked. This is not a new GitHub fork or a version upgrade.

In unmodified 0.63.3, a local channel close removes its encrypted channel state.
The later peer CHANNEL_CLOSE is then discarded because that state is absent,
leaving the outer ChannelRef registered and its cleanup waiter unresolved.
The patch releases a still-registered outer reference, forwards the **actual
peer close** and invokes the original channel-close handler. Unknown or
duplicate channel IDs remain ignored. An encrypted channel entry that still
exists but is unconfirmed retains the original ignore behavior; only an
entirely absent encrypted entry can enter the new branch. The normal established-channel branch
is unchanged, including pending-output handling. Dropped receivers do not
prevent reference removal.

The Android engine waits at most one second for known-channel close cleanup.
Missing peer acknowledgement resets only that connection's transport with
`channel_cleanup_timeout`, never a network-loss retry. Real transport tests
cover cancel followed by a new exec on the same healthy connection, late
channel acquisition without executing its command, and independent Tabs.

Original source copyright and Apache-2.0 notices remain intact. The published
crate contains those notices and its Apache-2.0 manifest declaration but no
standalone license file. `LICENSE-APACHE` supplements it with the standard
Apache-2.0 text from the already installed official Rust 1.90.0 Cargo toolchain
(`share/doc/cargo/LICENSE-APACHE`). The direct Apache license-text request
returned HTTP 403; it was not bypassed.
