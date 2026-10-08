#!/usr/bin/env python3
"""Validate real pinned fonts and hostile download/filesystem boundaries."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('audit_fonts', Path(__file__).with_name('audit-fonts.py'))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
FETCH = AUDIT.FETCH
REAL_POPEN = subprocess.Popen


class FontBoundaryTests(unittest.TestCase):
    def test_real_bundle_cmap_and_nominal_braille_advance(self):
        report = AUDIT.audit(FETCH.ROOT / 'tabby-terminal/src/fonts/bundled')
        self.assertEqual(report['fontBytes'], 35242120)
        self.assertEqual(report['stackCoverage']['braille']['present'], 256)
        self.assertTrue(report['brailleMatchesMonoAdvance'])
        self.assertEqual(report['observedStackCoverage']['cjkExtensionB']['missing'], ['U+20000'])
        self.assertFalse(report['renderingVerified'])

    def test_existing_verified_bundle_performs_no_download(self):
        with patch.object(FETCH.subprocess, 'Popen', side_effect=AssertionError('UNEXPECTED_NETWORK')):
            FETCH.prepare(FETCH.ROOT / 'tabby-terminal/src/fonts/bundled')

    def test_actual_git_autocrlf_checkout_preserves_all_pinned_notice_bytes(self):
        # Exercise Git's real checkout conversion, as used by the Windows runner.
        # A text control must change to CRLF while upstream notice bytes stay exact.
        manifest = FETCH.load_manifest()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / 'repository'
            checkout = base / 'checkout'
            repository.mkdir()
            checkout.mkdir()
            licenses = repository / 'scripts/fonts/licenses'
            licenses.mkdir(parents=True)
            shutil.copyfile(FETCH.ROOT / '.gitattributes', repository / '.gitattributes')
            for entry in manifest['licenses']:
                shutil.copyfile(FETCH.MANIFEST.parent / 'licenses' / entry['file'], licenses / entry['file'])
            (repository / 'checkout-control.txt').write_bytes(b'first line\nsecond line\n')
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
            def git(*args):
                subprocess.run(['git', '-C', str(repository), *args], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=15)
            git('init', '--quiet')
            git('-c', 'core.autocrlf=false', 'add', '--', '.gitattributes', 'scripts/fonts/licenses', 'checkout-control.txt')
            git('-c', 'core.autocrlf=true', 'checkout-index', '--all', '--prefix=' + str(checkout) + os.sep)
            self.assertEqual((checkout / 'checkout-control.txt').read_bytes(), b'first line\r\nsecond line\r\n')
            self.assertEqual(len(manifest['licenses']), 20)
            for entry in manifest['licenses']:
                data = (checkout / 'scripts/fonts/licenses' / entry['file']).read_bytes()
                self.assertEqual(len(data), entry['bytes'], entry['file'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'], entry['file'])

    def test_output_parent_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'real').mkdir()
            (base / 'link').symlink_to(base / 'real', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'FONT_PATH_SYMLINK'):
                FETCH.prepare(base / 'link' / 'bundle')
            self.assertEqual(list((base / 'real').iterdir()), [])

    def test_verified_file_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'real').write_bytes(b'font')
            (base / 'link').symlink_to(base / 'real')
            entry = {'bytes': 4, 'sha256': hashlib.sha256(b'font').hexdigest()}
            with self.assertRaisesRegex(ValueError, 'FONT_PATH_SYMLINK'):
                FETCH.verified(base / 'link', entry)

    def run_child_download(self, script, message):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'font.ttf'
            destination.write_bytes(b'original')
            entry = {'bytes': 4, 'sha256': hashlib.sha256(b'font').hexdigest(),
                     'source': {'url': 'https://raw.githubusercontent.com/public/example/' + 'a' * 40 + '/font.ttf'}}
            # Real child/process pipe tests streaming and cleanup, with no network.
            def child(*args, **kwargs):
                return REAL_POPEN([sys.executable, '-c', script], **kwargs)
            with patch.object(FETCH.subprocess, 'Popen', side_effect=child):
                with self.assertRaisesRegex(ValueError, message):
                    FETCH.fetch(entry, destination)
            self.assertEqual(destination.read_bytes(), b'original')
            self.assertEqual([p.name for p in destination.parent.iterdir()], ['font.ttf'])

    def test_oversized_actual_child_stream_terminated_without_replacing(self):
        self.run_child_download('import sys; sys.stdout.buffer.write(b"X" * 10000000)', 'FONT_DOWNLOAD_SIZE_EXCEEDED')

    def test_corrupt_actual_child_bytes_without_replacing(self):
        self.run_child_download('import sys; sys.stdout.buffer.write(b"bad!")', 'FONT_DOWNLOAD_HASH_OR_SIZE')

    def test_failed_actual_child_without_replacing(self):
        self.run_child_download('import sys; sys.exit(1)', 'FONT_DOWNLOAD_FAILED')

    def test_extra_output_file_rejected(self):
        manifest = FETCH.load_manifest()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for font in manifest['fonts']:
                shutil.copyfile(FETCH.ROOT / 'tabby-terminal/src/fonts/bundled' / font['file'], output / font['file'])
            (output / 'untracked-font.ttf').write_bytes(b'not authorized')
            with self.assertRaisesRegex(ValueError, 'FONT_OUTPUT_FILE_SET'):
                FETCH.prepare(output, verify_only=True)

    def test_mutated_license_rejected_before_download(self):
        manifest = FETCH.load_manifest()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'licenses').mkdir()
            for entry in manifest['licenses']:
                (base / 'licenses' / entry['file']).write_bytes((FETCH.MANIFEST.parent / 'licenses' / entry['file']).read_bytes())
            (base / 'licenses' / manifest['licenses'][0]['file']).write_bytes(b'tampered')
            manifest_path = base / 'font-manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            with patch.object(FETCH, 'MANIFEST', manifest_path), patch.object(FETCH.subprocess, 'Popen', side_effect=AssertionError('UNEXPECTED_NETWORK')):
                with self.assertRaisesRegex(ValueError, 'FONT_LICENSE_HASH_OR_SIZE'):
                    FETCH.prepare(base / 'output')

    def test_unpinned_source_rejected_before_network(self):
        manifest = FETCH.load_manifest()
        manifest['fonts'][0]['source']['revision'] = 'master'
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / 'font-manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            with patch.object(FETCH, 'MANIFEST', manifest_path):
                with self.assertRaisesRegex(ValueError, 'FONT_SOURCE_NOT_IMMUTABLE'):
                    FETCH.load_manifest()


if __name__ == '__main__':
    unittest.main()
