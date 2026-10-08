import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts' / 'manifest_policy.py'
spec = importlib.util.spec_from_file_location('manifest_policy', path)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
SERVICE = '''  E: application
    E: service
      A: android:name(0x1)="org.tabby.android.prototype.ConnectionService"
      A: android:exported(0x2)=false
      A: android:foregroundServiceType(0x3)=0x40000000
      E: property
        A: android:name(0x1)="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        A: android:value(0x2)="User initiated interactive SSH terminal connections"
'''
RECEIVER = '''    E: receiver
      A: android:name(0x1)="androidx.profileinstaller.ProfileInstallReceiver"
      A: android:permission(0x2)="android.permission.DUMP"
''' + ''.join('      E: intent-filter\n        E: action\n          A: android:name(0x1)="' + action + '"\n' for action in sorted(policy.PROFILE_ACTIONS))


class ManifestPolicyTest(unittest.TestCase):
    def test_sdk36_real_namespace_uri_and_untrusted_namespace(self):
        manifest = (SERVICE + RECEIVER).replace('A: android:', 'A: http://schemas.android.com/apk/res/android:')
        self.assertTrue(policy.inspect_connection_components(manifest)['existingDumpProtectedProfileReceiver'])
        with self.assertRaises(policy.ManifestPolicyError):
            policy.inspect_connection_components(manifest.replace('http://schemas.android.com/apk/res/android:', 'http://untrusted.invalid/android:'))

    def test_exact_service_and_existing_androidx_receiver(self):
        self.assertFalse(policy.inspect_connection_components(SERVICE)['automaticBoot'])
        self.assertTrue(policy.inspect_connection_components(SERVICE + RECEIVER)['existingDumpProtectedProfileReceiver'])

    def test_rejects_new_receivers_and_unprotected_profile_receiver(self):
        for value in [RECEIVER.replace('androidx.profileinstaller.ProfileInstallReceiver', '.BootReceiver'),
                      RECEIVER.replace('android.permission.DUMP', 'android.permission.INTERNET'), RECEIVER + RECEIVER,
                      RECEIVER.replace('INSTALL_PROFILE', 'BOOT_COMPLETED')]:
            with self.subTest(value=value):
                with self.assertRaises(policy.ManifestPolicyError):
                    policy.inspect_connection_components(SERVICE + value)

    def test_rejects_export_type_purpose_and_extra_service(self):
        for value in [SERVICE.replace('=false', '=true'), SERVICE.replace('0x40000000', '0x00000001'),
                      SERVICE.replace('User initiated interactive SSH', ''), SERVICE + SERVICE,
                      SERVICE.replace('.ConnectionService', '.OtherService')]:
            with self.subTest(value=value):
                with self.assertRaises(policy.ManifestPolicyError):
                    policy.inspect_connection_components(value)

    def test_nested_false_flag_cannot_hide_exported_service(self):
        value = SERVICE.replace('=false', '=true') + '        A: android:exported(0x2)=false\n'
        with self.assertRaises(policy.ManifestPolicyError):
            policy.inspect_connection_components(value)
