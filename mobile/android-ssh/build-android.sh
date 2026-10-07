#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

abi="${1:-arm64-v8a}"
api="${ANDROID_API_LEVEL:-26}"
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
    printf '%s\n' 'ANDROID_NDK_HOME must point to an installed, license-approved NDK.' >&2
    exit 1
fi
case "$abi" in
    arm64-v8a) target=aarch64-linux-android; clang_target=aarch64-linux-android ;;
    x86_64) target=x86_64-linux-android; clang_target=x86_64-linux-android ;;
    *) printf '%s\n' 'Supported prototype ABIs: arm64-v8a, x86_64.' >&2; exit 1 ;;
esac
case "$(uname -s)" in
    Linux) ndk_host=linux-x86_64 ;;
    Darwin) ndk_host=darwin-x86_64 ;;
    *) printf '%s\n' 'Run this script on Linux or macOS with an approved NDK.' >&2; exit 1 ;;
esac
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$ndk_host/bin"
compiler="$toolchain/$clang_target$api-clang"
if [[ ! -x "$compiler" ]]; then
    printf '%s\n' 'The NDK compiler for the requested ABI/API is unavailable.' >&2
    exit 1
fi
target_env="${target//-/_}"
target_upper="${target_env^^}"
build_env=("CC_$target_env=$compiler" "AR_$target_env=$toolchain/llvm-ar"
    "CARGO_TARGET_${target_upper}_LINKER=$compiler")
# NDK r27 and below need both flags; keep them explicit for reproducible
# LOAD/RELRO alignment even when a newer NDK defaults to 16 KiB.
# Preserve Cargo's environment precedence and append without eval/reparsing.
alignment_flags="-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"
if [[ ${CARGO_ENCODED_RUSTFLAGS+x} ]]; then
    encoded_flags="$CARGO_ENCODED_RUSTFLAGS"
    for flag in -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384; do
        encoded_flags+="${encoded_flags:+$'\x1f'}$flag"
    done
    build_env+=("CARGO_ENCODED_RUSTFLAGS=$encoded_flags")
elif [[ ${RUSTFLAGS+x} ]]; then
    build_env+=("RUSTFLAGS=${RUSTFLAGS}${RUSTFLAGS:+ }$alignment_flags")
else
    target_flags_name="CARGO_TARGET_${target_upper}_RUSTFLAGS"
    target_flags="${!target_flags_name-}"
    build_env+=("$target_flags_name=${target_flags}${target_flags:+ }$alignment_flags")
fi
env "${build_env[@]}" cargo build --locked --release --features jni --target "$target"
printf 'Library: %s\n' "target/$target/release/libtabby_ssh.so"
