#!/usr/bin/env python3
"""Fetch pinned fonts at build time; --verify performs no network requests."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('font-manifest.json')
BUDGET = 50 * 1024 * 1024


def fail(message):
    raise ValueError(message)


def plain_file(path):
    # Reject symlinks in every existing ancestor as well as the final file.
    for part in (path, *path.parents):
        if part.is_symlink():
            fail('FONT_PATH_SYMLINK')
    if path.exists() and not path.is_file():
        fail('FONT_PATH_NOT_FILE')


def verified(path, entry):
    plain_file(path)
    if not path.exists():
        return False
    if path.stat().st_size != entry['bytes']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest() == entry['sha256']


def load_manifest():
    plain_file(MANIFEST)
    manifest = json.loads(MANIFEST.read_text())
    fonts = manifest['fonts']
    if manifest['schemaVersion'] != 1 or manifest['budgetBytes'] != BUDGET:
        fail('FONT_MANIFEST_VERSION_OR_BUDGET')
    if len(fonts) != 5 or len({f['file'] for f in fonts}) != 5:
        fail('FONT_MANIFEST_FILE_SET')
    if sum(f['bytes'] for f in fonts) > BUDGET:
        fail('FONT_BUDGET_EXCEEDED')
    for entry in [*fonts, *manifest['licenses']]:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', entry['file']):
            fail('FONT_MANIFEST_FILENAME')
        if type(entry['bytes']) is not int or not 0 < entry['bytes'] <= BUDGET:
            fail('FONT_MANIFEST_SIZE')
        if not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']):
            fail('FONT_MANIFEST_HASH')
        if 'source' in entry:
            source = entry['source']
            if not re.fullmatch(r'[0-9a-f]{40}', source['revision']):
                fail('FONT_SOURCE_NOT_IMMUTABLE')
            if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', source['repository']):
                fail('FONT_SOURCE_REPOSITORY')
            if any(p in ('', '.', '..') for p in source['path'].split('/')):
                fail('FONT_SOURCE_PATH')
            expected = f"https://raw.githubusercontent.com/{source['repository']}/{source['revision']}/{source['path']}"
            if source['url'] != expected:
                fail('FONT_SOURCE_URL')
    license_names = {entry['file'] for entry in manifest['licenses']}
    if len(license_names) != len(manifest['licenses']):
        fail('FONT_LICENSE_DUPLICATE')
    for font in fonts:
        if not font['licenseFiles'] or not set(font['licenseFiles']) <= license_names:
            fail('FONT_LICENSE_REFERENCE')
    return manifest


def fetch(entry, destination):
    # Empty curl config prevents implicit user config/auth/redirect options.
    # Direct immutable raw URLs need no redirects, cookies or authentication.
    fd, temporary = tempfile.mkstemp(prefix='.font-download-', dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary)
    try:
        process = subprocess.Popen([
            'curl', '--disable', '--fail', '--silent', '--show-error',
            '--proto', '=https', '--tlsv1.2', '--connect-timeout', '15',
            '--max-time', '90', '--max-filesize', str(entry['bytes']),
            entry['source']['url'],
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            total = 0
            with temporary.open('wb') as stream:
                while chunk := process.stdout.read(64 * 1024):
                    total += len(chunk)
                    if total > entry['bytes']:
                        fail('FONT_DOWNLOAD_SIZE_EXCEEDED')
                    stream.write(chunk)
            if process.wait(timeout=5) != 0:
                fail('FONT_DOWNLOAD_FAILED')
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
        if not verified(temporary, entry):
            fail('FONT_DOWNLOAD_HASH_OR_SIZE')
        plain_file(destination)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(output, verify_only=False):
    manifest = load_manifest()
    output = output.absolute()
    plain_file(output / 'path-check')
    if not verify_only:
        output.mkdir(parents=True, exist_ok=True)
    if not output.is_dir():
        fail('FONT_OUTPUT_MISSING')
    for entry in manifest['licenses']:
        if not verified(MANIFEST.parent / 'licenses' / entry['file'], entry):
            fail('FONT_LICENSE_HASH_OR_SIZE')
    if verify_only:
        expected = {entry['file'] for entry in manifest['fonts']}
        if {p.name for p in output.iterdir()} != expected:
            fail('FONT_OUTPUT_FILE_SET')
    for entry in manifest['fonts']:
        destination = output / entry['file']
        if not verified(destination, entry):
            if verify_only:
                fail('FONT_FILE_HASH_OR_SIZE')
            fetch(entry, destination)
    if {p.name for p in output.iterdir()} != {entry['file'] for entry in manifest['fonts']}:
        fail('FONT_OUTPUT_FILE_SET')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'tabby-terminal/src/fonts/bundled')
    args = parser.parse_args()
    manifest = prepare(args.output_dir, args.verify)
    print(json.dumps({'verified': True, 'fontCount': len(manifest['fonts']),
                      'fontBytes': sum(f['bytes'] for f in manifest['fonts']),
                      'licenseCount': len(manifest['licenses']), 'runtimeNetworkRequired': False}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        raise SystemExit('FONT_PREPARATION_FAILED')
