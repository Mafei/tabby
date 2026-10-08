#!/usr/bin/env python3
"""Verify the actual prototype APK and emit a public, credential-free receipt."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import zipfile
from web_security import inspect_web_assets, bind_aot_assets, WebSecurityError

APP = 'org.tabby.android.prototype'
PAGE = 16384
EXPORTS = ['start', 'command', 'poll', 'destroy']
ABI_MACHINES = {'arm64-v8a': 183, 'x86_64': 62}


def parse_abis(value):
    abis = value.split(',')
    if len(set(abis)) != len(abis) or any(abi not in ABI_MACHINES for abi in abis):
        raise argparse.ArgumentTypeError('Expected distinct arm64-v8a or x86_64 values, with no empty entries')
    return abis


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def elf(data, machine):
    require(data[:7] == b'\x7fELF\x02\x01\x01', 'Native library must be ELF64 little-endian')
    require(struct.unpack_from('<HH', data, 16) == (3, machine), 'Unexpected native ELF type or architecture')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    loads, relro, stack = [], [], []
    for index in range(count):
        kind, flags, file_offset, address, _, file_size, memory_size, alignment = struct.unpack_from('<IIQQQQQQ', data, offset + size * index)
        require(file_offset + file_size <= len(data), 'Native program segment is outside the file')
        if kind == 1:
            require(alignment >= PAGE and (file_offset - address) % PAGE == 0, 'Native LOAD segment is not 16 KiB compatible')
            loads.append({'offset': file_offset, 'vaddr': address, 'alignment': alignment})
        elif kind == 0x6474E552:
            require((address + memory_size) % PAGE == 0, 'Native RELRO end is not 16 KiB aligned')
            relro.append({'end': address + memory_size})
        elif kind == 0x6474E551:
            require(flags & 1 == 0, 'Executable native stack')
            stack.append(flags)
    require(loads and relro and stack, 'Required native LOAD, RELRO or stack segment is missing')
    return {'machine': machine, 'loads': loads, 'relro': relro, 'nonExecutableStack': True,
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--expected-abis', type=parse_abis, default='arm64-v8a',
                        help='Exact comma-separated packaged ABI set (default: arm64-v8a)')
    parser.add_argument('--allow-dirty', action='store_true', help='Preliminary local inspection only; marks the receipt dirty')
    args = parser.parse_args()
    apk = Path(args.apk).resolve()
    sdk = Path(os.environ['ANDROID_HOME'])
    tools = sdk / 'build-tools' / '36.0.0'
    repository = Path(__file__).resolve().parents[2]
    build_directory = repository / 'mobile' / '.angular'
    build_receipt = json.loads((build_directory / 'web-build-receipt.json').read_bytes())
    build_graph = (build_directory / 'build-stats.json').read_bytes()
    source = run('git', '-C', str(repository), 'rev-parse', 'HEAD').strip()
    tree = run('git', '-C', str(repository), 'rev-parse', 'HEAD^{tree}').strip()
    # The web build also imports desktop's palette generator. Record the whole
    # checkout, rather than allowing an uncommitted external build input.
    dirty = bool(run('git', '-C', str(repository), 'status', '--porcelain').strip())
    require(not dirty or args.allow_dirty, 'Commit the intended source before producing a deliverable receipt')
    badging = run(str(tools / 'aapt2'), 'dump', 'badging', str(apk))
    require("package: name='" + APP + "'" in badging, 'Wrong application ID')
    require("minSdkVersion:'26'" in badging and "targetSdkVersion:'36'" in badging, 'Wrong Android SDK range')
    require('application-debuggable' in badging, 'This verifier only describes the prototype debug APK')
    permissions = re.findall(r"^uses-permission: name='([^']+)'", badging, re.M)
    expected = {'android.permission.INTERNET', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.POST_NOTIFICATIONS', APP + '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'}
    require(set(permissions) == expected, 'Unexpected packaged permission set')
    manifest = run(str(tools / 'aapt2'), 'dump', 'xmltree', '--file', 'AndroidManifest.xml', str(apk))
    for flag in ['allowBackup', 'fullBackupContent', 'usesCleartextTraffic', 'extractNativeLibs']:
        require(re.search(r':' + flag + r'\([^\n]+\)=false', manifest), 'Unsafe or absent packaged flag: ' + flag)
    service_blocks = re.findall(r'(?m)^( +)E: service[^\n]*\n((?:(?!\1E:)[^\n]*\n)*)', manifest)
    require(len(service_blocks) == 1, 'Exactly one connection service is required')
    service = service_blocks[0][1]
    require('ConnectionService' in service and re.search(r':exported\([^\n]+\)=false', service), 'Connection service must be private')
    require(re.search(r':foregroundServiceType\([^\n]+\)=0x40000000', service), 'Connection service must use specialUse only')
    require('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE' in service, 'Connection service purpose must be declared')
    require(not re.search(r'E: receiver\b', manifest), 'Automatic receivers are not allowed')
    require('protectionLevel(0x01010009)=0x00000002' in manifest, 'Receiver permission must remain signature protected')
    run(str(tools / 'zipalign'), '-c', '-P', '16', '4', str(apk))
    signature = run(str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk))
    require('Verified using v2 scheme (APK Signature Scheme v2): true' in signature, 'APK v2 signature was not verified')
    require('Number of signers: 1' in signature and 'CN=Tabby Android Prototype Test' in signature, 'Unexpected prototype signing identity')
    certificate = re.search(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})', signature)
    require(certificate, 'Missing public test certificate fingerprint')
    libraries = {}
    with zipfile.ZipFile(apk) as archive, apk.open('rb') as raw, tempfile.TemporaryDirectory() as temporary:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate APK archive member')
        required_libraries = {f'lib/{abi}/libtabby_ssh.so': ABI_MACHINES[abi] for abi in args.expected_abis}
        native_names = [name for name in names if name.startswith('lib/')]
        require(len(native_names) == len(required_libraries) and set(native_names) == set(required_libraries),
                'Wrong native libraries or ABIs')
        packaged_abis = sorted({Path(name).parts[1] for name in native_names})
        require(not any(re.search(r'(?:keystore|\.(?:pem|jks|key)$|fixture|CloudWebViewHarness|androidTest)', name, re.I) for name in names), 'Test data or private signing material packaged in main APK')
        for name in names:
            if name.endswith('.dex'):
                dex = archive.read(name)
                for test_class in ['CloudWebViewHarness', 'RealSSHBridgeTest', 'AndroidHostKeyStoreTest',
                                   'ViewportLifecycleTest', 'EncryptedSecretStoreTest', 'SecurityPolicyTest', 'PrivateKeyImportTest',
                                   'DeferredSSHBridgeTest', 'NativeSessionIsolationTest', 'SessionOperationsTest']:
                    require(('Lorg/tabby/android/prototype/' + test_class + ';').encode() not in dex, 'Instrumentation class packaged in main DEX: ' + test_class)
        config = json.loads(archive.read('assets/capacitor.config.json'))
        require(config.get('loggingBehavior') == 'none', 'Capacitor logging must remain disabled')
        require(config['android'].get('allowMixedContent') is False and config['android'].get('webContentsDebuggingEnabled') is False, 'Unsafe WebView configuration')
        require(config['server'].get('allowNavigation') == [] and config['server'].get('androidScheme') == 'https', 'Unexpected WebView navigation policy')
        require('url' not in config['server'] and config['server'].get('hostname') == 'localhost', 'The native bridge must use bundled localhost assets')
        try:
            web_names = [name for name in names if name.startswith('assets/public/') and not name.endswith('/')]
            require(len(web_names) <= 512 and sum(archive.getinfo(name).file_size for name in web_names) <= 16 * 1024 * 1024,
                    'Unexpected packaged web asset count or size')
            web_assets = {name[len('assets/public/'):]: archive.read(name) for name in web_names}
            web_security = inspect_web_assets(web_assets)
            web_security.update(bind_aot_assets(web_assets, build_receipt, build_graph))
        except WebSecurityError as error:
            raise SystemExit(str(error)) from error
        reader = sdk / 'ndk' / '27.3.13750724' / 'toolchains' / 'llvm' / 'prebuilt' / 'linux-x86_64' / 'bin' / 'llvm-readelf'
        for name, machine in required_libraries.items():
            info = archive.getinfo(name)
            require(info.compress_type == zipfile.ZIP_STORED, 'Native library must be uncompressed')
            raw.seek(info.header_offset + 26)
            name_size, extra_size = struct.unpack('<HH', raw.read(4))
            data_offset = info.header_offset + 30 + name_size + extra_size
            require(data_offset % PAGE == 0, 'APK native library offset is not 16 KiB aligned')
            data = archive.read(name)
            record = elf(data, machine)
            path = Path(temporary) / Path(name).parts[1]
            path.write_bytes(data)
            symbols = run(str(reader), '--dyn-syms', '--wide', str(path))
            for export in EXPORTS:
                require(re.search(r'GLOBAL\s+DEFAULT\s+\d+\s+Java_org_tabby_android_ssh_NativeSSH_' + export + r'$', symbols, re.M), 'JNI export is absent: ' + export)
            record['apkDataOffset'] = data_offset
            record['jniExports'] = EXPORTS
            libraries[Path(name).parts[1]] = record
    report = {'verified': True, 'artifact': apk.name, 'sha256': hashlib.file_digest(apk.open('rb'), 'sha256').hexdigest(),
              'bytes': apk.stat().st_size, 'sourceCommit': source, 'sourceTree': tree, 'sourceDirty': dirty,
              'applicationId': APP, 'minSdk': 26, 'targetSdk': 36, 'debuggable': True,
              'permissions': permissions, 'publicTestCertificateSHA256': certificate[1], 'signatureScheme': 'v2',
              'zipAlignmentBytes': PAGE, 'expectedABIs': args.expected_abis, 'packagedABIs': packaged_abis,
              'nativeLibraries': libraries, 'arm64RuntimeVerified': False,
              'webSecurity': web_security,
              'limitations': ['Debug prototype, not a production release.', 'Packaging verification does not establish Android runtime or GUI behavior.',
                              'ARM64 device, 16 KiB page-size runtime, physical touch and system Chinese IME acceptance remain separate checks.']}
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    apk.with_suffix(apk.suffix + '.sha256').write_text(report['sha256'] + '  ' + apk.name + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
