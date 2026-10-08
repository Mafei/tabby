"""Negative packaged-byte boundaries, independent of Angular and the APK SDK."""
import importlib.util
from pathlib import Path
import unittest
import json
from hashlib import sha256

path = Path(__file__).resolve().parents[1] / 'scripts' / 'web_security.py'
spec = importlib.util.spec_from_file_location('web_security', path)
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)
POLICY = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
          "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
          "base-uri 'none'; form-action 'none'")
INDEX = ('<html><head><meta http-equiv="Content-Security-Policy" content="' + POLICY +
         '"></head><body><tabby-mobile></tabby-mobile>'
         '<script src="main-ABC123.js" type="module"></script></body></html>')


class PackagedWebSecurityTest(unittest.TestCase):
    def assets(self, index=INDEX):
        return {'index.html': index.encode(), 'main-ABC123.js': b'console.log("app")',
                'cordova.js': b'', 'styles-ABC123.css': b'body{margin:0}'}

    def rejected(self, index=INDEX, extra=None):
        assets = self.assets(index)
        assets.update(extra or {})
        with self.assertRaises(web.WebSecurityError):
            web.inspect_web_assets(assets)

    def test_accepts_external_app_with_documented_style_exception(self):
        result = web.inspect_web_assets(self.assets())
        self.assertEqual(result['scriptPolicy'], 'self')
        self.assertEqual(list(result['scriptSHA256']), ['main-ABC123.js'])

    def test_rejects_weak_script_policy_and_override_directives(self):
        for value in ["'self' 'unsafe-eval'", "'self' 'unsafe-inline'", '*', 'https:']:
            with self.subTest(value=value):
                self.rejected(INDEX.replace("script-src 'self'", 'script-src ' + value))
        self.rejected(INDEX.replace(POLICY, POLICY + "; script-src 'self'"))
        self.rejected(INDEX.replace(POLICY, POLICY + '; script-src-elem *'))

    def test_rejects_inline_script_and_handlers(self):
        self.rejected(INDEX.replace('</head>', '<script>alert(1)</script></head>'))
        self.rejected(INDEX.replace('></script>', '>alert(1)</script>'))
        self.rejected(INDEX.replace('<body>', '<body onload="alert(1)">'))

    def test_rejects_missing_duplicate_late_policy_and_duplicate_attributes(self):
        meta = INDEX[INDEX.index('<meta'):INDEX.index('</head>')]
        self.rejected(INDEX.replace(meta, ''))
        self.rejected(INDEX.replace(meta, meta + meta))
        self.rejected(INDEX.replace(meta, '').replace('</body>', meta + '</body>'))
        self.rejected(INDEX.replace('type="module"', 'src="evil.js" type="module"'))

    def test_rejects_missing_or_remote_script_and_path_traversal(self):
        for source in ['missing.js', '//evil/main.js', 'https://evil/main.js',
                       '../main-ABC123.js', '/main-ABC123.js', 'main-ABC123.js?q=1']:
            with self.subTest(source=source):
                self.rejected(INDEX.replace('main-ABC123.js', source))
        self.rejected(extra={'../escape.js': b''})

    def test_rejects_test_debug_bytes_and_base_element(self):
        for name in ['tests/harness.js', 'browser-stats.json', 'main.js.map', 'csp-probe.js']:
            with self.subTest(name=name):
                self.rejected(extra={name: b'{}'})
        self.rejected(extra={'arbitrary.js': b'__tabbyCSPProbe'})
        self.rejected(INDEX.replace('</head>', '<base href="https://evil/"></head>'))

    def binding(self):
        assets = self.assets()
        assets['cordova_plugins.js'] = b''
        graph = json.dumps({'inputs': {'web/src/main.ts': {}, 'node_modules/@angular/core/core.mjs': {}}}).encode()
        files = {name: sha256(data).hexdigest() for name, data in assets.items() if not name.startswith('cordova')}
        receipt = {'graphHash': sha256(graph).hexdigest(), 'files': files}
        return assets, receipt, graph

    def test_binds_actual_assets_to_aot_graph_and_manifest(self):
        assets, receipt, graph = self.binding()
        result = web.bind_aot_assets(assets, receipt, graph)
        self.assertFalse(result['runtimeCompiler'])
        self.assertEqual(result['boundDeliveryFiles'], 3)

    def test_rejects_stale_graph_or_changed_apk_bytes(self):
        assets, receipt, graph = self.binding()
        with self.assertRaises(web.WebSecurityError):
            web.bind_aot_assets(assets, receipt, graph + b' ')
        assets['main-ABC123.js'] = b'console.log("different build")'
        with self.assertRaises(web.WebSecurityError):
            web.bind_aot_assets(assets, receipt, graph)

    def test_rejects_extra_missing_or_nonempty_cordova_assets(self):
        for alteration in ['extra', 'missing', 'cordova']:
            assets, receipt, graph = self.binding()
            if alteration == 'extra':
                assets['unreviewed.js'] = b''
            elif alteration == 'missing':
                del assets['main-ABC123.js']
            else:
                assets['cordova.js'] = b'console.log("added")'
            with self.subTest(alteration=alteration), self.assertRaises(web.WebSecurityError):
                web.bind_aot_assets(assets, receipt, graph)

    def test_rejects_compiler_or_test_graph_even_with_matching_hash(self):
        for input_name in ['node_modules/@angular/compiler/compiler.mjs', 'web/tests/harness.ts']:
            assets, receipt, graph = self.binding()
            parsed = json.loads(graph)
            parsed['inputs'][input_name] = {}
            graph = json.dumps(parsed).encode()
            receipt['graphHash'] = sha256(graph).hexdigest()
            with self.subTest(input_name=input_name), self.assertRaises(web.WebSecurityError):
                web.bind_aot_assets(assets, receipt, graph)


if __name__ == '__main__':
    unittest.main()
