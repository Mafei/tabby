"""Inspect bundled WebView bytes independently of the web build tools."""
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import PurePosixPath
import re
import json


class WebSecurityError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise WebSecurityError(message)


class Index(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.policies = []
        self.scripts = []
        self.in_script = False
        self.body_seen = False

    def handle_starttag(self, tag, attributes):
        names = [name for name, _ in attributes]
        require(len(names) == len(set(names)), 'Duplicate HTML attribute')
        attrs = dict(attributes)
        require(not any(name.startswith('on') for name in names), 'Inline event handler')
        require(tag != 'base', 'Packaged base element')
        if tag == 'body':
            self.body_seen = True
        if tag == 'meta' and attrs.get('http-equiv', '').lower() == 'content-security-policy':
            require(not self.body_seen and not self.scripts, 'CSP appears after executable content')
            self.policies.append(attrs.get('content', ''))
        if tag == 'script':
            require(not self.in_script, 'Nested script')
            require(self.policies, 'Script precedes CSP')
            self.scripts.append(attrs.get('src', ''))
            self.in_script = True

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            require(not data.strip(), 'Inline script')


def inspect_web_assets(assets):
    """Accept a mapping of paths relative to assets/public to their actual bytes."""
    require('index.html' in assets, 'Bundled index missing')
    require(len(assets) <= 512 and sum(map(len, assets.values())) <= 16 * 1024 * 1024,
            'Unexpected web asset count or size')
    for name, data in assets.items():
        require(name and not name.startswith('/') and '\\' not in name and
                all(part not in ('', '.', '..') for part in name.split('/')),
                'Unsafe web asset path')
        require(not re.search(r'(?:harness|probe|\.map$|stats\.json$|(?:^|/)tests/)', name, re.I),
                'Test or debug web asset')
        require(not any(marker in data for marker in (
            b'TestBridge', b'testBridge', b'attackMarker', b'fixturePassword',
            b'tabby-ssh-test-fixture', b'__tabbyCSPProbe', b'test-callback-')),
            'Test code in packaged web bytes')
    index = Index()
    require(len(assets['index.html']) <= 128 * 1024, 'Unexpected index size')
    try:
        index.feed(assets['index.html'].decode('utf-8', errors='strict'))
        index.close()
    except UnicodeError as error:
        raise WebSecurityError('Index must be UTF-8') from error
    require(not index.in_script and len(index.policies) == 1, 'Expected exactly one complete CSP')
    directives = {}
    for part in index.policies[0].split(';'):
        if not part.strip():
            continue
        name, *values = part.strip().split()
        require(name == name.lower() and name not in directives, 'Duplicate or invalid CSP directive')
        directives[name] = values
    required = {
        'default-src': ["'self'"], 'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"], 'object-src': ["'none'"],
        'base-uri': ["'none'"], 'form-action': ["'none'"],
    }
    require(directives == required, 'Unexpected production CSP')
    require(index.scripts, 'Compiled external app script missing')
    for source in index.scripts:
        require(re.fullmatch(r'[A-Za-z0-9_./-]+\.js', source) is not None and
                not source.startswith('/') and
                all(part not in ('', '.', '..') for part in source.split('/')),
                'Script must have a local relative JS path')
        require(str(PurePosixPath(source)) in assets, 'Referenced script missing from APK')
    require(any(re.fullmatch(r'main-[A-Za-z0-9_-]+\.js', path) for path in index.scripts),
            'Compiled Angular application missing')
    return {'scriptPolicy': 'self', 'inlineScript': False, 'testCodeInDelivery': False,
            'styleException': 'Angular/xterm dynamic styles',
            'indexSHA256': sha256(assets['index.html']).hexdigest(),
            'scriptSHA256': {path: sha256(assets[path]).hexdigest() for path in sorted(index.scripts)}}


def bind_aot_assets(assets, receipt, graph_bytes):
    """Bind inspected APK bytes to the locally verified production build graph."""
    require(set(receipt) == {'graphHash', 'files'}, 'Unexpected AOT receipt schema')
    require(receipt['graphHash'] == sha256(graph_bytes).hexdigest(), 'AOT graph hash mismatch')
    graph = json.loads(graph_bytes)
    require(isinstance(graph.get('inputs'), dict), 'Compiled input graph missing')
    inputs = list(graph['inputs'])
    require(any(path.endswith('web/src/main.ts') for path in inputs), 'Compiled app input missing')
    require(not any(re.search(r'node_modules/@angular/compiler/|web/tests/|scripts/.*probe', path)
                    for path in inputs), 'Runtime compiler or tests in production graph')
    files = receipt['files']
    require(isinstance(files, dict) and 'index.html' in files, 'Delivery manifest missing')
    extras = set(assets) - set(files)
    require(extras <= {'cordova.js', 'cordova_plugins.js'} and not (set(files) - set(assets)),
            'APK and AOT asset sets differ')
    require(all(assets[path] == b'' for path in extras), 'Unexpected Cordova runtime code')
    for path, digest in files.items():
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest) is not None and
                sha256(assets[path]).hexdigest() == digest, 'APK differs from verified AOT output')
    return {'runtimeCompiler': False, 'graphSHA256': receipt['graphHash'],
            'boundDeliveryFiles': len(files)}
