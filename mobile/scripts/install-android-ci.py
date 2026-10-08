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
REPOSITORY_URL = 'https://dl.google.com/android/repository/repository2-3.xml'
IMAGE_URLS = {
    'default': 'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'google_apis': 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml',
}


def children(element, name):
    return [child for child in element if child.tag.split('}')[-1] == name]


def image_selection(api, platform=None, tag=None):
    """Runtime API and SDK package platform are deliberately separate values."""
    if type(api) is not int or api not in [31, 32, 33, 34, 35, 36, 37]:
        raise SystemExit('SDK_IMAGE_SELECTION_INVALID')
    expected = (str(api), 'default') if api <= 36 else ('37.0', 'google_apis')
    # Preserve the original API31--36 CLI default. API37 must explicitly name
    # the stable decimal-platform Google APIs image, never a guessed fallback.
    if api <= 36:
        platform = str(api) if platform is None else platform
        tag = 'default' if tag is None else tag
    if (platform, tag) != expected:
        raise SystemExit('SDK_IMAGE_SELECTION_INVALID')
    return {'runtimeAPI': api, 'platform': platform, 'tag': tag,
            'package': f'system-images;android-{platform};{tag};x86_64',
            'metadataURL': IMAGE_URLS[tag],
            'systemImage': f'system-images/android-{platform}/{tag}/x86_64/system.img'}


def verified_packages(root, requested, image=None):
    """Verify selected stable packages, ignoring unrelated agreements/images."""
    licenses = [item for item in children(root, 'license') if item.get('id') == 'android-sdk-license']
    if len(licenses) != 1 or type(licenses[0].text) is not str \
            or hashlib.sha256(licenses[0].text.encode()).hexdigest() != LICENSE_SHA256:
        raise SystemExit('SDK_APPROVED_LICENSE_CHANGED')
    selected = set()
    for name in requested:
        stable = [package for package in children(root, 'remotePackage') if package.get('path') == name
                  and len(children(package, 'channelRef')) == 1
                  and children(package, 'channelRef')[0].get('ref') == 'channel-0']
        if len(stable) > 1:
            raise SystemExit('SDK_STABLE_PACKAGE_AMBIGUOUS')
        if not stable:
            continue
        package = stable[0]
        revisions = children(package, 'revision')
        if package.get('obsolete') == 'true' or len(revisions) != 1 or children(revisions[0], 'preview'):
            raise SystemExit('SDK_SELECTED_PACKAGE_NOT_STABLE')
        agreements = [item.get('ref') for item in children(package, 'uses-license')]
        if agreements != ['android-sdk-license']:
            raise SystemExit('SDK_SELECTED_PACKAGE_ADDITIONAL_AGREEMENT')
        if image and name == image['package']:
            details = children(package, 'type-details')
            if len(details) != 1:
                raise SystemExit('SDK_IMAGE_METADATA_INVALID')
            api_values = children(details[0], 'api-level')
            abis = children(details[0], 'abi')
            tags = [item.text for entry in children(details[0], 'tag') for item in children(entry, 'id')]
            if len(api_values) != 1 or api_values[0].text != image['platform'] \
                    or len(abis) != 1 or abis[0].text != 'x86_64' or tags.count(image['tag']) != 1:
                raise SystemExit('SDK_IMAGE_METADATA_INVALID')
        selected.add(name)
    return selected


def download(url, destination, maximum=512 * 1024 * 1024):
    with urllib.request.urlopen(url, timeout=90) as response, destination.open('wb') as output:
        total = 0
        while block := response.read(1024 * 1024):
            total += len(block)
            if total > maximum:
                raise SystemExit('SDK_DOWNLOAD_SIZE_LIMIT')
            output.write(block)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--emulator-api', type=int, choices=[31, 32, 33, 34, 35, 36, 37], default=35)
    parser.add_argument('--emulator-platform', choices=['31', '32', '33', '34', '35', '36', '37.0'])
    parser.add_argument('--emulator-tag', choices=['default', 'google_apis'])
    args = parser.parse_args()
    image = image_selection(args.emulator_api, args.emulator_platform, args.emulator_tag)
    packages = BASE_PACKAGES + [image['package']]
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
        ('repository.xml', REPOSITORY_URL),
        ('system-images.xml', image['metadataURL']),
    ]:
        path = downloads / name
        download(url, path, maximum=8 * 1024 * 1024)
        root = ET.parse(path).getroot()
        selected.update(verified_packages(root, metadata_packages, image))
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
                     image['systemImage']]:
        if not (sdk / relative).is_file():
            raise SystemExit('SDK installation incomplete: ' + relative)
    print(f"Approved stable SDK 36, NDK and {image['package']} installed (runtime API {image['runtimeAPI']})")


if __name__ == '__main__':
    main()
