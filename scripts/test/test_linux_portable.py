import importlib.util
import json
import shutil
from pathlib import Path
import struct
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / 'verify-linux-portable.py'
SPEC = importlib.util.spec_from_file_location('linux_portable', str(SCRIPT))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def copy_public_fonts(root):
    root.chmod(0o755)
    manifest = json.loads((SCRIPT.parent / 'fonts/font-manifest.json').read_text())
    target = root / 'resources/builtin-plugins/tabby-terminal/dist/fonts'
    target.mkdir(parents=True)
    for font in manifest['fonts']:
        source = SCRIPT.parent.parent / 'tabby-terminal/src/fonts/bundled' / font['file']
        name = Path(font['file'])
        destination = target / (name.stem + '-012345abcdef' + name.suffix)
        shutil.copyfile(source, destination)
        destination.chmod(0o644)
    for directory in root.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    return manifest, target


def write_asar(path, header, content):
    data = json.dumps(header, separators=(',', ':')).encode('utf8')
    padding = bytes((-len(data)) % 4)
    payload_size = 4 + len(data) + len(padding)
    path.write_bytes(struct.pack('<IIII', 4, 4 + payload_size, payload_size, len(data)) + data + padding + content)
    path.chmod(0o644)


class PortableAuditTests(unittest.TestCase):
    def test_version_requirements_do_not_confuse_new_exported_definitions(self):
        text = """Version definition section '.gnu.version_d' contains 1 entry:
  0x0000: Rev: 1 Flags: none Index: 2 Cnt: 1 Name: GLIBC_2.40
Version needs section '.gnu.version_r' contains 2 entries:
  0x0000: Version: 1 File: libc.so.6 Cnt: 1
  0x0010: Name: GLIBC_2.28 Flags: none Version: 3
  0x0020: Version: 1 File: libstdc++.so.6 Cnt: 1
  0x0030: Name: GLIBCXX_3.4.25 Flags: none Version: 4
"""
        needs, definitions = AUDIT.version_info(text)
        self.assertIn('GLIBC_2.40', definitions)
        self.assertEqual(AUDIT.check_limits(needs), {'GLIBC': '2.28', 'GLIBCXX': '3.4.25'})

    def test_future_and_private_versions_fail_closed(self):
        for name in ['GLIBC_2.29', 'GLIBCXX_3.4.26', 'CXXABI_1.3.12', 'GLIBC_PRIVATE']:
            with self.subTest(name=name), self.assertRaises(AUDIT.AuditError):
                AUDIT.check_limits({'library.so': [name]})

    def test_non_elf_or_foreign_machine_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'foreign.node'
            for data in [b'not an ELF' * 4, b'\x7fELF' + bytes([2, 1]) + bytes(12) + struct.pack('<H', 183)]:
                path.write_bytes(data)
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.inspect_elf(path)

    def test_asar_path_traversal_and_links_fail(self):
        for name, entry in [('..', {'size': 0, 'offset': '0'}), ('file', {'link': '../outside', 'size': 0})]:
            with self.subTest(name=name), self.assertRaises(AUDIT.AuditError):
                list(AUDIT.asar_files({'files': {name: entry}}))

    def test_asar_unpacked_directory_is_inherited(self):
        header = {'files': {'native': {'unpacked': True, 'files': {'binding.node': {'size': 10}}}}}
        self.assertEqual(list(AUDIT.asar_files(header))[0][2], True)

    def test_truncated_asar_and_out_of_range_payload_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'app.asar'
            path.write_bytes(bytes(16))
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.read_asar(path)
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.asar_prefix(path, 16, {'size': 1, 'offset': '0'})

    def test_library_cache_ignores_other_architectures(self):
        text = ' libx.so (libc6) => /lib/libx.so\n libx.so (libc6,x86-64) => /lib64/libx.so\n'
        self.assertEqual(AUDIT.host_libraries(text), {'libx.so': [Path('/lib64/libx.so')]})

    def test_real_search_path_not_unrelated_bundle_controls_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.joinpath('usr/lib').mkdir(parents=True)
            root.joinpath('usr/lib/libexample.so').write_bytes(b'unreachable')
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.resolve_needed('libexample.so', root, {'searchPath': []}, root, {})
            root.joinpath('libexample.so').write_bytes(b'reachable')
            target, bundled = AUDIT.resolve_needed('libexample.so', root, {'searchPath': ['$ORIGIN']}, root, {})
            self.assertEqual(target, root / 'libexample.so')
            self.assertTrue(bundled)
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.resolve_needed('libexample.so', root, {'searchPath': ['/tmp/build/lib']}, root, {})

    def test_ambiguous_or_missing_baseline_provider_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for providers in [{}, {'libfoo.so': [Path('/a/libfoo.so'), Path('/b/libfoo.so')]}]:
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.resolve_needed('libfoo.so', root, {'searchPath': []}, root, providers)

    def test_runpath_suppresses_inherited_rpath_but_no_runpath_inherits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'child'
            child.mkdir()
            root.joinpath('libfoo.so').write_bytes(b'parent')
            child.joinpath('libfoo.so').write_bytes(b'child')
            selected, _ = AUDIT.resolve_needed('libfoo.so', child,
                {'searchPath': ['$ORIGIN'], 'searchPathKind': 'RUNPATH'}, root, {}, (root,))
            self.assertEqual(selected, child / 'libfoo.so')
            selected, _ = AUDIT.resolve_needed('libfoo.so', child,
                {'searchPath': [], 'searchPathKind': None}, root, {}, (root,))
            self.assertEqual(selected, root / 'libfoo.so')

    def test_dynamic_symbols_keep_version_and_default_export_semantics(self):
        data = '''
  1: 0000000000000000 0 FUNC GLOBAL DEFAULT UND new_gtk_function
  2: 0000000000000000 0 FUNC WEAK DEFAULT UND optional_hook
  3: 0000000000000000 0 FUNC GLOBAL DEFAULT UND memcpy@GLIBC_2.14 (2)
  4: 0000000000001110 10 FUNC GLOBAL DEFAULT 12 memcpy@@GLIBC_2.14
  5: 0000000000002220 10 FUNC GLOBAL DEFAULT 12 legacy@GLIBC_2.2.5
  6: 0000000000003330 10 FUNC GLOBAL DEFAULT 12 napi_get_version
'''
        symbols = AUDIT.dynamic_symbols(data)
        self.assertEqual(symbols['imports'], {('new_gtk_function', None), ('memcpy', 'GLIBC_2.14')})
        self.assertEqual(symbols['defaults'], {'memcpy', 'napi_get_version'})
        self.assertIn(('legacy', 'GLIBC_2.2.5'), symbols['exports'])

    def test_sandbox_disable_in_packaged_launch_code_fails(self):
        for text in [b'exec tabby --no-sandbox', b'app.commandLine.appendSwitch("no-sandbox")']:
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.check_launch_text(text, 'test')
        AUDIT.check_launch_text(b'exec "$APPDIR/tabby" "$@"', 'test')

    def test_packaged_all_twenty_license_bytes_and_tampered_notice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            source = SCRIPT.parent / 'fonts'
            destination = root / 'resources/font-notices'
            destination.mkdir(parents=True)
            shutil.copyfile(source / 'font-manifest.json', destination / 'font-manifest.json')
            shutil.copytree(source / 'licenses', destination / 'licenses')
            for path in root.rglob('*'):
                path.chmod(0o755 if path.is_dir() else 0o644)
            self.assertEqual(len(AUDIT.check_font_notices(root)), 20)
            notice = destination / 'licenses/NOTICE.txt'
            notice.chmod(0o600)
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.check_font_notices(root)
            notice.chmod(0o644)
            destination.joinpath('licenses/NOTICE.txt').write_text('tampered')
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.check_font_notices(root)

    def test_dynamic_symbol_declared_but_unparsed_table_fails(self):
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.dynamic_symbols("Symbol table '.dynsym' contains 3 entries:\nchanged unsupported row format")
        parsed = AUDIT.dynamic_symbols("Symbol table '.dynsym' contains 2 entries:\n"
            " 1: 00000000002feb80 0x20004 OBJECT GLOBAL DEFAULT 28 large_static_table")
        self.assertIn('large_static_table', parsed['defaults'])

    def test_unnamed_defined_local_section_counts_without_exporting(self):
        data = """Symbol table '.dynsym' contains 4 entries:
  0: 0000000000000000 0 NOTYPE LOCAL DEFAULT UND
  1: 0000000000000ba8 0 SECTION LOCAL DEFAULT 9
  2: 0000000000000000 0 FUNC GLOBAL DEFAULT UND memcpy@GLIBC_2.14 (2)
  3: 0000000000001110 10 FUNC GLOBAL DEFAULT 12 fixture@@FIXTURE_1
"""
        symbols = AUDIT.dynamic_symbols(data)
        self.assertEqual(symbols['declaredEntries'], 4)
        self.assertEqual(symbols['imports'], {('memcpy', 'GLIBC_2.14')})
        self.assertEqual(symbols['exports'], {('fixture', 'FIXTURE_1')})
        self.assertEqual(symbols['defaults'], {'fixture'})
        # Newer readelf supplies the section name for the same st_name=0 entry.
        self.assertEqual(symbols, AUDIT.dynamic_symbols(data.replace('DEFAULT 9\n', 'DEFAULT 9 .init\n')))

    def test_unnamed_or_malformed_symbols_fail_closed(self):
        for row in [
            '1: 0000000000000000 0 FUNC GLOBAL DEFAULT UND',
            '1: 0000000000000000 0 FUNC WEAK DEFAULT UND',
            '1: 0000000000000ba8 0 SECTION GLOBAL DEFAULT 9',
            '1: 0000000000000ba8 0 SECTION LOCAL DEFAULT UND',
            '1: 0000000000000ba8 0 SECTION LOCAL DEFAULT ABS',
            '1: 0000000000000ba8 0 SECTION LOCAL DEFAULT 0',
            '1: 0000000000000ba8 0 OBJECT LOCAL DEFAULT 9',
            '1: 0000000000000ba8 0 SECTION LOCAL HIDDEN 9',
            '1: changed unsupported row format',
            '1: 0000000000000000 0 FUNC GLOBAL DEFAULT UND import extra-fields',
        ]:
            with self.subTest(row=row), self.assertRaises(AUDIT.AuditError):
                AUDIT.dynamic_symbols("Symbol table '.dynsym' contains 2 entries:\n" + row)

    def test_null_and_duplicate_or_missing_symbol_numbers_fail_closed(self):
        for rows in [
            '0: 0000000000000001 0 NOTYPE LOCAL DEFAULT UND',
            '0: 0000000000000000 1 NOTYPE LOCAL DEFAULT UND',
            '0: 0000000000000000 0 SECTION LOCAL DEFAULT UND',
            '0: 0000000000000000 0 NOTYPE GLOBAL DEFAULT UND',
            '0: 0000000000000000 0 NOTYPE LOCAL DEFAULT 9',
            '0: 0000000000000000 0 NOTYPE LOCAL DEFAULT UND named_null',
        ]:
            with self.subTest(rows=rows), self.assertRaises(AUDIT.AuditError):
                AUDIT.dynamic_symbols(rows)
        row = '1: 0000000000000ba8 0 SECTION LOCAL DEFAULT 9\n'
        for rows in [row + row, row + row.replace('1:', '3:')]:
            with self.subTest(rows=rows), self.assertRaises(AUDIT.AuditError):
                AUDIT.dynamic_symbols("Symbol table '.dynsym' contains 3 entries:\n" + rows)

    def test_actual_compiled_shared_library_readelf_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'fixture.c'
            library = root / 'fixture.so'
            source.write_text('#include <stdio.h>\nint fixture(void) { return puts("fixture"); }\n')
            AUDIT.run(['gcc', '-shared', '-fPIC', str(source), '-o', str(library)])
            output = AUDIT.run(['readelf', '--dyn-syms', '--wide', str(library)])
            symbols = AUDIT.dynamic_symbols(output)
            self.assertGreater(symbols['declaredEntries'], 1)
            self.assertIn('fixture', symbols['defaults'])
            self.assertTrue(any(name == 'puts' and version and version.startswith('GLIBC_')
                for name, version in symbols['imports']))
            self.assertEqual(AUDIT.inspect_elf(library, packaged=False)['symbols'], symbols)
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.dynamic_symbols('\n'.join(line.split(' puts@', 1)[0]
                    if ' puts@' in line else line for line in output.splitlines()))

    def test_actual_five_font_hashes_plus_packed_and_unpacked_asar_count_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, _ = copy_public_fonts(root)
            legacy = b'legacy test font bytes'
            archive = root / 'resources/legacy.asar'
            write_asar(archive, {'files': {'legacy.woff2': {'size': len(legacy), 'offset': '0'},
                'unpacked.woff': {'size': len(legacy), 'unpacked': True}}}, legacy)
            unpacked = Path(str(archive) + '.unpacked')
            unpacked.mkdir()
            unpacked.chmod(0o755)
            unpacked.joinpath('unpacked.woff').write_bytes(legacy)
            unpacked.joinpath('unpacked.woff').chmod(0o644)
            report = AUDIT.check_font_payload(root)
            self.assertEqual(report['totalBytes'], sum(font['bytes'] for font in manifest['fonts']) + 2 * len(legacy))
            self.assertEqual(len(report['files']), 7)
            self.assertEqual([font['copies'] for font in report['requiredFonts']], [1] * 5)

    def test_font_duplicate_missing_modified_and_source_payload_fail_closed(self):
        for defect in ['duplicate', 'missing', 'modified', 'source', 'wrong_location']:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                _, target = copy_public_fonts(root)
                font = next(target.glob('*.ttf'))
                if defect == 'duplicate':
                    shutil.copyfile(font, root / 'duplicate.ttf')
                    root.joinpath('duplicate.ttf').chmod(0o644)
                elif defect == 'missing':
                    font.unlink()
                elif defect == 'modified':
                    with font.open('r+b') as stream:
                        stream.write(b'changed')
                elif defect == 'source':
                    source = root / 'resources/builtin-plugins/tabby-terminal/src/fonts/bundled'
                    source.mkdir(parents=True)
                    shutil.copyfile(font, source / 'original.ttf')
                    source.joinpath('original.ttf').chmod(0o644)
                    for path in root.rglob('*'):
                        if path.is_dir():
                            path.chmod(0o755)
                else:
                    font.rename(root / font.name)
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.check_font_payload(root)

    def test_whole_font_budget_includes_unlisted_fonts_and_asar_fonts(self):
        for packed in [False, True]:
            with self.subTest(packed=packed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest, _ = copy_public_fonts(root)
                excess = manifest['budgetBytes'] - sum(font['bytes'] for font in manifest['fonts']) + 1
                if packed:
                    archive = root / 'oversize.asar'
                    write_asar(archive, {'files': {'extra.woff2': {'size': excess, 'offset': '0'}}}, b'')
                    with archive.open('ab') as stream:
                        stream.truncate(archive.stat().st_size + excess)
                else:
                    with root.joinpath('extra.ttf').open('wb') as stream:
                        stream.truncate(excess)
                    root.joinpath('extra.ttf').chmod(0o644)
                with self.assertRaisesRegex(AUDIT.AuditError, 'budget'):
                    AUDIT.check_font_payload(root)

    def test_font_readability_rejects_private_files_directories_and_links(self):
        for defect in ['file', 'directory', 'link', 'archive']:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                _, target = copy_public_fonts(root)
                font = next(target.glob('*.ttf'))
                if defect == 'file':
                    font.chmod(0o600)
                elif defect == 'directory':
                    target.chmod(0o700)
                elif defect == 'link':
                    font.rename(root / 'original.ttf')
                    font.symlink_to(root / 'original.ttf')
                else:
                    archive = root / 'private.asar'
                    write_asar(archive, {'files': {'extra.woff2': {'size': 1, 'offset': '0'}}}, b'x')
                    archive.chmod(0o600)
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.check_font_payload(root)


if __name__ == '__main__':
    unittest.main()
