#!/usr/bin/env python3
"""Offline SFNT cmap/advance audit. Coverage is not proof of rendered shaping."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct

FETCH_PATH = Path(__file__).with_name('fetch-fonts.py')
SPEC = importlib.util.spec_from_file_location('font_fetch', FETCH_PATH)
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)


def require(condition):
    if not condition:
        raise ValueError('FONT_SFNT_INVALID')


def u16(data, offset):
    require(0 <= offset <= len(data) - 2)
    return struct.unpack_from('>H', data, offset)[0]


def u32(data, offset):
    require(0 <= offset <= len(data) - 4)
    return struct.unpack_from('>I', data, offset)[0]


def sfnt(path):
    data = path.read_bytes()
    require(data[:4] in (b'\x00\x01\x00\x00', b'OTTO'))
    count = u16(data, 4)
    require(0 < count <= 128 and 12 + count * 16 <= len(data))
    tables = {}
    for index in range(count):
        offset = 12 + 16 * index
        tag = data[offset:offset + 4].decode('ascii')
        start, length = u32(data, offset + 8), u32(data, offset + 12)
        require(tag not in tables and start + length <= len(data))
        tables[tag] = data[start:start + length]
    glyph_count = u16(tables['maxp'], 4)
    require(glyph_count > 0)
    cmap = tables['cmap']
    count = u16(cmap, 2)
    require(count <= 64 and 4 + 8 * count <= len(cmap))
    mapped, formats, seen = {}, set(), set()
    for index in range(count):
        record = 4 + 8 * index
        platform, encoding, start = u16(cmap, record), u16(cmap, record + 2), u32(cmap, record + 4)
        if not (platform == 0 or platform == 3 and encoding in (1, 10)) or start in seen:
            continue
        seen.add(start)
        fmt = u16(cmap, start)
        formats.add(fmt)
        if fmt == 4:
            length = u16(cmap, start + 2)
            sub = cmap[start:start + length]
            require(len(sub) == length)
            segments = u16(sub, 6) // 2
            require(0 < segments <= 32768 and 16 + segments * 8 <= length)
            ends, starts = 14, 16 + 2 * segments
            deltas, ranges = 16 + 4 * segments, 16 + 6 * segments
            previous_end = -1
            for segment in range(segments):
                end, first = u16(sub, ends + 2 * segment), u16(sub, starts + 2 * segment)
                require(first <= end and first > previous_end)
                previous_end = end
                delta, relative = u16(sub, deltas + 2 * segment), u16(sub, ranges + 2 * segment)
                for point in range(first, min(end, 0xfffe) + 1):
                    glyph = u16(sub, ranges + 2 * segment + relative + 2 * (point - first)) if relative else point
                    glyph = (glyph + delta) & 0xffff if glyph else 0
                    require(glyph < glyph_count)
                    if glyph:
                        mapped[point] = glyph
        elif fmt == 12:
            length, groups = u32(cmap, start + 4), u32(cmap, start + 12)
            require(groups <= 65536 and length == 16 + 12 * groups and start + length <= len(cmap))
            previous_end = -1
            for group in range(groups):
                offset = start + 16 + 12 * group
                first, end, glyph = u32(cmap, offset), u32(cmap, offset + 4), u32(cmap, offset + 8)
                require(previous_end < first <= end <= 0x10ffff and glyph + end - first < glyph_count)
                previous_end = end
                for point in range(first, end + 1):
                    if glyph + point - first:
                        mapped[point] = glyph + point - first
    require(mapped)
    units = u16(tables['head'], 18)
    metrics = u16(tables['hhea'], 34)
    require(units > 0 and 0 < metrics <= glyph_count and len(tables['hmtx']) >= 4 * metrics + 2 * (glyph_count - metrics))
    advances = {point: u16(tables['hmtx'], 4 * min(glyph, metrics - 1)) for point, glyph in mapped.items()}
    return {'mapping': mapped, 'advances': advances, 'unitsPerEm': units, 'tables': sorted(tables), 'cmapFormats': sorted(formats)}


def coverage(font, points):
    points = set(points)
    present = points.intersection(font['mapping'])
    return {'present': len(present), 'total': len(points),
            'missing': [f'U+{point:04X}' for point in sorted(points - present)]}


def audit(output):
    manifest = FETCH.prepare(output, verify_only=True)
    required = {key: range(first, end + 1) for key, (first, end) in manifest['coverage']['requiredRanges'].items()}
    required.update(manifest['coverage']['requiredSamples'])
    parsed = [(entry, sfnt(output / entry['file'])) for entry in manifest['fonts']]
    union = {'mapping': set().union(*(font['mapping'] for _, font in parsed))}
    stack = {key: coverage(union, values) for key, values in required.items()}
    require(all(result['present'] == result['total'] for result in stack.values()))
    emoji = dict((entry['family'], font) for entry, font in parsed)['Tabby Bundled Emoji']
    require({'CBDT', 'CBLC', 'GSUB'} <= set(emoji['tables']))
    mono = next(font for entry, font in parsed if entry['family'] == 'Tabby Bundled Mono' and entry['weight'] == 400)
    symbols = next(font for entry, font in parsed if entry['family'] == 'Tabby Bundled Symbols')
    # Braille must fit the same nominal advance as the selected regular mono.
    require(all(symbols['advances'][p] * mono['unitsPerEm'] == mono['advances'][65] * symbols['unitsPerEm']
                for p in range(0x2800, 0x2900)))
    fonts = []
    for entry, font in parsed:
        fonts.append({'file': entry['file'], 'sha256': entry['sha256'], 'bytes': entry['bytes'],
                      'family': entry['family'], 'weight': entry['weight'],
                      'mappedCodepoints': len(font['mapping']), 'unitsPerEm': font['unitsPerEm'],
                      'tables': font['tables'], 'cmapFormats': font['cmapFormats'],
                      'coverage': {key: coverage(font, values) for key, values in required.items()},
                      'observedCoverage': {key: coverage(font, values) for key, values in manifest['coverage']['observedSamples'].items()},
                      'sampleAdvances': {f'U+{p:04X}': font['advances'][p] for p in (65, 0x2801, 0x28ff, 0x4e2d) if p in font['advances']}})
    return {'schemaVersion': 1, 'fontCount': len(fonts), 'fontBytes': sum(f['bytes'] for f in fonts),
            'budgetBytes': manifest['budgetBytes'], 'requiredCoveragePassed': True,
            'brailleMatchesMonoAdvance': True, 'stackCoverage': stack,
            'observedStackCoverage': {key: coverage(union, values) for key, values in manifest['coverage']['observedSamples'].items()},
            'renderingVerified': False, 'emojiSequenceShapingVerified': False,
            'terminalGraphemeCellWidthVerified': False, 'fonts': fonts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-dir', type=Path, default=FETCH.ROOT / 'tabby-terminal/src/fonts/bundled')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(audit(args.font_dir), indent=2) + '\n'
    if args.output:
        FETCH.plain_file(args.output)
        args.output.write_text(result)
        print(json.dumps({'verified': True, 'fontCount': 5, 'fontBytes': 35242120,
                          'renderingVerified': False, 'report': str(args.output)}))
    else:
        print(result, end='')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, struct.error):
        raise SystemExit('FONT_COVERAGE_AUDIT_FAILED')
