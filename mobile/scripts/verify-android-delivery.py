#!/usr/bin/env python3
"""Bind an ARM64 APK to the same-source APK actually tested on Android.

The APK verifier receipts establish packaging/signing checks. This verifier
binds those receipts to the input bytes and requires identical common ZIP
payload and ARM64 library bytes. It does not establish ARM64 runtime behavior.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile

APP = 'org.tabby.android.prototype'
ARM64 = 'lib/arm64-v8a/libtabby_ssh.so'
X86_64 = 'lib/x86_64/libtabby_ssh.so'
CHUNK = 65536
MAX_APK_BYTES = 256 * 1024 * 1024
MAX_ZIP_BYTES = 512 * 1024 * 1024
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
GIT_ID = re.compile(r'[0-9a-f]{40}\Z')
SIGNATURE_MEMBER = re.compile(r'META-INF/(?:[^/]+\.(?:SF|RSA|DSA|EC)|MANIFEST\.MF)\Z')
WEBVIEW_CASES = [
    'actual Angular UI → Capacitor → native SSH → Unicode PTY',
    'Android InputConnection preedit/commit/delete and native-touch auxiliary keys reach exact PTY bytes',
    'native Android swipe/long-press selection → system clipboard → real PTY paste',
    'actual AOSP system keyboard show/hide and rotation update WebView and SSH PTY dimensions',
    'real TCP loss closes Android UI/resources, rejects old writes and permits explicit reconnect',
    'actual Activity background closes resources; canceled auth rejects old responses and reconnects',
    'normal notification permission decisions, real background foreground retention and notification Stop All',
    'optional native Keystore password save, secret-free saved login and deletion',
    'durable native host-key pin survives a fresh process and rejects same-endpoint replacement',
]
TMUX_WEBVIEW_CASES = [
    'actual SSH exec detects tmux, lists the selected private socket and creates literal session names with atomic collision rejection',
    'two real PTYs share one tmux session; read-only blocks input and explicit takeover detaches prior clients',
    'real TCP interruption restores the same tmux server/session identity and pauses automatic recovery while occupied',
    'missing, replaced and restarted tmux identities fail closed without implicit session creation',
    'cancel and old generations cannot reopen tmux or affect another Tab',
]


class DeliveryError(Exception):
    """A fixed public error code; never contains input data or exception text."""


def require(condition, code):
    if not condition:
        raise DeliveryError('ANDROID_DELIVERY_' + code)


def digest_file(path):
    require(path.is_file() and 0 < path.stat().st_size <= MAX_APK_BYTES, 'APK_SIZE_INVALID')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def read_document(path):
    require(path.is_file() and 0 < path.stat().st_size <= 1024 * 1024, 'REPORT_SIZE_INVALID')
    result = json.loads(path.read_text(), object_pairs_hook=unique_object)
    require(type(result) is dict, 'REPORT_INVALID')
    return result


def source_identity():
    repository = Path(__file__).resolve().parents[2]

    def git(*args):
        return subprocess.run(['git', '-C', str(repository), *args], check=True,
                              text=True, capture_output=True).stdout.strip()

    require(not git('status', '--porcelain'), 'SOURCE_DIRTY')
    return git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')


def verify_receipt(apk, receipt, commit, tree, abis):
    require(type(receipt) is dict and receipt.get('verified') is True, 'APK_NOT_VERIFIED')
    require(receipt.get('sourceDirty') is False, 'SOURCE_DIRTY')
    require(receipt.get('sourceCommit') == commit and receipt.get('sourceTree') == tree,
            'SOURCE_MISMATCH')
    require(receipt.get('applicationId') == APP and receipt.get('signatureScheme') == 'v2',
            'APK_IDENTITY_INVALID')
    certificate = receipt.get('publicTestCertificateSHA256')
    require(type(certificate) is str and SHA256.fullmatch(certificate), 'CERTIFICATE_INVALID')
    actual_sha = digest_file(apk)
    require(receipt.get('sha256') == actual_sha, 'APK_SHA_MISMATCH')
    require(type(receipt.get('bytes')) is int and receipt['bytes'] == apk.stat().st_size,
            'APK_SIZE_MISMATCH')
    require(receipt.get('artifact') == apk.name, 'APK_NAME_MISMATCH')
    for field in ['expectedABIs', 'packagedABIs']:
        values = receipt.get(field)
        require(type(values) is list and len(values) == len(abis)
                and all(type(value) is str for value in values)
                and set(values) == set(abis), 'RECEIPT_ABIS_MISMATCH')
    libraries = receipt.get('nativeLibraries')
    require(type(libraries) is dict and set(libraries) == set(abis), 'RECEIPT_ABIS_MISMATCH')
    return actual_sha


def archive_members(archive, libraries):
    infos = archive.infolist()
    names = [info.filename for info in infos]
    require(len(names) == len(set(names)), 'DUPLICATE_ZIP_ENTRY')
    require(sum(info.file_size for info in infos) <= MAX_ZIP_BYTES, 'ZIP_SIZE_INVALID')
    for info in infos:
        name = info.filename
        parts = name.rstrip('/').split('/')
        require(name and name == info.orig_filename and '\\' not in name
                and not name.startswith('/') and all(part not in ['', '.', '..'] for part in parts),
                'ZIP_PATH_INVALID')
        require(not info.flag_bits & 1, 'ZIP_ENCRYPTED_ENTRY')
    require({name for name in names if name.startswith('lib/')} == libraries, 'NATIVE_PATHS_MISMATCH')
    return set(names)


def identical_member(left, right, name, code):
    size = left.getinfo(name).file_size
    require(size == right.getinfo(name).file_size, code)
    digest = hashlib.sha256()
    with left.open(name) as first, right.open(name) as second:
        while True:
            block = first.read(CHUNK)
            other = second.read(CHUNK)
            require(block == other, code)
            if not block:
                break
            digest.update(block)
    return size, digest.digest()


def library_receipt(archive, path, receipt, machine):
    data = archive.read(path)
    record = receipt['nativeLibraries'][path.split('/')[1]]
    require(type(record) is dict and type(record.get('bytes')) is int
            and record['bytes'] == len(data)
            and record.get('sha256') == hashlib.sha256(data).hexdigest()
            and type(record.get('machine')) is int and record['machine'] == machine,
            'NATIVE_RECEIPT_MISMATCH')
    require(len(data) >= 20 and data[:7] == b'\x7fELF\x02\x01\x01'
            and struct.unpack_from('<HH', data, 16) == (3, machine), 'NATIVE_ELF_MISMATCH')


def verify_runtime(runtime, tested_sha):
    require(type(runtime) is dict and runtime.get('suite') == 'real-android-emulator'
            and runtime.get('passed') is True and runtime.get('scope') == 'native-and-webview'
            and 'failure' not in runtime, 'RUNTIME_NOT_PASSED')
    native = runtime.get('instrumentation')
    require(type(native) is dict and native.get('passed') is True
            and type(native.get('tests')) is int and native['tests'] == 8
            and type(native.get('skipped')) is int and native['skipped'] == 0,
            'NATIVE_TESTS_INCOMPLETE')
    web = runtime.get('webview')
    require(type(web) is dict and web.get('passed') is True
            and type(web.get('skipped')) is int and web['skipped'] == 0
            and web.get('cases') == WEBVIEW_CASES, 'WEBVIEW_TESTS_INCOMPLETE')
    tmux = runtime.get('tmux')
    require(type(tmux) is dict and tmux.get('passed') is True and 'failure' not in tmux,
            'TMUX_NOT_PASSED')
    tmux_native = tmux.get('instrumentation')
    require(type(tmux_native) is dict and tmux_native.get('passed') is True
            and type(tmux_native.get('tests')) is int and tmux_native['tests'] == 4
            and type(tmux_native.get('skipped')) is int and tmux_native['skipped'] == 0,
            'TMUX_NATIVE_TESTS_INCOMPLETE')
    tmux_web = tmux.get('webview')
    require(type(tmux_web) is dict and tmux_web.get('passed') is True
            and type(tmux_web.get('skipped')) is int and tmux_web['skipped'] == 0
            and tmux_web.get('cases') == TMUX_WEBVIEW_CASES, 'TMUX_WEBVIEW_TESTS_INCOMPLETE')
    apks = runtime.get('apks')
    require(type(apks) is dict and apks.get('appSHA256') == tested_sha, 'RUNTIME_APK_MISMATCH')
    android = runtime.get('android')
    require(type(android) is dict and type(android.get('api')) is int
            and android['api'] in [31, 32, 33, 34, 35, 36, 37] and android.get('abi') == 'x86_64', 'RUNTIME_PLATFORM_INVALID')
    compatibility = runtime.get('compatibility')
    require(type(compatibility) is dict and compatibility.get('physicalDevice') is False
            and compatibility.get('requestedForm') in ['phone', 'tablet', 'unspecified']
            and all(type(compatibility.get(field)) is int and 1 <= compatibility[field] <= 16384
                    for field in ['width', 'height'])
            and type(compatibility.get('density')) is int and 72 <= compatibility['density'] <= 1000
            and type(compatibility.get('webViewPackage')) is str
            and len(compatibility['webViewPackage']) <= 256
            and re.fullmatch(r'com\.[A-Za-z0-9_.]+', compatibility['webViewPackage'])
            and type(compatibility.get('webViewVersion')) is str
            and len(compatibility['webViewVersion']) <= 64
            and re.fullmatch(r'\d+(?:\.\d+){1,4}', compatibility['webViewVersion']),
            'RUNTIME_COMPATIBILITY_INVALID')
    minimum_dp = min(compatibility['width'], compatibility['height']) * 160 / compatibility['density']
    require(compatibility['requestedForm'] != 'tablet' or minimum_dp >= 600,
            'RUNTIME_TABLET_TOO_SMALL')
    requested_image = compatibility.get('requestedImage')
    if android['api'] == 37 or requested_image is not None:
        require(type(requested_image) is dict and requested_image == {
            'platform': '37.0' if android['api'] == 37 else str(android['api']),
            'tag': 'google_apis' if android['api'] == 37 else 'default', 'abi': 'x86_64',
        }, 'RUNTIME_SELECTED_IMAGE_INVALID')
    return {'api': android['api'], 'abi': android['abi']}


def verify_delivery(apk, emulator_apk, apk_report, emulator_report, runtime_report, commit, tree):
    """Core check for tests; CLI additionally requires the current clean checkout."""
    try:
        return _verify_delivery(Path(apk), Path(emulator_apk), apk_report, emulator_report,
                                runtime_report, commit, tree)
    except (OSError, ValueError, TypeError, KeyError, struct.error, zipfile.BadZipFile,
            zipfile.LargeZipFile, RuntimeError, EOFError, UnicodeError):
        raise DeliveryError('ANDROID_DELIVERY_INPUT_INVALID') from None


def _verify_delivery(apk, emulator_apk, apk_report, emulator_report, runtime_report, commit, tree):
    require(type(commit) is str and GIT_ID.fullmatch(commit)
            and type(tree) is str and GIT_ID.fullmatch(tree), 'SOURCE_IDENTITY_INVALID')
    primary_sha = verify_receipt(apk, apk_report, commit, tree, ['arm64-v8a'])
    tested_sha = verify_receipt(emulator_apk, emulator_report, commit, tree, ['arm64-v8a', 'x86_64'])
    require(apk_report['publicTestCertificateSHA256'] == emulator_report['publicTestCertificateSHA256'],
            'CERTIFICATE_MISMATCH')
    platform = verify_runtime(runtime_report, tested_sha)
    with zipfile.ZipFile(apk) as primary, zipfile.ZipFile(emulator_apk) as tested:
        primary_names = archive_members(primary, {ARM64})
        tested_names = archive_members(tested, {ARM64, X86_64})
        library_receipt(primary, ARM64, apk_report, 183)
        library_receipt(tested, ARM64, emulator_report, 183)
        library_receipt(tested, X86_64, emulator_report, 62)
        payload = lambda names: {name for name in names if not name.startswith('lib/')
                                 and not SIGNATURE_MEMBER.fullmatch(name)}
        common = payload(primary_names)
        require(common and common == payload(tested_names), 'PAYLOAD_MEMBERS_MISMATCH')
        digest = hashlib.sha256(b'Tabby Android common payload v1\0')
        for name in sorted(common):
            size, content_sha = identical_member(primary, tested, name, 'PAYLOAD_CONTENT_MISMATCH')
            encoded = name.encode('utf-8')
            digest.update(struct.pack('>Q', len(encoded)) + encoded + struct.pack('>Q', size) + content_sha)
        _, arm64_sha = identical_member(primary, tested, ARM64, 'ARM64_CONTENT_MISMATCH')
    return {
        'verified': True, 'bindingVersion': 1, 'applicationId': APP,
        'appSHA256': primary_sha, 'testedAppSHA256': tested_sha,
        'sourceCommit': commit, 'sourceTree': tree, 'sourceDirty': False,
        'publicTestCertificateSHA256': apk_report['publicTestCertificateSHA256'],
        'commonPayloadSHA256': digest.hexdigest(), 'commonPayloadMemberCount': len(common),
        'arm64LibrarySHA256': arm64_sha.hex(), 'deliveredABIs': ['arm64-v8a'],
        'runtime': platform, 'deliveredABIExecuted': False,
        'compatibility': {field: runtime_report['compatibility'][field] for field in
                          ['physicalDevice', 'requestedForm', 'width', 'height', 'density',
                           'webViewPackage', 'webViewVersion']},
        'limitations': [
            'ARM64 APK was not executed on Android; runtime evidence belongs to the x86_64 emulator APK.',
            'OPPO Find N6 hardware, physical touch, a specific Chinese IME and 16 KiB page-size runtime remain unverified.',
            'Debug prototype, not a production release.',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['apk', 'emulator-apk', 'apk-report', 'emulator-report', 'runtime-report', 'report']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        paths = {name: Path(getattr(args, name.replace('-', '_'))).resolve()
                 for name in ['apk', 'emulator-apk', 'apk-report', 'emulator-report', 'runtime-report', 'report']}
        require(paths['report'] not in {path for name, path in paths.items() if name != 'report'},
                'OUTPUT_PATH_COLLISION')
        commit, tree = source_identity()
        receipt = verify_delivery(paths['apk'], paths['emulator-apk'],
                                  read_document(paths['apk-report']), read_document(paths['emulator-report']),
                                  read_document(paths['runtime-report']), commit, tree)
        paths['report'].parent.mkdir(parents=True, exist_ok=True)
        output = json.dumps(receipt, indent=2) + '\n'
        paths['report'].write_text(output)
        print(json.dumps(receipt))
    except DeliveryError as error:
        raise SystemExit(str(error)) from None
    except (OSError, ValueError, subprocess.SubprocessError, UnicodeError):
        raise SystemExit('ANDROID_DELIVERY_INPUT_INVALID') from None


if __name__ == '__main__':
    main()
