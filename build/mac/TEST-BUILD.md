# macOS ARM64 adhoc test package

This package is for Apple Silicon Macs. It is adhoc signed, not Developer ID
signed or notarized. Gatekeeper automatic trust is assessed separately and a
rejection remains a failed trust gate. This candidate targets running after the
user grants a per-app exception through macOS; downloaded-device acceptance is
still required, even when CI launch checks pass.

The main Tabby process and four Electron Helpers receive the library validation
exception required for adhoc Electron/native libraries. Hardened Runtime, the
other entitlements, native-code/ASAR integrity and Electron security fuses remain
enabled. The formal signing profile is separate. No local re-signing or package
repair should be needed.

## Open the test package

1. Download this exact candidate's artifact from `Mafei/tabby` Actions. Unzip the
   Actions artifact and check the ZIP/DMG hash against `desktop-artifacts.sha256`;
   `desktop-artifact-receipt.json` identifies the source commit.
2. Open the DMG (or extract the application ZIP), copy `Tabby.app` into
   Applications, and try opening it normally.
3. If macOS blocks it because the developer cannot be verified or Apple cannot
   check it, open **System Settings → Privacy & Security**, scroll to the Tabby
   message and select **Open Anyway**. Confirm **Open** in the subsequent prompt
   only if you trust the source and checked the package.
4. Confirm the application opens, a new local terminal works, and quitting and
   reopening works without re-signing. Record the macOS version, source SHA and
   outcome. SSH/tmux workflows need their own functional acceptance.

These are Apple's documented per-app steps:
[Safely open apps on your Mac](https://support.apple.com/en-us/102445).
The package and instructions do not remove quarantine attributes or change
system security settings. If macOS reports malware, damage, or an invalid
signature, preserve the message and report it; those messages are not evidence
of successful acceptance.

CI reports archive/signature policy, non-platform library loading, normal
LaunchServices launch with no application arguments, and separate instrumented
native-module/UI checks. CI does not represent a browser download followed by
a user's manual Gatekeeper approval, and does not certify complete GUI or SSH
acceptance.
