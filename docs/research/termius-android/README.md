# Isolated Termius Android runtime study

This independent research candidate starts from sealed Android product
`5ebd250a499f6dff52f4713f84ebcbece09b81c7`. It changes no product source,
product acceptance gates, existing workflow, PR6, PR8 or desktop candidate.
The user authorized one API36 emulator study and its independent draft PR.
This does not authorize implementation of the proposed Termius-inspired UI.

The new workflow runs only for this fork's exact research head targeting the
sealed key-enrollment branch. It uses `contents: read`, checks out the exact PR
head, has a separate concurrency group, and runs one Ubuntu 24.04 KVM job.
It does not trigger the product Android matrix or merge/release anything.

## First run: verify official installation prerequisites

The proposed image is exactly
`system-images;android-36;google_apis_playstore;x86_64`, with Pixel 7 geometry.
This is a research image choice, not a change to the non-Play product matrix.
Official SDK repository metadata must confirm its stable package, API and ABI.
The existing SDK agreement SHA256
`1f8729233617b193fd619213792ae16a41b95d2bbbf525dfe66998252ba68b16`
is reused only after the exact published agreement text matches. The installer
has no `--licenses`, automatic agreement reply or alternative download route.
An added/changed agreement is saved as public license evidence and blocks SDK
installation. SDK metadata/archives use Google's official repository and the
existing pinned command-line-tools checksum.

The official [Termius installation documentation](https://docs.termius.com/getting-started/download-termius)
points Android users to [Google Play](https://play.google.com/store/apps/details?id=com.server.auditor.ssh.client).
Public pages are checked without cookies, credentials or login. No unofficial
APK, application-package redistribution or account export is used.

If prerequisites pass, the job starts a fresh disposable API36 emulator using
the existing KVM/capacity/readiness path. It records API, ABI, screen size,
density and font scale, then opens only the official Play listing intent.
It never clicks Install, Sign in, Accept, purchase or a permission button.
The first run stops at the actual store/login/terms screen for review. A green
completed research job is not successful Termius installation or Android
product acceptance: consult `preflight.json` and `observation.json`.

## Evidence and later observation scope

CI artifacts bind the exact source SHA/tree, metadata hashes, selected
agreements and actual `adb screencap` capture times/dimensions/SHA256. Fresh AVD
data is never imported. A UI-tree privacy check rejects account-like text,
password fields and nonempty editable fields before storing a screenshot.
Screenshots receive pixel review after retrieval. No app logs, credential
inputs, account data, AVD snapshot or Termius APK are published.

When official installation is possible within authorized boundaries, further
research should record Termius version/installer/ABI and observe Hosts, session
switching, IME open/closed, expanded/scrolling keys, paste, local preedit/input
placement, application Home and system Home behavior. These are **not yet
observed** by this first-run prerequisite harness. Account creation, credentials,
new terms, paid features and unapproved permissions remain stop points. Real
SSH hosts and the user's phone are excluded. Chinese IME behavior requires an
actual available IME and cannot be inferred from synthetic InputConnection
tests, marketing screenshots or iOS documentation.

The official [AVD documentation](https://developer.android.com/studio/run/managing-avds)
distinguishes Google APIs from Play Store images. The already completed
[official-image UI review](https://github.com/Mafei/tabby/pull/8) remains a design
artifact; Play listing images, actual emulator captures and our own design
screens must retain distinct labels. No absence of a visible editor in a static
image establishes how the app implements composition or input focus.

AI disclosure: fully vibe coded by an AI coding agent.
