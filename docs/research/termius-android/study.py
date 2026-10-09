#!/usr/bin/env python3
"""Isolated API36 official-channel preflight. No account or consent automation."""
import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('approved_sdk', ROOT / 'mobile/scripts/install-android-ci.py')
SDK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SDK)
PACKAGE = 'system-images;android-36;google_apis_playstore;x86_64'
IMAGE = {'package': PACKAGE, 'platform': '36', 'tag': 'google_apis_playstore'}
CATALOG = 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml'
INSTALL_PACKAGES = ['platform-tools', 'emulator', PACKAGE]
TERMIUS = 'com.server.auditor.ssh.client'
OFFICIAL_DOC = 'https://docs.termius.com/getting-started/download-termius'
PLAY = 'https://play.google.com/store/apps/details?id=' + TERMIUS


def utc():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def run(args, timeout=30, binary=False):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=True)
    return result.stdout if binary else result.stdout.decode('utf-8', errors='replace').strip()


def download(url, maximum=8 * 1024 * 1024):
    # Normal official URLs only. No cookies, login, proxy changes or denied-route retry.
    request = urllib.request.Request(url, headers={'User-Agent': 'Tabby-Android-UI-Research'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('DOWNLOAD_SIZE_LIMIT')
    return data


def packages(root, names):
    return [p for p in SDK.children(root, 'remotePackage') if p.get('path') in names]


def license_evidence(root, selected, output):
    refs = sorted({x.get('ref') for p in packages(root, selected) for x in SDK.children(p, 'uses-license')})
    evidence = []
    for ref in refs:
        if not ref or not re.fullmatch(r'[a-z0-9-]+', ref):
            raise ValueError('LICENSE_ID_INVALID')
        values = [x.text for x in SDK.children(root, 'license') if x.get('id') == ref]
        item = {'id': ref, 'definitions': len(values), 'alreadyApproved': False}
        if len(values) == 1 and isinstance(values[0], str):
            data = values[0].encode()
            item.update({'sha256': digest(data), 'bytes': len(data)})
            item['alreadyApproved'] = ref == 'android-sdk-license' and digest(data) == SDK.LICENSE_SHA256
            (output / ('license-' + ref + '.txt')).write_bytes(data)
        evidence.append(item)
    return evidence


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            value = dict(attrs).get('href', '')
            if value.startswith('https://play.google.com/store/apps/details?') and ('id=' + TERMIUS) in value:
                self.links.append(value)


def official_channel():
    result = {'officialDocumentation': OFFICIAL_DOC, 'playListing': PLAY,
              'appPackage': TERMIUS, 'apkDownloaded': False, 'versionVerified': False}
    try:
        text = download(OFFICIAL_DOC).decode('utf-8')
        parser = Links()
        parser.feed(text)
        # GitBook may serve Markdown rather than HTML.
        result['documentationLinksPlay'] = bool(parser.links) or bool(re.search(
            r'https://play\.google\.com/store/apps/details\?id=com\.server\.auditor\.ssh\.client', text))
        result['documentationHTTP'] = 200
    except (urllib.error.URLError, ValueError) as error:
        result['documentationError'] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            result['documentationHTTP'] = error.code
    try:
        text = download(PLAY).decode('utf-8')
        result['listingHTTP'] = 200
        result['listingNamesPublisher'] = 'Termius Corporation' in text
    except (urllib.error.URLError, ValueError) as error:
        result['listingError'] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            result['listingHTTP'] = error.code
    return result


def preflight(output):
    report = {'createdUTC': utc(), 'sourceSHA': run(['git', 'rev-parse', 'HEAD']),
              'sourceTree': run(['git', 'rev-parse', 'HEAD^{tree}']),
              'package': PACKAGE, 'requestedRuntimeAPI': 36, 'requestedABI': 'x86_64',
              'metadataURLs': [SDK.REPOSITORY_URL, CATALOG], 'canInstall': False,
              'sdkInstalled': False, 'termiusInstalled': False, 'termiusRan': False,
              'officialChannel': official_channel(), 'licenseEvidence': []}
    try:
        if os.environ.get('TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256') != SDK.LICENSE_SHA256:
            raise ValueError('APPROVED_SDK_CONSENT_NOT_PRESENT')
        selected = set()
        for name, url, wanted, image in [
            ('repository.xml', SDK.REPOSITORY_URL, {'platform-tools', 'emulator', 'cmdline-tools;22.0'}, None),
            ('play-images.xml', CATALOG, {PACKAGE}, IMAGE),
        ]:
            data = download(url)
            (output / name).write_bytes(data)
            root = ET.fromstring(data)
            report.setdefault('catalogs', []).append({'file': name, 'sha256': digest(data)})
            if image:
                stable = [p for p in packages(root, wanted) if len(SDK.children(p, 'channelRef')) == 1
                          and SDK.children(p, 'channelRef')[0].get('ref') == 'channel-0']
                report['imageMetadata'] = {'exactStableRecords': len(stable)}
                if len(stable) == 1:
                    details = SDK.children(stable[0], 'type-details')
                    if len(details) == 1:
                        report['imageMetadata'].update({
                            'apiValues': [x.text for x in SDK.children(details[0], 'api-level')],
                            'abiValues': [x.text for x in SDK.children(details[0], 'abi')],
                            'tagIDs': [x.text for t in SDK.children(details[0], 'tag') for x in SDK.children(t, 'id')]})
            report['licenseEvidence'].extend(license_evidence(root, wanted, output))
            report.setdefault('selectedPackages', []).extend(
                {'path': p.get('path'), 'agreements': [x.get('ref') for x in SDK.children(p, 'uses-license')]}
                for p in packages(root, wanted))
            selected.update(SDK.verified_packages(root, wanted, image))
        if selected != {'platform-tools', 'emulator', 'cmdline-tools;22.0', PACKAGE}:
            raise ValueError('EXACT_STABLE_PACKAGE_NOT_FOUND')
        report.update({'status': 'OFFICIAL_IMAGE_VERIFIED', 'canInstall': True})
    except (SystemExit, ValueError, ET.ParseError, urllib.error.URLError) as error:
        code = str(error) if isinstance(error, (SystemExit, ValueError)) else type(error).__name__
        report.update({'status': 'PREFLIGHT_BLOCKED', 'blocker': code})
        if isinstance(error, urllib.error.HTTPError):
            report['httpStatus'] = error.code
    write_json(output / 'preflight.json', report)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
            target.write('can_install=' + str(report['canInstall']).lower() + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as target:
            target.write('## Termius Android research\n\n' + report['status'] + '\n\n')
            target.write('Termius has not been installed or run. No account, consent or permission automation.\n')
            if not report['canInstall']:
                target.write('\nBlocker: `' + report['blocker'] + '`\n')
    print(json.dumps({k: report[k] for k in ['status', 'canInstall', 'package', 'licenseEvidence']}, indent=2))
    return report


def install(output):
    report = json.loads((output / 'preflight.json').read_text())
    if not report['canInstall'] or report['sourceSHA'] != run(['git', 'rev-parse', 'HEAD']):
        raise ValueError('VERIFIED_PREFLIGHT_REQUIRED')
    if os.environ.get('TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256') != SDK.LICENSE_SHA256:
        raise ValueError('APPROVED_SDK_CONSENT_NOT_PRESENT')
    for name, wanted, image in [('repository.xml', {'platform-tools', 'emulator', 'cmdline-tools;22.0'}, None),
                                ('play-images.xml', {PACKAGE}, IMAGE)]:
        data = (output / name).read_bytes()
        expected = next(x['sha256'] for x in report['catalogs'] if x['file'] == name)
        if digest(data) != expected or SDK.verified_packages(ET.fromstring(data), wanted, image) != wanted:
            raise ValueError('PREFLIGHT_BYTES_CHANGED')
    sdk = Path(os.environ['ANDROID_HOME']).resolve()
    if sdk.name != 'termius-study-sdk' or not sdk.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve()):
        raise ValueError('DISPOSABLE_SDK_DIRECTORY_REQUIRED')
    if sdk.exists() and any(sdk.iterdir()):
        raise ValueError('EMPTY_DISPOSABLE_SDK_REQUIRED')
    archive = download('https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip', 512 * 1024 * 1024)
    if digest(archive) != SDK.CLI_SHA256:
        raise ValueError('OFFICIAL_CLI_CHECKSUM_MISMATCH')
    archive_path = sdk.parent / 'termius-study-cli.zip'
    archive_path.write_bytes(archive)
    sdk.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as zipped:
        for item in zipped.infolist():
            if item.filename.startswith('/') or '..' in Path(item.filename).parts or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('UNSAFE_OFFICIAL_ARCHIVE')
        zipped.extractall(sdk)
    tools = sdk / 'cmdline-tools'
    temporary = sdk / 'cli-unpacked'
    tools.rename(temporary)
    tools.mkdir()
    temporary.rename(tools / 'latest')
    for executable in (tools / 'latest/bin').iterdir():
        executable.chmod(executable.stat().st_mode | 0o111)
    licenses = sdk / 'licenses'
    licenses.mkdir()
    (licenses / 'android-sdk-license').write_text('\n' + SDK.ACCEPTED_SDK_HASH + '\n')
    # Only the already approved agreement. An unexpected prompt has no stdin reply.
    subprocess.run([str(tools / 'latest/bin/sdkmanager'), '--channel=0', '--sdk_root=' + str(sdk),
                    *INSTALL_PACKAGES], stdin=subprocess.DEVNULL, check=True, timeout=900)
    report['sdkInstalled'] = True
    write_json(output / 'preflight.json', report)


def privacy_check(xml):
    root = ET.fromstring(xml)
    texts = [value for node in root.iter('node') for key in ['text', 'content-desc']
             if (value := node.get(key, ''))]
    if any(re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', text) for text in texts):
        raise ValueError('SCREEN_MAY_CONTAIN_PERSONAL_ACCOUNT')
    for node in root.iter('node'):
        if node.get('password') == 'true' or (node.get('class', '').endswith('EditText') and node.get('text', '')):
            raise ValueError('SCREEN_CONTAINS_NONEMPTY_OR_PASSWORD_EDITOR')
    return texts


def bounded_startup_log(data, temporary):
    # Only this fresh emulator's bounded startup tail; never logcat/app data.
    text = data[-128 * 1024:].decode('utf-8', errors='replace')
    lines = text.splitlines()[-160:]
    return '\n'.join('[emulator authentication detail omitted]' if re.search(
        r'jwt|jwks|token|authorization|bearer|secret', line, re.I) else
        line.replace(str(temporary), '[RUNNER_TEMP]') for line in lines) + '\n'


def diagnose(output):
    temporary = Path(os.environ['RUNNER_TEMP']).resolve()
    log = temporary / 'termius-study-emulator.log'
    if log.is_file():
        with log.open('rb') as source:
            source.seek(max(0, log.stat().st_size - 128 * 1024))
            text = bounded_startup_log(source.read(128 * 1024), temporary)
        (output / 'emulator-startup.txt').write_text(text)
        print(text)
    adb = Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb'
    state = 'UNAVAILABLE'
    try:
        value = run([str(adb), '-s', 'emulator-5554', 'get-state'], timeout=5)
        state = value if value in ['device', 'offline', 'bootloader'] else 'UNKNOWN'
    except subprocess.SubprocessError:
        pass
    report = {'createdUTC': utc(), 'sourceSHA': run(['git', 'rev-parse', 'HEAD']),
              'serial': 'emulator-5554', 'adbState': state,
              'startupLogPresent': log.is_file(), 'appLogsCollected': False}
    write_json(output / 'startup-diagnostic.json', report)
    print(json.dumps(report, indent=2))


def observe(output, ready):
    adb = str(Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb')
    def command(*args, binary=False):
        return run([adb, '-s', 'emulator-5554', *args], binary=binary)
    report = {'createdUTC': utc(), 'sourceSHA': run(['git', 'rev-parse', 'HEAD']),
              'actualEmulator': False, 'actualTermiusUI': False, 'termiusInstalled': False,
              'bootReadinessPassed': ready, 'screenshots': [],
              'noUserInputEntered': True, 'noAccountImported': True, 'noPermissionsGranted': True,
              'notAndroidProductAcceptance': True}
    try:
        if command('get-state') != 'device':
            raise ValueError('EMULATOR_UNAVAILABLE')
        qemu = command('shell', 'getprop', 'ro.boot.qemu') or command('shell', 'getprop', 'ro.kernel.qemu')
        api = command('shell', 'getprop', 'ro.build.version.sdk')
        abi = command('shell', 'getprop', 'ro.product.cpu.abi')
        if qemu != '1' or api != '36' or abi != 'x86_64':
            raise ValueError('SINGLE_API36_CLOUD_EMULATOR_REQUIRED')
        report.update({'actualEmulator': True, 'api': int(api), 'abi': abi,
                       'resolution': command('shell', 'wm', 'size'), 'density': command('shell', 'wm', 'density'),
                       'fontScale': command('shell', 'settings', 'get', 'system', 'font_scale'),
                       'model': command('shell', 'getprop', 'ro.product.model')})
        def capture(name):
            command('shell', 'uiautomator', 'dump', '/data/local/tmp/termius-study-ui.xml')
            xml = command('shell', 'cat', '/data/local/tmp/termius-study-ui.xml')
            texts = privacy_check(xml)
            png = command('exec-out', 'screencap', '-p', binary=True)
            if png[:8] != b'\x89PNG\r\n\x1a\n':
                raise ValueError('SCREENSHOT_NOT_PNG')
            (output / name).write_bytes(png)
            report['screenshots'].append({'file': name, 'source': 'actual adb screencap; fresh disposable API36 emulator',
                'capturedUTC': utc(), 'bytes': len(png), 'sha256': digest(png),
                'dimensions': list(struct.unpack('>II', png[16:24])),
                'privacy': 'UI tree checked; no input, imported account or user data'})
            return texts
        capture('01-emulator-startup.png')
        installed = command('shell', 'pm', 'list', 'packages', TERMIUS)
        report['termiusInstalled'] = ('package:' + TERMIUS) in installed.splitlines()
        if not ready:
            report['status'] = 'EMULATOR_STARTUP_BLOCKED'
        elif 'package:com.android.vending' not in command('shell', 'pm', 'list', 'packages', 'com.android.vending').splitlines():
            report['status'] = 'OFFICIAL_PLAY_STORE_UNAVAILABLE'
        else:
            # Opens the official store only. Never clicks Install, Sign in, Accept or a permission.
            command('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
                    'market://details?id=' + TERMIUS, '-p', 'com.android.vending')
            time.sleep(3)
            texts = capture('02-official-play-entry.png')
            screen = '\n'.join(texts).lower()
            report['status'] = 'OFFICIAL_INSTALL_REQUIRES_USER_ACTION'
            if re.search(r'sign in|sign into|log in', screen):
                report['blocker'] = 'GOOGLE_PLAY_SIGN_IN_REQUIRED'
            elif 'terms' in screen or 'agree' in screen:
                report['blocker'] = 'OFFICIAL_STORE_TERMS_REQUIRE_REVIEW'
            else:
                report['blocker'] = 'STORE_SCREEN_REQUIRES_REVIEW_BEFORE_INSTALL'
            report['observedStudyCoverage'] = 'official store entry only; Termius Hosts/terminal/IME/Home unobserved'
    except (ValueError, ET.ParseError, subprocess.SubprocessError) as error:
        report.update({'status': 'OBSERVATION_BLOCKED', 'blocker': str(error) if isinstance(error, ValueError) else type(error).__name__})
    write_json(output / 'observation.json', report)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as target:
            target.write('\nObservation: **' + report['status'] + '**. Actual Termius UI observed: **false**.\n')
            if 'blocker' in report:
                target.write('\nBlocker: `' + report['blocker'] + '`\n')
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['preflight', 'install', 'diagnose', 'observe'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boot-ready', choices=['true', 'false'], default='false')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.phase == 'preflight':
        preflight(args.output)
    elif args.phase == 'install':
        install(args.output)
    elif args.phase == 'diagnose':
        diagnose(args.output)
    else:
        observe(args.output, args.boot_ready == 'true')


if __name__ == '__main__':
    main()
