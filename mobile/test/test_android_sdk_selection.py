"""SDK selection/rejection tests. Synthetic metadata is not installation proof."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/install-android-ci.py'
SPEC = importlib.util.spec_from_file_location('android_ci_installer', SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
LICENSE = 'synthetic approved SDK agreement'
DIGEST = hashlib.sha256(LICENSE.encode()).hexdigest()


def metadata(path, *, license_ref='android-sdk-license', channel='channel-0', api='37.0', abi='x86_64', tag='google_apis'):
    root = ET.Element('repository')
    ET.SubElement(root, 'license', id='android-sdk-license').text = LICENSE
    package = ET.SubElement(root, 'remotePackage', path=path)
    revision = ET.SubElement(package, 'revision')
    ET.SubElement(revision, 'major').text = '6'
    ET.SubElement(package, 'channelRef', ref=channel)
    ET.SubElement(package, 'uses-license', ref=license_ref)
    details = ET.SubElement(package, 'type-details')
    ET.SubElement(details, 'api-level').text = api
    ET.SubElement(details, 'abi').text = abi
    ET.SubElement(ET.SubElement(details, 'tag'), 'id').text = tag
    return root


class SDKSelectionTest(unittest.TestCase):
    def setUp(self):
        self.digest = patch.object(installer, 'LICENSE_SHA256', DIGEST)
        self.digest.start()
        self.addCleanup(self.digest.stop)
        self.image = installer.image_selection(37, '37.0', 'google_apis')

    def verify(self, root):
        return installer.verified_packages(root, {self.image['package']}, self.image)

    def test_original_six_api_selections_remain_exact_aosp_defaults(self):
        for api in [31, 32, 33, 34, 35, 36]:
            selected = installer.image_selection(api)
            self.assertEqual(selected['package'], f'system-images;android-{api};default;x86_64')
            self.assertEqual(selected['runtimeAPI'], api)
            self.assertEqual(selected['metadataURL'], installer.IMAGE_URLS['default'])

    def test_api_37_is_explicit_decimal_platform_and_non_play_google_apis_only(self):
        self.assertEqual(self.image['package'], 'system-images;android-37.0;google_apis;x86_64')
        self.assertEqual(self.image['runtimeAPI'], 37)
        self.assertEqual(self.image['systemImage'], 'system-images/android-37.0/google_apis/x86_64/system.img')
        for api, platform, tag in [(37, None, None), (37, '37', 'google_apis'), (37, '37.0', 'default'),
                                   (37, '37.0', 'google_apis_playstore'), (37, '37.0', 'google_apis_ps16k'),
                                   (36, '37.0', 'google_apis'), (38, '38', 'default'), (True, '37.0', 'google_apis')]:
            with self.subTest(api=api, platform=platform, tag=tag):
                with self.assertRaisesRegex(SystemExit, '^SDK_IMAGE_SELECTION_INVALID$'):
                    installer.image_selection(api, platform, tag)

    def test_stable_exact_image_and_approved_agreement_are_selected(self):
        root = metadata(self.image['package'])
        # This documented secondary tag does not change the selected package.
        ET.SubElement(ET.SubElement(root[-1].find('type-details'), 'tag'), 'id').text = 'ai_glasses_compatible'
        ET.SubElement(root, 'license', id='unselected-other-license').text = 'another agreement'
        self.assertEqual(self.verify(root), {self.image['package']})

    def test_missing_changed_or_duplicate_approved_agreement_fails_closed(self):
        for mutation in [lambda root: root.remove(root[0]), lambda root: setattr(root[0], 'text', 'changed agreement'),
                         lambda root: ET.SubElement(root, 'license', id='android-sdk-license')]:
            root = metadata(self.image['package']); mutation(root)
            with self.assertRaisesRegex(SystemExit, '^SDK_APPROVED_LICENSE_CHANGED$'):
                self.verify(root)

    def test_additional_selected_agreement_is_never_accepted(self):
        for agreement in ['android-sdk-preview-license', 'android-sdk-arm-dbt-license', 'intel-android-sysimage-license']:
            with self.assertRaisesRegex(SystemExit, '^SDK_SELECTED_PACKAGE_ADDITIONAL_AGREEMENT$'):
                self.verify(metadata(self.image['package'], license_ref=agreement))
        root = metadata(self.image['package'])
        ET.SubElement(root[-1], 'uses-license', ref='android-sdk-license')
        with self.assertRaisesRegex(SystemExit, '^SDK_SELECTED_PACKAGE_ADDITIONAL_AGREEMENT$'):
            self.verify(root)

    def test_preview_obsolete_or_duplicate_stable_package_cannot_be_selected(self):
        self.assertEqual(self.verify(metadata(self.image['package'], channel='channel-1')), set())
        for mutation in [lambda package: ET.SubElement(package.find('revision'), 'preview'),
                         lambda package: package.set('obsolete', 'true')]:
            root = metadata(self.image['package']); mutation(root[-1])
            with self.assertRaisesRegex(SystemExit, '^SDK_SELECTED_PACKAGE_NOT_STABLE$'):
                self.verify(root)
        root = metadata(self.image['package']); root.append(metadata(self.image['package'])[-1])
        with self.assertRaisesRegex(SystemExit, '^SDK_STABLE_PACKAGE_AMBIGUOUS$'):
            self.verify(root)

    def test_image_details_do_not_confuse_runtime_api_platform_or_foreign_abi(self):
        for field, value in [('api', '37'), ('abi', 'arm64-v8a'), ('tag', 'google_apis_ps16k')]:
            with self.assertRaisesRegex(SystemExit, '^SDK_IMAGE_METADATA_INVALID$'):
                self.verify(metadata(self.image['package'], **{field: value}))

    def test_changed_image_agreement_stops_before_license_file_or_sdkmanager(self):
        with tempfile.TemporaryDirectory(prefix='tabby-sdk-selection-') as temporary:
            sdk = Path(temporary) / 'sdk'
            def downloaded(url, destination, **_options):
                root = metadata(self.image['package'], license_ref='android-sdk-arm-dbt-license')
                destination.write_bytes(ET.tostring(root))
            with patch.object(installer.sys, 'argv', ['install-android-ci.py', '--emulator-api', '37', '--emulator-platform', '37.0', '--emulator-tag', 'google_apis']), \
                 patch.dict(installer.os.environ, {'ANDROID_HOME': str(sdk), 'TABBY_ANDROID_SDK_LICENSE_APPROVED_SHA256': DIGEST}), \
                 patch.object(installer, 'download', downloaded), patch.object(installer.subprocess, 'run') as run:
                with self.assertRaisesRegex(SystemExit, '^SDK_SELECTED_PACKAGE_ADDITIONAL_AGREEMENT$'):
                    installer.main()
                run.assert_not_called()
                self.assertFalse((sdk / 'licenses').exists())

    def test_download_byte_limit_rejects_before_appending_oversized_block(self):
        with tempfile.TemporaryDirectory(prefix='tabby-sdk-download-unit-') as temporary:
            destination = Path(temporary) / 'metadata.xml'
            with patch.object(installer.urllib.request, 'urlopen', return_value=io.BytesIO(b'12345')):
                with self.assertRaisesRegex(SystemExit, '^SDK_DOWNLOAD_SIZE_LIMIT$'):
                    installer.download(installer.REPOSITORY_URL, destination, maximum=4)
            self.assertEqual(destination.stat().st_size, 0)


if __name__ == '__main__':
    unittest.main()
