"""Package original design boards; never read or render product screenshots."""
from pathlib import Path
import hashlib
import json
import zipfile
from PIL import Image, PngImagePlugin
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).parent
ORDER = ['dark-workspace', 'light-workspace', 'state-matrix', 'dark-workspace-window-blur',
         'light-workspace-window-blur', 'dark-launcher', 'light-launcher', 'dark-recovery', 'light-recovery']
PREFIX = 'Tabby-Linux-UIUX-v1-'
BASE = 'd83bf1b4904e439533d074aa6f7d3b48ebde5776'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def quantize_rgb565(pixel):
    r, g, b = pixel
    return ((r >> 3) << 3) | (r >> 5), ((g >> 2) << 2) | (g >> 6), ((b >> 3) << 3) | (b >> 5)

simulations = []
for name in ('dark-workspace', 'light-workspace'):
    src = ROOT / 'png' / (PREFIX + name + '.png')
    with Image.open(src) as original:
        original.load()
        assert original.getextrema()[-1] == (255, 255), 'PNG must be opaque'
        rgb = original.convert('RGB')
        reduced = Image.new('RGB', rgb.size)
        reduced.putdata([quantize_rgb565(p) for p in rgb.getdata()])
        target = src.with_name(src.stem + '-RGB565-simulation.png')
        meta = PngImagePlugin.PngInfo()
        meta.add_text('Description', 'Original DESIGN PROPOSAL, NOT product screenshot. RGB565 bit truncation/replication simulation, NOT actual xrdp evidence.')
        reduced.save(target, pnginfo=meta)
        assert target.is_file()
        with Image.open(target) as check:
            check.load()
            assert check.size == rgb.size
            assert list(check.getdata()) == list(reduced.getdata())
        simulations.append({'file':str(target.relative_to(ROOT)), 'source':str(src.relative_to(ROOT)),
                            'sourceSHA256':digest(src), 'SHA256':digest(target),
                            'method':'RGB565 bit truncation/replication; all pixels; no crop/resize',
                            'realXrdp':False, 'productScreenshot':False})

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
pdf = ROOT / 'Tabby-Linux-UIUX-v1.1-评审稿.pdf'
c = canvas.Canvas(str(pdf), pagesize=(1440, 1000), pageCompression=1)
c.setTitle('Tabby Linux UI/UX v1.1 — INACTIVE TAB BACKGROUNDS, DESIGN PROPOSAL')
c.setAuthor('Tabby personal fork design proposal')
c.setFillColorRGB(0.94, 0.96, 0.98); c.rect(0, 0, 1440, 1000, fill=1, stroke=0)
c.setFillColorRGB(0.12, 0.16, 0.22);c.setFont('STSong-Light', 40)
c.drawString(80, 874, 'Tabby Linux UI/UX 设计方案 v1.1')
c.setFont('STSong-Light', 24);c.drawString(80, 814, '推荐方向：轻量标签工作台')
c.setFont('STSong-Light', 20)
lines = [
 '深浅两套蓝灰主题；局部选中与焦点标记；终端 ANSI 配色保留。',
 '9 张原创画板：主界面、十种状态、窗口失焦、快速打开与恢复暂停。',
 '本文件含 2 张明确标记的 RGB565 设计量化比较。',
 '所有画面均为设计示意，不是产品截图或真实 xrdp 测试。',
 '46 组配色通过原色/RGB565 检查；非活动标签加入可辨识的实色底色。',
 '设计待用户评审后才进入实现；本次未修改产品代码。',
 '完整规格、资料引用、可编辑 SVG、颜色与尺寸 JSON 见设计包。',
 '画板 1440×1000；状态表 1440×1236；PNG 均已实际解码确认。',
]
for i, line in enumerate(lines):c.drawString(80, 736-i*50, line)
c.setFont('Helvetica', 16);c.drawString(80, 170, 'Source baseline: '+BASE)
c.drawString(80, 136, 'Revision 1.1: inactive backgrounds. Previous design: 2d5ac0975fc7001473c96a08759389a385093009')
c.setFont('STSong-Light', 17);c.drawString(80, 90, '浏览顺序：深浅主界面 → 状态表 → 窗口失焦 → 会话入口 → 恢复 → 色深比较')
c.showPage()
for name in ORDER:
    src = ROOT / 'png' / (PREFIX + name + '.png')
    with Image.open(src) as im:
        w,h=im.size
        c.setPageSize((w,h));c.drawImage(ImageReader(im),0,0,width=w,height=h)
        c.showPage()
for sim in simulations:
    with Image.open(ROOT / sim['file']) as im:
        w,h=im.size
        c.setPageSize((w,h+54))
        c.setFillColorRGB(0.94,0.96,0.98);c.rect(0,0,w,h+54,fill=1,stroke=0)
        c.setFillColorRGB(0.12,0.16,0.22);c.setFont('STSong-Light',17)
        c.drawString(72,h+21,'RGB565 设计量化示意 · 非产品截图 · 不代表真实 xrdp 测试 · 原图未缩放或裁剪')
        c.drawImage(ImageReader(im),0,0,width=w,height=h)
        c.showPage()
c.save()

files = [ROOT / 'SPEC.zh-CN.md', ROOT / 'tokens.json', ROOT / 'contrast-audit.json',
         ROOT / 'generate_design.py', ROOT / 'package_design.py', ROOT / 'REVISION.zh-CN.md',
         ROOT / 'design-validation.json', pdf]
files += sorted((ROOT / 'svg').glob('*.svg')) + sorted((ROOT / 'png').glob('*.png'))
entries=[]
for file in files:
    entry={'path':str(file.relative_to(ROOT)), 'bytes':file.stat().st_size, 'SHA256':digest(file)}
    if file.suffix=='.png':
        with Image.open(file) as im:
            im.load();entry.update({'width':im.width,'height':im.height,'mode':im.mode})
    entries.append(entry)
manifest={'kind':'original_design_proposal_not_product_screenshot', 'version':'1.1',
          'sourceBaseline':BASE,'sourceTree':'c739ada9fb9c4f8894f802ede6f210ad81a34a1c',
          'createdUTC':'2026-10-08','productionCodeChanged':False,'implementationApproved':False,
          'renderer':'Inkscape 1.4 ordinary offline SVG PNG export',
          'PDF':'12 pages: overview, 9 original boards, 2 labeled RGB565 comparisons',
          'realXrdpValidated':False,'productionGUIValidated':False,
          'visualReview':'all 9 exported boards inspected; overall palette approved; inactive background revision pending user review',
          'previousDesignHead':'2d5ac0975fc7001473c96a08759389a385093009',
          'originalBoardCount':9,'designTokenPairs':46,'designTokenMathPassed':True,
          'files':entries,'RGB565Simulations':simulations}
(ROOT / 'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
files.append(ROOT/'manifest.json')
archive=ROOT/'Tabby-Linux-UIUX-v1.1-设计包.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for file in files:z.write(file,arcname='Tabby-Linux-UIUX-v1/'+str(file.relative_to(ROOT)))
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
print(json.dumps({'PDF':{'path':str(pdf),'bytes':pdf.stat().st_size,'SHA256':digest(pdf)},
                  'ZIP':{'path':str(archive),'bytes':archive.stat().st_size,'SHA256':digest(archive)},
                  'filesInZIP':len(files),'PNG':11,'originalBoards':9,'PDFPages':12},ensure_ascii=False))
