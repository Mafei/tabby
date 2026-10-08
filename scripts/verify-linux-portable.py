#!/usr/bin/env python3
"""Inspect the shipped x86_64 payload without executing it or using ldd.

The strict receipt requires Rocky 8.10's actual shared-library closure. It is
ABI evidence only: it never claims that a Rocky desktop, GPU or sandbox ran.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

LIMITS = {"GLIBC": (2, 28), "GLIBCXX": (3, 4, 25), "CXXABI": (1, 3, 11)}
FONT_SUFFIXES = {".ttf", ".otf", ".woff", ".woff2", ".eot", ".ttc"}
ACTIVE_NATIVE = {
    "keytar": ["node_modules/keytar/build/Release/keytar.node"],
    "node-pty": ["node_modules/node-pty/build/Release/pty.node",
                 "node_modules/node-pty/build/Debug/pty.node",
                 "node_modules/node-pty/prebuilds/linux-x64/pty.node"],
    "russh": ["node_modules/russh/russh.linux-x64-gnu.node"],
}


class AuditError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def run(args):
    env = dict(os.environ, LC_ALL="C", LANG="C")
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                            universal_newlines=True, timeout=60)
    require(result.returncode == 0, "Inspection command failed: " + args[0])
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inside(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def version_info(text):
    # Inspect requirements, not the provider's exported version definitions.
    needs = {}
    current = None
    in_needs = False
    for line in text.splitlines():
        if line.startswith("Version needs section"):
            in_needs = True
            continue
        if line.startswith("Version "):
            in_needs = False
        if not in_needs:
            continue
        match = re.search(r"\bFile: (\S+)\s+Cnt:", line)
        if match:
            current = match.group(1)
            needs.setdefault(current, [])
        match = re.search(r"\bName: (\S+)\s+Flags:", line)
        if match:
            require(current is not None, "Unscoped ELF version requirement")
            needs[current].append(match.group(1))
    definitions = set()
    in_definitions = False
    for line in text.splitlines():
        if line.startswith("Version definition section"):
            in_definitions = True
            continue
        if line.startswith("Version "):
            in_definitions = False
        if in_definitions:
            match = re.search(r"\bName: (\S+)", line)
            if match:
                definitions.add(match.group(1))
    return needs, definitions


def check_limits(requirements):
    highest = {}
    for versions in requirements.values():
        for name in versions:
            require(name != "GLIBC_PRIVATE", "Packaged ELF requires private glibc ABI")
            match = re.fullmatch(r"(GLIBC|GLIBCXX|CXXABI)_([0-9]+(?:\.[0-9]+)+)", name)
            if match:
                family, number = match.groups()
                value = tuple(int(part) for part in number.split("."))
                require(value <= LIMITS[family], "Packaged ELF exceeds " + family + " baseline: " + name)
                highest[family] = max(highest.get(family, ()), value)
    return {family: ".".join(str(x) for x in value) for family, value in highest.items()}


def inspect_elf(path, packaged=True, display_name=None):
    with path.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:4] == b"\x7fELF", "Native payload is not ELF: " + path.name)
    require(header[4] == 2 and header[5] == 1 and struct.unpack_from("<H", header, 18)[0] == 62,
            "Native payload is not little-endian ELF64 x86_64: " + path.name)
    if path.suffix == ".node":
        require(struct.unpack_from("<H", header, 16)[0] == 3, "Native addon is not an ELF shared object")
    dynamic = run(["readelf", "--dynamic", "--wide", str(path)])
    versions = run(["readelf", "--version-info", "--wide", str(path)])
    needed = re.findall(r"\(NEEDED\).*?Shared library: \[([^\]]+)\]", dynamic)
    require(all("/" not in name for name in needed), "DT_NEEDED contains a path")
    requirements, definitions = version_info(versions)
    require("(VERNEED)" not in dynamic or bool(requirements), "ELF version needs were not parsed")
    require("(VERDEF)" not in dynamic or bool(definitions), "ELF version definitions were not parsed")
    paths = re.findall(r"\((RUNPATH|RPATH)\).*?Library (?:runpath|rpath): \[([^\]]*)\]", dynamic)
    require(len(paths) <= 1, "Ambiguous ELF search path")
    program_headers = run(["readelf", "--program-headers", "--wide", str(path)])
    try:
        symbols = dynamic_symbols(run(["readelf", "--dyn-syms", "--wide", str(path)]))
    except AuditError as error:
        raise AuditError("ELF " + json.dumps(display_name or path.name) + ": " + str(error)) from error
    require("(SYMTAB)" not in dynamic or symbols["declaredEntries"] is not None,
            "ELF dynamic symbols were not parsed")
    result = {"needed": needed, "requirements": requirements, "definitions": definitions,
              "searchPath": paths[0][1].split(":") if paths else [],
              "searchPathKind": paths[0][0] if paths else None,
              "hasInterpreter": bool(re.search(r"^\s*INTERP\s", program_headers, re.MULTILINE)),
              "symbols": symbols}
    if packaged:
        result["highestRequiredVersions"] = check_limits(requirements)
    return result


def dynamic_symbols(text):
    imports, exports, defaults = set(), set(), set()
    headers = re.findall(r"Symbol table '\.dynsym' contains ([0-9]+) entries:", text)
    require(len(headers) <= 1, "Ambiguous dynamic symbol table")
    rows = set()
    for line in text.splitlines():
        match = re.fullmatch(r"\s*(\d+):\s+([0-9a-fA-F]+)\s+([0-9]+|0x[0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+)(?:\s+\([0-9]+\))?)?\s*", line)
        if not match:
            require(not re.match(r"\s*\d+:", line), "Unsupported dynamic symbol row")
            continue
        number, value, size, kind, binding, visibility, index, name = match.groups()
        number = int(number)
        require(number not in rows, "Duplicate dynamic symbol row")
        rows.add(number)
        if number == 0:
            require(int(value, 16) == 0 and int(size, 16 if size.startswith("0x") else 10) == 0
                    and (kind, binding, visibility, index, name) == ("NOTYPE", "LOCAL", "DEFAULT", "UND", None),
                    "Invalid null dynamic symbol")
            continue
        if name is None:
            # Older GNU readelf leaves st_name=0 SECTION symbols unnamed; newer
            # versions synthesize the section name. Neither is an import/export.
            require((kind, binding, visibility) == ("SECTION", "LOCAL", "DEFAULT")
                    and index.isdecimal() and int(index) > 0,
                    "Invalid unnamed dynamic symbol")
            continue
        pieces = name.replace("@@", "@").split("@", 1)
        symbol, version = pieces[0], pieces[1] if len(pieces) == 2 else None
        if index == "UND":
            if binding != "WEAK":
                imports.add((symbol, version))
        elif binding in ("GLOBAL", "WEAK", "UNIQUE") and visibility in ("DEFAULT", "PROTECTED"):
            exports.add((symbol, version))
            if version is None or "@@" in name:
                defaults.add(symbol)
    declared = int(headers[0]) if headers else None
    parsed = len(rows - {0})
    require(declared is None or (parsed == max(0, declared - 1)
            and all(0 <= number < declared for number in rows)),
            "Incomplete dynamic symbol parsing (parsed " + str(parsed) + ", declared " + str(declared) + ")")
    return {"imports": imports, "exports": exports, "defaults": defaults, "declaredEntries": declared}


def read_asar(path):
    with path.open("rb") as stream:
        prefix = stream.read(16)
        require(len(prefix) == 16, "Truncated ASAR header")
        size_payload, header_size, payload_size, json_size = struct.unpack("<IIII", prefix)
        require(size_payload == 4 and 8 <= header_size <= 64 * 1024 * 1024,
                "Invalid ASAR header size")
        require(json_size <= payload_size - 4 and payload_size + 4 == header_size,
                "Invalid ASAR pickle")
        header_bytes = stream.read(json_size)
        require(len(header_bytes) == json_size, "Truncated ASAR JSON")
    try:
        header = json.loads(header_bytes.decode("utf8"))
    except (UnicodeError, ValueError):
        raise AuditError("Invalid ASAR JSON")
    require(isinstance(header, dict), "Invalid ASAR root")
    return header, 8 + header_size


def asar_files(header, prefix="", unpacked=False):
    files = header.get("files")
    require(isinstance(files, dict), "Invalid ASAR directory")
    for name, entry in sorted(files.items()):
        require(isinstance(name, str) and name not in ("", ".", "..") and "/" not in name and "\\" not in name,
                "Unsafe ASAR entry")
        require(isinstance(entry, dict), "Invalid ASAR entry")
        filename = prefix + name
        inherited = unpacked or entry.get("unpacked") is True
        if "files" in entry:
            for item in asar_files(entry, filename + "/", inherited):
                yield item
        else:
            require("link" not in entry, "ASAR links need explicit portability review")
            require(type(entry.get("size")) is int and entry["size"] >= 0, "Invalid ASAR file size")
            yield filename, entry, inherited


def asar_prefix(archive, data_offset, entry, maximum=4):
    require(isinstance(entry.get("offset"), str) and entry["offset"].isdigit(), "Invalid ASAR offset")
    offset = data_offset + int(entry["offset"])
    size = entry["size"]
    require(offset + size <= archive.stat().st_size, "ASAR file is out of range")
    with archive.open("rb") as stream:
        stream.seek(offset)
        return stream.read(min(size, maximum))


def scan_payload(root):
    elfs, asars = {}, []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            require(inside(path, root) and path.exists(), "Payload symlink escapes AppDir or is broken")
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        require("node_modules/fontmanager-redux/" not in relative,
                "Unused Linux fontmanager native dependency was not excluded")
        require("node_modules/native-process-working-directory/build/" not in relative,
                "Unused Linux working-directory native binding was not excluded")
        with path.open("rb") as stream:
            magic = stream.read(4)
        if path.suffix == ".asar":
            asars.append(path)
        if magic == b"\x7fELF" or path.suffix == ".node":
            elfs[relative] = inspect_elf(path, display_name=relative)
        require(not (magic[:2] == b"MZ" and path.suffix.lower() in (".exe", ".dll", ".node")),
                "Foreign Windows native payload: " + relative)
    require("tabby" in elfs and "chrome-sandbox" in elfs, "Electron runtime is incomplete")
    require(root.joinpath("resources/app.asar").is_file(), "Packaged application ASAR is missing")
    native_entries = []
    for archive in asars:
        header, offset = read_asar(archive)
        for filename, entry, unpacked in asar_files(header):
            require("node_modules/fontmanager-redux/" not in filename,
                    "Unused Linux fontmanager native dependency remains inside ASAR")
            require("node_modules/native-process-working-directory/build/" not in filename,
                    "Unused Linux working-directory native binding remains inside ASAR")
            if unpacked:
                physical = Path(str(archive) + ".unpacked").joinpath(filename)
                require(physical.is_file() and inside(physical, root), "Unpacked ASAR entry is missing")
                require(physical.stat().st_size == entry["size"], "Unpacked ASAR entry size mismatch")
                if filename.endswith(".node"):
                    require(physical.relative_to(root).as_posix() in elfs, "Uninspected native ASAR entry")
                    native_entries.append(filename)
            else:
                magic = asar_prefix(archive, offset, entry)
                require(magic != b"\x7fELF" and not filename.endswith(".node"),
                        "Native code is hidden inside ASAR instead of unpacked: " + filename)
                if filename == "dist/main.js":
                    data = asar_prefix(archive, offset, entry, entry["size"])
                    check_launch_text(data, "app main")
    active = {}
    for package, candidates in ACTIVE_NATIVE.items():
        chosen = next((name for name in candidates if name in native_entries), None)
        require(chosen is not None, "Missing active Linux native module: " + package)
        active[package] = chosen
    # Serialport uses node-gyp-build's N-API/platform selection. Inventory it,
    # while its actual loader selection is proved by the Electron runtime gate.
    require(any("node_modules/@serialport/bindings-cpp/" in name for name in native_entries),
            "Missing Linux serialport binding")
    return elfs, native_entries, active


def check_launch_text(data, label):
    require(b"--no-sandbox" not in data and
            not re.search(rb"appendSwitch\(\s*['\"]no-sandbox['\"]", data),
            "Launcher disables the Chromium sandbox: " + label)


def check_launcher(root):
    app_run = root.joinpath("AppRun")
    require(app_run.is_file() and os.access(str(app_run), os.X_OK), "Executable AppRun is missing")
    expected = ('#!/bin/sh\nset -eu\n'
                'tabby_app_dir=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)\n'
                'if [ -n "${APPIMAGE:-}" ] && [ -n "${APPDIR:-}" ] && [ "$(readlink -f -- "$APPDIR" 2>/dev/null || true)" = "$tabby_app_dir" ]; then\n'
                '    :\nelse\n    APPIMAGE="$tabby_app_dir/AppRun"\nfi\n'
                'APPDIR="$tabby_app_dir"\nexport APPDIR APPIMAGE\n'
                'exec "$APPDIR/tabby" "$@"\n').encode("utf8")
    require(app_run.read_bytes() == expected, "AppRun differs from the reviewed launcher")
    for path in root.rglob("*.desktop"):
        check_launch_text(path.read_bytes(), path.relative_to(root).as_posix())
    electron_plugin = root.joinpath("resources/builtin-plugins/tabby-electron")
    require(electron_plugin.is_dir(), "Packaged Electron plugin is missing")
    for path in electron_plugin.rglob("*.js"):
        check_launch_text(path.read_bytes(), path.relative_to(root).as_posix())


def check_public_readability(path, root):
    # A build-owner os.access result does not prove root-owned SquashFS files
    # are readable by a normal UID. Check other-read/traverse permission bits.
    require(not path.is_symlink() and path.is_file() and inside(path, root),
            "Public font resource is missing or linked")
    require(path.stat().st_mode & 0o004, "Public font resource is not world-readable")
    parent = path.parent
    while True:
        require(not parent.is_symlink() and parent.is_dir() and parent.stat().st_mode & 0o001,
                "Public font resource directory is not world-traversable")
        if parent == root:
            break
        require(inside(parent, root), "Public font resource directory escapes AppDir")
        parent = parent.parent


def check_font_notices(root):
    source = Path(__file__).resolve().parent / "fonts/font-manifest.json"
    packaged = root / "resources/font-notices/font-manifest.json"
    require(packaged.is_file() and packaged.read_bytes() == source.read_bytes(), "Packaged font manifest is missing or changed")
    check_public_readability(packaged, root)
    manifest = json.loads(source.read_text())
    notices = []
    for entry in manifest["licenses"]:
        path = root / "resources/font-notices/licenses" / entry["file"]
        require(path.is_file() and inside(path, root) and sha256(path) == entry["sha256"],
                "Packaged font license/notice is missing or changed")
        check_public_readability(path, root)
        notices.append({"file": entry["file"], "sha256": entry["sha256"]})
    return notices


def check_font_payload(root):
    manifest = json.loads((Path(__file__).resolve().parent / "fonts/font-manifest.json").read_text())
    budget = manifest["budgetBytes"]
    require(type(budget) is int and 0 < budget <= 50 * 1024 * 1024, "Invalid font payload budget")
    inventory, total = [], 0

    def add(name, size, digest):
        inventory.append({"file": name, "bytes": size, "sha256": digest, "publiclyReadable": True})

    for path in sorted(root.rglob("*")):
        if path.suffix.lower() not in FONT_SUFFIXES:
            continue
        check_public_readability(path, root)
        name = path.relative_to(root).as_posix()
        require("/src/fonts/bundled/" not in "/" + name, "Duplicate source font directory was packaged")
        size = path.stat().st_size
        total += size
        require(total <= budget, "Whole font payload exceeds the 50 MiB budget")
        add(name, size, sha256(path))

    # Packed font entries count too; unpacked entries were counted physically.
    for archive in sorted(root.rglob("*.asar")):
        header, offset = read_asar(archive)
        for filename, entry, unpacked in asar_files(header):
            if unpacked or Path(filename).suffix.lower() not in FONT_SUFFIXES:
                continue
            check_public_readability(archive, root)
            require("/src/fonts/bundled/" not in "/" + filename, "Duplicate source font directory remains inside ASAR")
            total += entry["size"]
            require(total <= budget, "Whole font payload exceeds the 50 MiB budget")
            asar_prefix(archive, offset, entry, 0)  # Validate the complete range before streaming.
            digest = hashlib.sha256()
            remaining = entry["size"]
            with archive.open("rb") as stream:
                stream.seek(offset + int(entry["offset"]))
                while remaining:
                    block = stream.read(min(1024 * 1024, remaining))
                    require(bool(block), "Truncated ASAR font payload")
                    digest.update(block)
                    remaining -= len(block)
            add(archive.relative_to(root).as_posix() + "!/" + filename, entry["size"], digest.hexdigest())

    required = []
    font_dir = "resources/builtin-plugins/tabby-terminal/dist/fonts/"
    for font in manifest["fonts"]:
        copies = [item for item in inventory if item["sha256"] == font["sha256"]]
        require(len(copies) == 1, "Manifest font is missing or duplicated in the whole payload: " + font["file"])
        item = copies[0]
        stem, suffix = os.path.splitext(font["file"])
        filename = item["file"][len(font_dir):] if item["file"].startswith(font_dir) else ""
        require(item["bytes"] == font["bytes"] and
                re.fullmatch(re.escape(stem) + r"-[0-9a-f]+" + re.escape(suffix), filename) is not None,
                "Manifest font does not match its emitted dist/fonts asset: " + font["file"])
        required.append({"file": font["file"], "copies": 1, "packagedFile": item["file"], "sha256": item["sha256"]})
    return {"totalBytes": total, "budgetBytes": budget, "files": inventory,
            "requiredFonts": required, "publiclyReadable": True}


def baseline_host():
    values = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip('"')
    glibc = run(["getconf", "GNU_LIBC_VERSION"]).strip()
    return values.get("ID") == "rocky" and values.get("VERSION_ID") == "8.10" and glibc == "glibc 2.28"


def host_libraries(text):
    result = {}
    for line in text.splitlines():
        match = re.match(r"\s*(\S+) \(([^)]+)\) => (\S+)\s*$", line)
        if match and "x86-64" in match.group(2):
            name, _, filename = match.groups()
            result.setdefault(name, []).append(Path(filename))
    return result


def resolve_needed(name, origin, info, root, system, inherited=()):
    # AppRun adds no LD_LIBRARY_PATH. Only the ELF's real search path and the
    # baseline linker cache are considered; unrelated usr/lib copies are not.
    # glibc 2.28 elf/dl-load.c:1899 suppresses inherited DT_RPATH whenever
    # the requesting object has its own DT_RUNPATH (including grandchildren).
    for directory in inherited if info.get("searchPathKind") != "RUNPATH" else ():
        candidate = directory.joinpath(name)
        if candidate.is_file():
            require(inside(candidate, root), "Inherited dependency escapes AppDir")
            return candidate.resolve(), True
    for entry in info["searchPath"]:
        expanded = entry.replace("${ORIGIN}", str(origin)).replace("$ORIGIN", str(origin))
        require(expanded and "$" not in expanded and Path(expanded).is_absolute(), "Unsupported ELF search path")
        directory = Path(expanded)
        require(not inside(origin, root) or inside(directory, root), "Packaged ELF has a nonportable absolute search path")
        candidate = directory.joinpath(name)
        if candidate.is_file():
            require(not inside(origin, root) or inside(candidate, root), "Dependency escapes AppDir")
            return candidate.resolve(), inside(candidate, root)
    candidates = list(dict.fromkeys(system.get(name, [])))
    require(len(candidates) == 1, "System dependency is missing or ambiguous: " + name)
    return candidates[0].resolve(), False


def dependency_closure(root, elfs):
    system = host_libraries(run(["ldconfig", "-p"]))
    cache = {root.joinpath(name).resolve(): info for name, info in elfs.items()}
    main = elfs["tabby"]
    main_rpath = ()
    if main["searchPathKind"] == "RPATH":
        # The inspected official Electron executable has exactly DT_RPATH=$ORIGIN.
        # Model that inherited root directory; reject arbitrary inherited paths.
        require(main["searchPath"] == ["$ORIGIN"], "Unsupported executable DT_RPATH")
        main_rpath = (root,)
    for name, info in elfs.items():
        require(name == "tabby" or info["searchPathKind"] != "RPATH", "Unsupported library/secondary executable DT_RPATH")
    pending = []
    for filename, info in cache.items():
        owner = filename if info["hasInterpreter"] else root / "tabby"
        inherited = main_rpath if owner == root / "tabby" else ()
        pending.append((filename, inherited, owner))
    external, edges, visited, graph = {}, [], set(), {}
    while pending:
        filename, inherited, owner = pending.pop()
        context = (filename, inherited, owner)
        if context in visited:
            continue
        visited.add(context)
        info = cache[filename]
        graph[context] = []
        for name in info["needed"]:
            target, bundled = resolve_needed(name, filename.parent, info, root, system, inherited)
            if target not in cache:
                cache[target] = inspect_elf(target, packaged=bundled)
            provider = cache[target]
            require(provider["searchPathKind"] != "RPATH", "Unsupported dependency DT_RPATH inheritance")
            missing = set(info["requirements"].get(name, [])) - provider["definitions"]
            require(not missing, "Dependency lacks required version definitions: " + name)
            if not bundled:
                external[name] = {"path": str(target), "sha256": sha256(target)}
            pending.append((target, inherited, owner))
            graph[context].append((target, inherited, owner))
            edges.append({"from": filename.relative_to(root).as_posix() if inside(filename, root) else filename.name,
                          "needed": name, "bundled": bundled})
    def reachable(start):
        queue, found = [start], set()
        while queue:
            item = queue.pop()
            if item not in found:
                found.add(item)
                queue.extend(graph.get(item, []))
        return found
    scopes = {}
    for context in visited:
        filename, inherited, owner = context
        if owner not in scopes:
            scopes[owner] = reachable((owner, main_rpath if owner == root / "tabby" else (), owner))
        scope = reachable(context) | scopes[owner]
        exported, defaults = set(), set()
        for provider, _, _ in scope:
            exported.update(cache[provider]["symbols"]["exports"])
            defaults.update(cache[provider]["symbols"]["defaults"])
        for symbol, version in cache[filename]["symbols"]["imports"]:
            require((symbol, version) in exported if version is not None else symbol in defaults,
                    "Strong dynamic symbol has no baseline provider: " + symbol + ("@" + version if version else ""))
    return external, edges


def source_identity(project):
    return {"sourceCommit": run(["git", "-C", str(project), "rev-parse", "HEAD"]).strip(),
            "sourceDirty": bool(run(["git", "-C", str(project), "status", "--porcelain"]).strip())}


def audit(app_dir, allow_non_baseline=False):
    root = app_dir.resolve()
    require(root.is_dir(), "AppDir is missing")
    baseline = baseline_host()
    require(baseline or allow_non_baseline, "Strict dependency closure must run on Rocky Linux 8.10 / glibc 2.28")
    elfs, native_entries, active = scan_payload(root)
    check_launcher(root)
    notices = check_font_notices(root)
    fonts = check_font_payload(root)
    external, edges = dependency_closure(root, elfs) if baseline else ({}, [])
    binaries = []
    for name, info in sorted(elfs.items()):
        binaries.append({"file": name, "sha256": sha256(root.joinpath(name)),
                         "needed": info["needed"], "versionRequirements": info["requirements"],
                         "highestRequiredVersions": info["highestRequiredVersions"], "searchPath": info["searchPath"],
                         "searchPathKind": info["searchPathKind"]})
    return {"verified": True, "architecture": "x86_64", "baseline": "Rocky Linux 8.10 / glibc 2.28",
            "baselineDependencyClosureVerified": baseline, "rockyGUIVerified": False,
            "strongDynamicSymbolClosureVerified": baseline,
            "rockySELinuxVerified": False, "productRendererSandboxed": False,
            "sandboxDisableArgumentsAbsent": True, "appRunSHA256": sha256(root.joinpath("AppRun")),
            "appAsarSHA256": sha256(root.joinpath("resources/app.asar")),
            "nativeASAREntries": native_entries, "activeNativeCandidates": active, "binaries": binaries,
            "unusedNativeModulesExcluded": ["fontmanager-redux"],
            "nativeBindingsExcludedWithJSWrapperRetained": ["native-process-working-directory"],
            "fontLicenses": notices,
            "fontPayload": fonts,
            "systemLibraries": external, "dependencyEdges": edges}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-non-baseline", action="store_true", help="Preliminary payload-only inspection; never a baseline closure claim")
    args = parser.parse_args()
    try:
        receipt = audit(args.app_dir, args.allow_non_baseline)
        receipt.update(source_identity(Path(__file__).resolve().parent.parent))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        print(json.dumps({"verified": True, "elfCount": len(receipt["binaries"]),
                          "nativeCount": len(receipt["nativeASAREntries"]),
                          "baselineDependencyClosureVerified": receipt["baselineDependencyClosureVerified"]}))
    except (AuditError, OSError, subprocess.SubprocessError) as error:
        print("Linux portable audit failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
