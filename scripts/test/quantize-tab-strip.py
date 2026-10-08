"""Quantize actual browser PNGs to RGB565. This is not an RDP codec test."""
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw

root = Path('dist/linux-tab-strip')
report = json.loads((root / 'report.json').read_text())
assert report['passed'], 'A passing actual browser render is required'


def quantize(color):
    r, g, b = color[:3]
    return ((r >> 3) << 3 | (r >> 3) >> 2,
            (g >> 2) << 2 | (g >> 2) >> 4,
            (b >> 3) << 3 | (b >> 3) >> 2)


def contrast(a, b):
    def luminance(color):
        values = [v / 255 for v in color]
        linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]
        return sum(v * weight for v, weight in zip(linear, (.2126, .7152, .0722)))
    first, second = luminance(a), luminance(b)
    return (max(first, second) + .05) / (min(first, second) + .05)


def rgb(text):
    assert text.startswith('rgb(') and text.endswith(')'), text
    return tuple(int(part.strip()) for part in text[4:-1].split(','))


measurements = []
for state in report['states']:
    source = Image.open(root / (state['label'] + '.png')).convert('RGB')
    reduced = Image.new('RGB', source.size)
    reduced.putdata([quantize(pixel) for pixel in source.getdata()])
    reduced.save(root / (state['label'] + '-rgb565.png'))
    if state['label'].endswith('-after-top') and not state['label'].startswith('custom'):
        def sample(part, lower=False):
            box = state[part]
            x = math.floor(box['x'] + box['width'] / 2)
            y = math.floor(box['y'] + box['height'] - 5 if lower else box['y'] + box['height'] / 2)
            pixel = source.getpixel((x, y))
            background = state['strip']['bg'] if part == 'spacer' else box['bg']
            assert pixel == rgb(background), (state['label'], part, pixel, background)
            return reduced.getpixel((x, y))
        strip = sample('spacer')
        inactive, active = sample('inactive', True), sample('active', True)
        assert strip == inactive
        terminal_box = state['terminal']
        terminal = reduced.getpixel((math.floor(terminal_box['x'] + terminal_box['width'] - 10),
                                     math.floor(terminal_box['y'] + terminal_box['height'] - 10)))
        assert contrast(strip, terminal) >= 1.5
        assert contrast(active, inactive) >= 1.7
        assert contrast(active, quantize(rgb(state['active']['fg']))) >= 4.5
        assert contrast(inactive, quantize(rgb(state['inactive']['fg']))) >= 4.5
        measurements.append({'state': state['label'], 'actualScreenshotPixels': True,
                             'stripVsTerminal': contrast(strip, terminal),
                             'activeVsInactive': contrast(active, inactive),
                             'activeTextContrast': contrast(active, quantize(rgb(state['active']['fg']))),
                             'inactiveTextContrast': contrast(inactive, quantize(rgb(state['inactive']['fg'])))})
assert len(measurements) == 2
for mode in ('dark', 'light'):
    sheet = Image.new('RGB', (1920, 1020), 'white')
    draw = ImageDraw.Draw(sheet)
    for row, suffix in enumerate(('', '-rgb565')):
        for col, version in enumerate(('before', 'after')):
            draw.text((col * 960 + 10, row * 510 + 8), f'{mode} {version}: {"normal browser PNG" if not suffix else "SIMULATED RGB565"}', fill='black')
            sheet.paste(Image.open(root / f'{mode}-{version}-top{suffix}.png'), (col * 960, row * 510 + 30))
    sheet.save(root / f'{mode}-before-after-comparison.png')
report['rgb565Simulation'] = {'realXrdp': False, 'method': 'truncate to R5/G6/B5, then bit replication to RGB888; no RDP codec/dither simulation', 'measurements': measurements}
(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS RGB565 actual screenshot pixels: dark/light surfaces and text; before/after comparison PNGs saved')
