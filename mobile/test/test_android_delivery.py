"""Synthetic ZIP/receipt unit tests; these are not signed-APK delivery evidence."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch
import warnings
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'verify-android-delivery.py'
SPEC = importlib.util.spec_from_file_location('delivery_verifier', SCRIPT)
delivery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(delivery)
COMMIT = 'f890f3dd87ad493c5853c9f34f0563ff3486ef7c'
TREE = '062ce3639d56704bf875279e1d0234fa74c94583'
CERTIFICATE = hashlib.sha256(b'Synthetic test certificate identity').hexdigest()


def native_bytes(machine):
    data = bytearray(64)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HH', data, 16, 3, machine)
    return bytes(data)


class DeliveryBindingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tabby-delivery-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.apk = self.directory / 'arm64.apk'
        self.emulator = self.directory / 'emulator.apk'
        self.common = {
            'AndroidManifest.xml': b'Synthetic binary manifest payload',
            'classes.dex': b'Synthetic application bytecode payload',
            'assets/public/index.html': b'Synthetic bundled UI payload',
            'META-INF/services/example.Service': b'Non-signature metadata must match',
        }
        self.primary_entries = {**self.common, delivery.ARM64: native_bytes(183),
                                'META-INF/TABBY.SF': b'Synthetic primary signature metadata',
                                'META-INF/TABBY.RSA': b'Synthetic primary signature block',
                                'META-INF/MANIFEST.MF': b'Synthetic primary signed manifest'}
        self.emulator_entries = {**self.common, delivery.ARM64: native_bytes(183),
                                 delivery.X86_64: native_bytes(62),
                                 'META-INF/OTHER.SF': b'Different synthetic signature metadata',
                                 'META-INF/OTHER.EC': b'Different synthetic signature block'}
        self.primary_receipt = self.build(self.apk, self.primary_entries, ['arm64-v8a'])
        self.emulator_receipt = self.build(self.emulator, self.emulator_entries, ['arm64-v8a', 'x86_64'])
        self.runtime = {
            'suite': 'real-android-emulator', 'passed': True, 'scope': 'native-and-webview',
            'instrumentation': {'passed': True, 'tests': 8, 'skipped': 0},
            'webview': {'passed': True, 'cases': delivery.WEBVIEW_CASES.copy(), 'skipped': 0},
            'tmux': {'passed': True, 'instrumentation': {'passed': True, 'tests': 4, 'skipped': 0},
                     'webview': {'passed': True, 'cases': delivery.TMUX_WEBVIEW_CASES.copy(), 'skipped': 0}},
            'apks': {'appSHA256': self.emulator_receipt['sha256']},
            'android': {'api': 35, 'abi': 'x86_64'},
            'compatibility': {'requestedForm': 'phone', 'width': 1080, 'height': 2400, 'density': 480,
                              'webViewPackage': 'com.android.webview', 'webViewVersion': '133.0.1.2', 'physicalDevice': False},
        }

    def build(self, path, entries, abis, duplicate=None):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, data in entries.items():
                    archive.writestr(name, data)
                if duplicate is not None:
                    archive.writestr(duplicate, entries[duplicate])
        libraries = {}
        for abi in abis:
            data = entries[f'lib/{abi}/libtabby_ssh.so']
            libraries[abi] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                              'machine': 183 if abi == 'arm64-v8a' else 62}
        return {
            'verified': True, 'artifact': path.name,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size,
            'sourceCommit': COMMIT, 'sourceTree': TREE, 'sourceDirty': False,
            'applicationId': delivery.APP, 'signatureScheme': 'v2',
            'publicTestCertificateSHA256': CERTIFICATE,
            'expectedABIs': abis.copy(), 'packagedABIs': abis.copy(), 'nativeLibraries': libraries,
        }

    def check(self):
        return delivery.verify_delivery(self.apk, self.emulator, self.primary_receipt,
                                        self.emulator_receipt, self.runtime, COMMIT, TREE)

    def reject(self, code):
        with self.assertRaises(delivery.DeliveryError) as error:
            self.check()
        self.assertEqual(str(error.exception), 'ANDROID_DELIVERY_' + code)

    def rebuild_primary(self, entries, duplicate=None):
        self.primary_receipt = self.build(self.apk, entries, ['arm64-v8a'], duplicate)

    def test_same_payload_and_arm64_library_bind_to_executed_x86_apk(self):
        result = self.check()
        self.assertTrue(result['verified'])
        self.assertEqual(result['commonPayloadMemberCount'], len(self.common))
        self.assertEqual(result['appSHA256'], self.primary_receipt['sha256'])
        self.assertEqual(result['testedAppSHA256'], self.runtime['apks']['appSHA256'])
        self.assertEqual(result['arm64LibrarySHA256'], hashlib.sha256(native_bytes(183)).hexdigest())
        self.assertEqual(result['sourceCommit'], COMMIT)
        self.assertEqual(result['sourceTree'], TREE)
        self.assertEqual(result['runtime'], {'api': 35, 'abi': 'x86_64'})
        self.assertIs(result['deliveredABIExecuted'], False)
        self.assertNotIn('Synthetic', json.dumps(result))

    def test_compression_order_and_signature_metadata_do_not_change_payload_digest(self):
        first = self.check()['commonPayloadSHA256']
        with zipfile.ZipFile(self.apk, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in reversed(list(self.primary_entries.items())):
                archive.writestr(name, data)
        self.primary_receipt['sha256'] = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.primary_receipt['bytes'] = self.apk.stat().st_size
        self.assertEqual(self.check()['commonPayloadSHA256'], first)

    def test_payload_content_change_rejected_even_with_updated_apk_receipt(self):
        self.rebuild_primary({**self.primary_entries, 'classes.dex': b'Changed application payload'})
        self.reject('PAYLOAD_CONTENT_MISMATCH')

    def test_payload_member_missing_rejected(self):
        entries = self.primary_entries.copy()
        del entries['assets/public/index.html']
        self.rebuild_primary(entries)
        self.reject('PAYLOAD_MEMBERS_MISMATCH')

    def test_non_signature_meta_inf_member_cannot_be_excluded(self):
        self.rebuild_primary({**self.primary_entries, 'META-INF/extra.json': b'Changed metadata'})
        self.reject('PAYLOAD_MEMBERS_MISMATCH')

    def test_nested_signature_like_member_cannot_be_excluded(self):
        self.rebuild_primary({**self.primary_entries, 'META-INF/nested/TABBY.SF': b'Not an allowed signature path'})
        self.reject('PAYLOAD_MEMBERS_MISMATCH')

    def test_arm64_bytes_change_rejected_even_with_updated_library_receipt(self):
        changed = bytearray(native_bytes(183))
        changed[-1] = 1
        self.rebuild_primary({**self.primary_entries, delivery.ARM64: bytes(changed)})
        self.reject('ARM64_CONTENT_MISMATCH')

    def test_extra_native_path_rejected(self):
        self.rebuild_primary({**self.primary_entries, 'lib/arm64-v8a/extra.so': native_bytes(183)})
        self.reject('NATIVE_PATHS_MISMATCH')

    def test_extra_native_abi_rejected(self):
        self.rebuild_primary({**self.primary_entries, 'lib/armeabi-v7a/libtabby_ssh.so': b'Extra ABI'})
        self.reject('NATIVE_PATHS_MISMATCH')

    def test_duplicate_zip_entries_rejected_even_if_bytes_match(self):
        self.rebuild_primary(self.primary_entries, 'classes.dex')
        self.reject('DUPLICATE_ZIP_ENTRY')

    def test_duplicate_signature_entries_are_not_hidden_by_signature_exclusion(self):
        self.rebuild_primary(self.primary_entries, 'META-INF/TABBY.SF')
        self.reject('DUPLICATE_ZIP_ENTRY')

    def test_path_traversal_zip_member_rejected(self):
        self.rebuild_primary({**self.primary_entries, 'assets/../classes.dex': b'Unsafe alias'})
        self.reject('ZIP_PATH_INVALID')

    def test_apk_sha_and_library_sha_receipts_bind_actual_bytes(self):
        for field, code in [('apk', 'APK_SHA_MISMATCH'), ('library', 'NATIVE_RECEIPT_MISMATCH')]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.primary_receipt)
                if field == 'apk':
                    self.primary_receipt['sha256'] = '0' * 64
                else:
                    self.primary_receipt['nativeLibraries']['arm64-v8a']['sha256'] = '0' * 64
                self.reject(code)
                self.primary_receipt = original

    def test_source_commit_tree_dirty_and_unverified_receipts_rejected(self):
        for field, value, code in [('sourceCommit', '0' * 40, 'SOURCE_MISMATCH'),
                                   ('sourceTree', '0' * 40, 'SOURCE_MISMATCH'),
                                   ('sourceDirty', True, 'SOURCE_DIRTY'),
                                   ('sourceDirty', 0, 'SOURCE_DIRTY'),
                                   ('verified', 1, 'APK_NOT_VERIFIED')]:
            with self.subTest(field=field, code=code):
                original = copy.deepcopy(self.emulator_receipt)
                self.emulator_receipt[field] = value
                self.reject(code)
                self.emulator_receipt = original

    def test_certificates_must_match_and_v2_verification_must_be_recorded(self):
        self.emulator_receipt['publicTestCertificateSHA256'] = '1' * 64
        self.reject('CERTIFICATE_MISMATCH')
        self.emulator_receipt['publicTestCertificateSHA256'] = CERTIFICATE
        self.emulator_receipt['signatureScheme'] = 'v1'
        self.reject('APK_IDENTITY_INVALID')

    def test_receipt_abi_lists_must_be_exact(self):
        for field in ['expectedABIs', 'packagedABIs']:
            with self.subTest(field=field):
                self.primary_receipt[field] = ['arm64-v8a', 'x86_64']
                self.reject('RECEIPT_ABIS_MISMATCH')
                self.primary_receipt[field] = ['arm64-v8a']

    def test_runtime_is_bound_to_dual_apk_not_delivered_arm64_apk(self):
        self.runtime['apks']['appSHA256'] = self.primary_receipt['sha256']
        self.reject('RUNTIME_APK_MISMATCH')

    def test_runtime_failure_and_partial_scope_rejected(self):
        for field, value in [('passed', False), ('passed', 1), ('scope', 'native-instrumentation-only'),
                             ('failure', 'FIXED_FAILURE')]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime)
                self.runtime[field] = value
                self.reject('RUNTIME_NOT_PASSED')
                self.runtime = original

    def test_native_tests_require_seven_and_no_skips(self):
        for field, value in [('tests', 6), ('skipped', 1), ('skipped', False), ('passed', False)]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime['instrumentation'])
                self.runtime['instrumentation'][field] = value
                self.reject('NATIVE_TESTS_INCOMPLETE')
                self.runtime['instrumentation'] = original

    def test_webview_requires_all_seven_actual_cases_and_no_skips(self):
        for field, value in [('cases', delivery.WEBVIEW_CASES[:-1]),
                             ('cases', ['Unrelated case'] * 7), ('skipped', 1), ('passed', False)]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime['webview'])
                self.runtime['webview'][field] = value
                self.reject('WEBVIEW_TESTS_INCOMPLETE')
                self.runtime['webview'] = original

    def test_supplemental_tmux_failure_or_missing_scope_rejected(self):
        original = copy.deepcopy(self.runtime['tmux'])
        for value in [None, {}, {'passed': False}, {**original, 'failure': 'FIXED_FAILURE'}]:
            with self.subTest(value=value):
                self.runtime['tmux'] = value
                self.reject('TMUX_NOT_PASSED')
        self.runtime['tmux'] = original

    def test_supplemental_native_requires_all_four_and_zero_skips(self):
        for field, value in [('tests', 3), ('tests', True), ('skipped', 1), ('skipped', False), ('passed', False)]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime['tmux']['instrumentation'])
                self.runtime['tmux']['instrumentation'][field] = value
                self.reject('TMUX_NATIVE_TESTS_INCOMPLETE')
                self.runtime['tmux']['instrumentation'] = original

    def test_supplemental_web_requires_all_five_exact_cases_and_zero_skips(self):
        for field, value in [('cases', delivery.TMUX_WEBVIEW_CASES[:-1]),
                             ('cases', list(reversed(delivery.TMUX_WEBVIEW_CASES))),
                             ('cases', [delivery.TMUX_WEBVIEW_CASES[0]] * 5),
                             ('skipped', 1), ('skipped', False), ('passed', False)]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime['tmux']['webview'])
                self.runtime['tmux']['webview'][field] = value
                self.reject('TMUX_WEBVIEW_TESTS_INCOMPLETE')
                self.runtime['tmux']['webview'] = original

    def test_runtime_requires_verified_stable_api_31_to_37_and_x86_64(self):
        for api in [31, 32, 33, 34, 35, 36, 37]:
            self.runtime['android']['api'] = api
            self.runtime['compatibility']['requestedImage'] = {
                'platform': '37.0' if api == 37 else str(api),
                'tag': 'google_apis' if api == 37 else 'default', 'abi': 'x86_64',
            }
            self.assertEqual(self.check()['runtime']['api'], api)
        self.runtime['compatibility'].pop('requestedImage')
        for field, value in [('api', 30), ('api', 38), ('api', '35'), ('api', '37.0'), ('api', True), ('abi', 'arm64-v8a')]:
            with self.subTest(field=field):
                original = self.runtime['android'].copy()
                self.runtime['android'][field] = value
                self.reject('RUNTIME_PLATFORM_INVALID')
                self.runtime['android'] = original

    def test_api_37_requires_explicit_stable_non_play_image_profile(self):
        self.runtime['android']['api'] = 37
        profile = {'platform': '37.0', 'tag': 'google_apis', 'abi': 'x86_64'}
        self.runtime['compatibility']['requestedImage'] = profile.copy()
        self.assertEqual(self.check()['runtime']['api'], 37)
        for field, value in [('platform', '37'), ('tag', 'default'), ('tag', 'google_apis_playstore'),
                             ('tag', 'google_apis_ps16k'), ('abi', 'arm64-v8a')]:
            with self.subTest(field=field):
                self.runtime['compatibility']['requestedImage'] = {**profile, field: value}
                self.reject('RUNTIME_SELECTED_IMAGE_INVALID')
        self.runtime['compatibility'].pop('requestedImage')
        self.reject('RUNTIME_SELECTED_IMAGE_INVALID')

    def test_compatibility_requires_actual_bounded_geometry_and_webview_identity(self):
        for field, value in [('requestedForm', 'foldable-oppo'), ('width', True), ('height', 0),
                             ('density', 0), ('physicalDevice', True), ('webViewPackage', 'unknown'),
                             ('webViewVersion', 'unknown')]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.runtime['compatibility'])
                self.runtime['compatibility'][field] = value
                self.reject('RUNTIME_COMPATIBILITY_INVALID')
                self.runtime['compatibility'] = original
        self.runtime['compatibility']['requestedForm'] = 'tablet'
        self.reject('RUNTIME_TABLET_TOO_SMALL')
        self.runtime['compatibility'].update(width=2560, height=1600, density=320)
        self.assertEqual(self.check()['compatibility']['requestedForm'], 'tablet')
        self.runtime['compatibility']['unexpectedPrivateMetadata'] = 'MUST_NOT_BE_REFLECTED'
        result = self.check()
        self.assertNotIn('unexpectedPrivateMetadata', result['compatibility'])
        self.assertNotIn('MUST_NOT_BE_REFLECTED', json.dumps(result))

    def test_cli_source_check_rejects_any_dirty_checkout(self):
        with patch.object(delivery.subprocess, 'run', return_value=types.SimpleNamespace(stdout=' M tracked-input\n')):
            with self.assertRaises(delivery.DeliveryError) as error:
                delivery.source_identity()
        self.assertEqual(str(error.exception), 'ANDROID_DELIVERY_SOURCE_DIRTY')

    def test_duplicate_json_keys_rejected_with_fixed_diagnostic(self):
        path = self.directory / 'duplicate.json'
        path.write_text('{"verified":false,"verified":true}')
        with self.assertRaises(delivery.DeliveryError) as error:
            delivery.read_document(path)
        self.assertEqual(str(error.exception), 'ANDROID_DELIVERY_DUPLICATE_JSON_KEY')

    def test_cli_output_cannot_overwrite_any_input(self):
        result = subprocess.run(['python3', str(SCRIPT), '--apk', str(self.apk),
                                 '--emulator-apk', str(self.emulator), '--apk-report', 'unused-primary.json',
                                 '--emulator-report', 'unused-emulator.json', '--runtime-report', 'unused-runtime.json',
                                 '--report', str(self.apk)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr.strip(), 'ANDROID_DELIVERY_OUTPUT_PATH_COLLISION')


if __name__ == '__main__':
    unittest.main()
