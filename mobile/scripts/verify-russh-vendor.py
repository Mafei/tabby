#!/usr/bin/env python3
"""Bind the Android-only channel-close repair to the original pinned crate."""
import argparse
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ARCHIVE_SHA = "036204edbd199552a5b3832f63c60dcdf395dc44c7f06b4af1c0e8139cc11bce"
PATCH_SHA = "45fa7c1413f9843aa4354e55397692838994b74a4463a2a1064c50b6af32d646"
REPAIRED_SHA = "bd6e021f3edaa9f749aad5527948d6aaa237bd641e3855951946dd1caaa7cf26"
PREFIX = "russh-0.63.3/"
URL = "https://static.crates.io/crates/russh/russh-0.63.3.crate"


def verify(archive: bytes) -> None:
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA:
        raise ValueError("Original russh archive digest differs")
    vendor = Path(__file__).resolve().parents[1] / "android-ssh/vendor/russh-0.63.3"
    retained = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        for member in package:
            name = member.name.removeprefix(PREFIX)
            if not member.name.startswith(PREFIX) or not member.isfile():
                continue
            if name.startswith("src/") or name in {"Cargo.toml", "Cargo.toml.orig", "README.md"}:
                if name in retained or ".." in Path(name).parts:
                    raise ValueError("Invalid original package topology")
                retained[name] = package.extractfile(member).read()
    if len(retained) != 63:
        raise ValueError("Pinned original library topology differs")
    permitted = set(retained) | {"TABBY-PATCH.md", "LICENSE-APACHE", "tabby-channel-close.patch"}
    actual = {str(path.relative_to(vendor)) for path in vendor.rglob("*") if path.is_file()}
    if vendor.is_symlink() or actual != permitted or any(path.is_symlink() for path in vendor.rglob("*")):
        raise ValueError("Unexpected or missing vendored files")
    if hashlib.sha256((vendor / "tabby-channel-close.patch").read_bytes()).hexdigest() != PATCH_SHA:
        raise ValueError("Documented channel-close patch differs")
    for name, original in retained.items():
        current = (vendor / name).read_bytes()
        if name == "src/client/encrypted.rs":
            if hashlib.sha256(current).hexdigest() != REPAIRED_SHA:
                raise ValueError("Reviewed repaired source differs")
        elif current != original:
            raise ValueError(f"Unrelated upstream source changed: {name}")
    print("Verified russh 0.63.3 archive, 63 retained files and the sole reviewed Android channel-close repair.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Already downloaded original public crate")
    args = parser.parse_args()
    if args.archive:
        data = args.archive.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=30) as response:
            data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError("Original package exceeds its bounded download limit")
    verify(data)
