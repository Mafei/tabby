"""Safety-path tests; synthetic metadata is not emulator or app acceptance."""
import hashlib
from contextlib import redirect_stdout
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location('termius_study', Path(__file__).with_name('study.py'))
study = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(study)
LICENSE = 'synthetic approved SDK agreement'
DIGEST = hashlib.sha256(LICENSE.encode()).hexdigest()


def catalog(image=False, agreement='android-sdk-license', abi='x86_64'):
    root = ET.Element('repository')
    ET.SubElement(root, 'license', id='android-sdk-license').text = LICENSE
    if agreement != 'android-sdk-license':
        ET.SubElement(root, 'license', id=agreement).text = 'unapproved agreement'
    names = [study.PACKAGE] if image else ['platform-tools', 'emulator', 'cmdline-tools;22.0']
    for name in names:
        p = ET.SubElement(root, 'remotePackage', path=name)
        ET.SubElement(ET.SubElement(p, 'revision'), 'major').text = '1'
        ET.SubElement(p, 'channelRef', ref='channel-0')
        ET.SubElement(p, 'uses-license', ref=agreement)
        if image:
            detail = ET.SubElement(p, 'type-details')
            ET.SubElement(detail, 'api-level').text = '36'
            ET.SubElement(detail, 'abi').text = abi
            ET.SubElement(ET.SubElement(detail, 'tag'), 'id').text = 'google_apis_playstore'
    return ET.tostring(root)


class StudyGuards(unittest.TestCase):
    def preflight(self, directory, image):
        def downloaded(url):
            return catalog() if url == study.SDK.REPOSITORY_URL else image
        with patch.object(study.SDK, 'LICENSE_SHA256', DIGEST), \
             patch.dict(study.os.environ, {'TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256': DIGEST}, clear=True), \
             patch.object(study, 'run', return_value='synthetic-sha'), \
             patch.object(study, 'official_channel', return_value={'apkDownloaded': False}), \
             patch.object(study, 'download', side_effect=downloaded), redirect_stdout(io.StringIO()):
            return study.preflight(directory)

    def test_approved_exact_image_can_progress_but_installs_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            r = self.preflight(directory, catalog(image=True))
            self.assertTrue(r['canInstall'])
            self.assertFalse(r['sdkInstalled'])
            self.assertFalse(r['termiusInstalled'])
            self.assertEqual(r['package'], study.PACKAGE)

    def test_additional_agreement_is_saved_for_review_and_never_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            r = self.preflight(directory, catalog(image=True, agreement='android-sdk-arm-dbt-license'))
            self.assertFalse(r['canInstall'])
            self.assertEqual(r['blocker'], 'SDK_SELECTED_PACKAGE_ADDITIONAL_AGREEMENT')
            self.assertFalse(r['licenseEvidence'][-1]['alreadyApproved'])
            self.assertEqual(r['imageMetadata']['abiValues'], ['x86_64'])
            self.assertEqual((directory / 'license-android-sdk-arm-dbt-license.txt').read_text(), 'unapproved agreement')

    def test_foreign_abi_is_not_a_successful_api36_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            r = self.preflight(Path(temporary), catalog(image=True, abi='arm64-v8a'))
            self.assertFalse(r['canInstall'])
            self.assertEqual(r['blocker'], 'SDK_IMAGE_METADATA_INVALID')

    def test_http_denial_stops_without_alternate_download_or_sdk_install(self):
        with tempfile.TemporaryDirectory() as temporary, \
             patch.dict(study.os.environ, {'TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256': study.SDK.LICENSE_SHA256}, clear=True), \
             patch.object(study, 'run', return_value='synthetic-sha'), \
             patch.object(study, 'official_channel', return_value={}), \
             patch.object(study, 'download', side_effect=urllib.error.HTTPError(study.SDK.REPOSITORY_URL, 403, 'denied', {}, None)) as download, \
             redirect_stdout(io.StringIO()):
            r = study.preflight(Path(temporary))
            self.assertFalse(r['canInstall'])
            self.assertEqual(r['httpStatus'], 403)
            download.assert_called_once_with(study.SDK.REPOSITORY_URL)

    def test_install_rejects_a_blocked_report_before_network_or_license_files(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(study, 'download') as download:
            directory = Path(temporary)
            (directory / 'preflight.json').write_text(json.dumps({'canInstall': False}))
            with self.assertRaisesRegex(ValueError, 'VERIFIED_PREFLIGHT_REQUIRED'):
                study.install(directory)
            download.assert_not_called()
            self.assertEqual([x.name for x in directory.iterdir()], ['preflight.json'])

    def test_capture_rejects_account_text_password_and_nonempty_editor(self):
        for attributes in ["text='person@example.com'", "password='true'", "class='android.widget.EditText' text='typed-value'"]:
            with self.subTest(attributes=attributes), self.assertRaises(ValueError):
                study.privacy_check('<hierarchy><node ' + attributes + '/></hierarchy>')
        self.assertEqual(study.privacy_check('<hierarchy><node text="Sign in"/></hierarchy>'), ['Sign in'])

    def test_preflight_bytes_cannot_change_between_review_and_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.preflight(directory, catalog(image=True))
            (directory / 'repository.xml').write_bytes(b'<changed/>')
            with patch.object(study, 'run', return_value='synthetic-sha'), \
                 patch.dict(study.os.environ, {'TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256': study.SDK.LICENSE_SHA256}, clear=True), \
                 patch.object(study, 'download') as download:
                with self.assertRaisesRegex(ValueError, 'PREFLIGHT_BYTES_CHANGED'):
                    study.install(directory)
                download.assert_not_called()

    def test_startup_diagnostic_is_bounded_and_omits_authentication_details(self):
        data = ('line\n' * 200 + '/temporary/emulator boot\nBearer sensitive\njwt sensitive\n').encode()
        result = study.bounded_startup_log(data, '/temporary')
        self.assertEqual(len(result.splitlines()), 160)
        self.assertNotIn('sensitive', result)
        self.assertNotIn('/temporary', result)
        self.assertIn('[RUNNER_TEMP]/emulator boot', result)


if __name__ == '__main__':
    unittest.main()
