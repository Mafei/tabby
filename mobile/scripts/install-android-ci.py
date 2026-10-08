#!/usr/bin/env python3
"""Install the approved stable SDK in a disposable CI directory.

This deliberately never runs `sdkmanager --licenses` or accepts another
agreement. A changed SDK agreement fails closed for a fresh user decision.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

LICENSE_SHA256 = '1f8729233617b193fd619213792ae16a41b95d2bbbf525dfe66998252ba68b16'
ACCEPTED_SDK_HASH = '24333f8a63b6825ea9c5514f83c2829b004d1fee'
CLI_SHA256 = '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583'
BASE_PACKAGES = [
    'platform-tools', 'platforms;android-36', 'build-tools;36.0.0',
    'ndk;27.3.13750724', 'emulator',
]


def download(url, destination):
    with urllib.request.urlopen(url, timeout=90) as response, destination.open('wb') as output:
        while block := response.read(1024 * 1024):
            output.write(block)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--emulator-api', type=int, choices=[31, 32, 33, 34, 35, 36], default=35)
    args = parser.parse_args()
    image = f'system-images;android-{args.emulator_api};default;x86_64'
    packages = BASE_PACKAGES + [image]
    metadata_packages = set(packages + ['cmdline-tools;22.0'])
    if os.environ.get('TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256') != LICENSE_SHA256:
        raise SystemExit('The explicit approval for this exact SDK agreement is required')
    sdk = Path(os.environ['ANDROID_HOME']).resolve()
    if sdk.exists() and any(sdk.iterdir()):
        raise SystemExit('Use an empty disposable SDK directory, not an existing personal SDK')
    sdk.mkdir(parents=True, exist_ok=True)
    downloads = sdk.parent / 'android-approved-downloads'
    downloads.mkdir(exist_ok=True)
    selected = set()
    for name, url in [
        ('repository.xml', 'https://dl.google.com/android/repository/repository2-3.xml'),
        ('system-images.xml', 'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml'),
    ]:
        path = downloads / name
        download(url, path)
        root = ET.parse(path).getroot()
        license = next(x for x in root if x.tag.endswith('license') and x.get('id') == 'android-sdk-license')
        if hashlib.sha256(license.text.encode()).hexdigest() != LICENSE_SHA256:
            raise SystemExit('The Android SDK agreement changed; no agreement was accepted')
        for package in root:
            if not package.tag.endswith('remotePackage') or package.get('path') not in metadata_packages:
                continue
            channel = next((x.get('ref') for x in package if x.tag.endswith('channelRef')), 'channel-0')
            if channel != 'channel-0':
                continue
            agreements = [x.get('ref') for x in package if x.tag.endswith('uses-license')]
            if set(agreements) != {'android-sdk-license'}:
                raise SystemExit('A selected package requires an additional agreement; installation stopped')
            selected.add(package.get('path'))
    if selected != metadata_packages:
        raise SystemExit('The exact stable package set could not be verified')
    archive = downloads / 'commandlinetools-linux-15859902_latest.zip'
    download('https://dl.google.com/android/repository/' + archive.name, archive)
    if hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != CLI_SHA256:
        raise SystemExit('Official command-line tools checksum mismatch')
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            if item.filename.startswith('/') or '..' in Path(item.filename).parts:
                raise SystemExit('Unsafe SDK archive path')
        zipped.extractall(downloads)
    tools = sdk / 'cmdline-tools'
    tools.mkdir()
    (downloads / 'cmdline-tools').rename(tools / 'latest')
    for executable in (tools / 'latest' / 'bin').iterdir():
        executable.chmod(executable.stat().st_mode | 0o111)
    licenses = sdk / 'licenses'
    licenses.mkdir()
    # User approved this SDK agreement on 2026-10-07 at 09:12 UTC. Record
    # only its verified SDK identifier; never accept all installed licenses.
    (licenses / 'android-sdk-license').write_text('\n' + ACCEPTED_SDK_HASH + '\n')
    subprocess.run([
        str(tools / 'latest' / 'bin' / 'sdkmanager'), '--channel=0',
        '--sdk_root=' + str(sdk), *packages,
    ], stdin=subprocess.DEVNULL, check=True)
    for relative in ['platform-tools/adb', 'platforms/android-36/android.jar', 'build-tools/36.0.0/aapt2',
                     'ndk/27.3.13750724/source.properties', 'emulator/emulator',
                     f'system-images/android-{args.emulator_api}/default/x86_64/system.img']:
        if not (sdk / relative).is_file():
            raise SystemExit('SDK installation incomplete: ' + relative)
    print('Approved stable SDK, NDK and AOSP emulator image installed')


if __name__ == '__main__':
    main()
