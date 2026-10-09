"""Original Tabby Linux design proposals. These are not product screenshots."""
from pathlib import Path
import json
import html

ROOT = Path(__file__).parent
BASE_SHA = 'd83bf1b4904e439533d074aa6f7d3b48ebde5776'
THEMES = {
    'dark': {'chrome':'#242B36','title':'#1C232D','active':'#303B4A','hover':'#2D3542','text':'#EEF2F7','secondary':'#AAB5C4','index':'#95A3B5','accent':'#86B9FF','onAccent':'#162334','unfocused':'#8EA1B8','divider':'#647B94','subtle':'#303A48','terminal':'#171717','terminalText':'#CACACA','success':'#83CBA8','warning':'#F0C479','danger':'#FFA3A3','warningBg':'#352D20','paper':'#111820','paperText':'#EEF2F7'},
    'light': {'chrome':'#EEF1F5','title':'#E3E8EE','active':'#FFFFFF','hover':'#E2E8F0','text':'#1F2937','secondary':'#536174','index':'#5D6C80','accent':'#245E9C','onAccent':'#FFFFFF','unfocused':'#52667F','divider':'#7D8B9C','subtle':'#CCD4DF','terminal':'#FFFFFF','terminalText':'#4D4D4C','success':'#276749','warning':'#7A4B00','danger':'#A32132','warningBg':'#FFF2D7','paper':'#F7F9FC','paperText':'#1F2937'},
}
for name, theme in THEMES.items():
    theme['inactive'] = '#0D1320' if name == 'dark' else '#CAD8E9'
    theme['inactiveText'] = theme['secondary'] if name == 'dark' else theme['text']
    theme['inactiveIndex'] = theme['index'] if name == 'dark' else theme['text']
METRICS = {'grid':4,'tabStripHeight':44,'tabHeight':36,'tabWidthPreferred':220,'tabWidthMinimum':144,'tabGap':4,'tabPaddingX':12,'tabRadius':6,'selectedMarkerHeight':2,'controlTarget':32,'compactControlTarget':28,'iconSize':16,'paneHeaderHeight':28,'statusHeight':24,'terminalPadding':16,'splitLine':1,'splitHitArea':10,'focusRing':2,'UIBody':[13,20],'UIActiveWeight':600,'UISecondary':[12,18],'terminalDemo':[16,24],'userTerminalFontPreserved':True}


def rgb(value):
    return tuple(int(value[i:i+2],16) for i in (1,3,5))


def quantize(color):
    return tuple(((v>>2)<<2)|((v>>2)>>4) if i==1 else ((v>>3)<<3)|((v>>3)>>2) for i,v in enumerate(color))


def luminance(color):
    return sum((v/255/12.92 if v/255<=.04045 else ((v/255+.055)/1.055)**2.4)*w for v,w in zip(color,(.2126,.7152,.0722)))


def contrast(a,b):
    x,y=luminance(a),luminance(b)
    return (max(x,y)+.05)/(min(x,y)+.05)


PAIRS = [('text','chrome',4.5),('secondary','chrome',4.5),('index','chrome',4.5),('text','active',4.5),('secondary','active',4.5),('secondary','hover',4.5),('accent','active',3),('accent','chrome',3),('unfocused','active',3),('divider','chrome',3),('divider','terminal',3),('success','chrome',4.5),('warning','warningBg',4.5),('danger','chrome',4.5),('onAccent','accent',4.5)]
PAIRS += [('inactiveText','inactive',4.5),('inactiveIndex','inactive',4.5),('inactiveText','hover',4.5),('inactiveIndex','hover',4.5),('inactive','chrome',1.25),('active','inactive',1.35),('hover','inactive',1.15),('accent','inactive',3)]
results=[]
for name,theme in THEMES.items():
    for a,b,minimum in PAIRS:
        normal=contrast(rgb(theme[a]),rgb(theme[b]))
        reduced=contrast(quantize(rgb(theme[a])),quantize(rgb(theme[b])))
        assert normal>=minimum and reduced>=minimum,(name,a,b,normal,reduced)
        results.append({'theme':name,'foreground':a,'background':b,'minimum':minimum,'RGB888':normal,'RGB565':reduced})
tokens={'kind':'design_proposal_not_product','version':'1.1','sourceBaseline':BASE_SHA,'previousDesignHead':'2d5ac0975fc7001473c96a08759389a385093009','userApprovedChange':'Preserve overall palette; give inactive tabs a distinguishable opaque background','themes':THEMES,'metricsCSSPx':METRICS,'terminalANSI':'preserve current per-profile scheme; no new ANSI palette','semantics':{'selected':'inset shape + 2px marker + weight600','inactive':'opaque filled shape, no selected marker, weight400; existing text role used where needed','hover':'opaque existing hover fill + visible close action; no selected marker','keyboardFocus':'2px outer ring; inactive focused tab remains unselected','unfocused':'same selected and inactive fills + solid neutral selected marker; no whole-window alpha','paneFocus':'short 2px marker in pane header; terminal glyphs stay undimmed','status':'icon + label; never hue alone'}}
(ROOT/'tokens.json').write_text(json.dumps(tokens,ensure_ascii=False,indent=2)+'\n')
(ROOT/'contrast-audit.json').write_text(json.dumps({'kind':'design_token_math_only','realXrdp':False,'runtimeProduct':False,'method':'RGB565 bit truncation then replication','pairs':results,'minimumTextRGB565':min(r['RGB565'] for r in results if r['minimum']==4.5),'minimumMarkerRGB565':min(r['RGB565'] for r in results if r['minimum']==3)},indent=2)+'\n')


class Board:
    def __init__(self,theme,width=1440,height=1000):
        self.t=THEMES[theme];self.theme=theme;self.width=width;self.height=height;self.p=[]
        self.rect(0,0,width,height,self.t['paper'])
    def rect(self,x,y,w,h,color,r=0,stroke=None,sw=1):
        extra=f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{color}"{extra}/>')
    def line(self,x1,y1,x2,y2,color,width=1,dash=None):
        d=f' stroke-dasharray="{dash}"' if dash else ''
        self.p.append(f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round"{d}/>')
    def text(self,x,y,value,size=13,color=None,weight=400,mono=False,anchor='start'):
        family='DejaVu Sans Mono' if mono else 'Noto Sans CJK SC'
        self.p.append(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" fill="{color or self.t["text"]}" text-anchor="{anchor}">{html.escape(value)}</text>')
    def circle(self,x,y,r,color,stroke=None):
        self.p.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}"'+(f' stroke="{stroke}" stroke-width="1.5"' if stroke else '')+'/>' )
    def icon(self,x,y,name,color=None):
        c=color or self.t['secondary']
        if name=='plus':self.line(x+3,y+8,x+13,y+8,c,1.6);self.line(x+8,y+3,x+8,y+13,c,1.6)
        elif name=='close':self.line(x+4,y+4,x+12,y+12,c,1.5);self.line(x+12,y+4,x+4,y+12,c,1.5)
        elif name=='search':self.circle(x+6.5,y+6.5,4.5,'none',c);self.line(x+10,y+10,x+14,y+14,c,1.6)
        elif name=='split':self.rect(x+1.5,y+2,13,12,'none',2,c,1.5);self.line(x+8,y+3,x+8,y+13,c,1.5)
        elif name=='menu':
            for a in (4,8,12):self.line(x+2,y+a,x+14,y+a,c,1.6)
        elif name=='tree':self.rect(x+2,y+2,12,12,'none',2,c,1.5);self.line(x+6,y+3,x+6,y+13,c,1.5)
        elif name=='terminal':self.line(x+3,y+4,x+6,y+7,c,1.5);self.line(x+6,y+7,x+3,y+10,c,1.5);self.line(x+8,y+11,x+13,y+11,c,1.5)
        elif name=='chevron':self.line(x+4,y+6,x+8,y+10,c,1.5);self.line(x+8,y+10,x+12,y+6,c,1.5)
        elif name=='check':self.line(x+3,y+8,x+6,y+11,c,1.8);self.line(x+6,y+11,x+13,y+4,c,1.8)
        elif name=='warning':
            self.p.append(f'<path d="M{x+8} {y+1} L{x+15} {y+14} L{x+1} {y+14} Z" fill="none" stroke="{c}" stroke-width="1.5" stroke-linejoin="round"/>');self.line(x+8,y+5,x+8,y+9,c,1.5);self.circle(x+8,y+12,0.9,c)
        elif name=='pause':self.line(x+5,y+3,x+5,y+13,c,2);self.line(x+11,y+3,x+11,y+13,c,2)
        elif name=='lock':self.rect(x+3,y+7,10,7,'none',2,c,1.5);self.p.append(f'<path d="M{x+5} {y+7} V{y+5} a3 3 0 0 1 6 0 V{y+7}" fill="none" stroke="{c}" stroke-width="1.5"/>')
        elif name=='retry':self.p.append(f'<path d="M{x+13} {y+5} a5.5 5.5 0 1 0 0 7 M{x+13} {y+2} V{y+6} H{x+9}" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>')
    def button(self,x,y,w,label,primary=False,icon=None):
        self.rect(x,y,w,32,self.t['accent'] if primary else self.t['active'],6,None if primary else self.t['divider'])
        if icon:self.icon(x+10,y+8,icon,self.t['onAccent'] if primary else self.t['secondary'])
        self.text(x+w/2+(9 if icon else 0),y+21,label,13,self.t['onAccent'] if primary else self.t['text'],500,anchor='middle')
    def heading(self,title,subtitle,tag):
        self.text(72,44,'TABBY  /  LINUX',13,self.t['accent'],600)
        self.text(72,98,title,32,weight=600)
        self.text(72,130,subtitle,15,self.t['secondary'])
        self.text(1368,44,tag,12,self.t['secondary'],anchor='end')
    def footer(self,caption):
        self.text(72,self.height-64,caption,14,self.t['secondary'])
        self.text(72,self.height-32,'设计方案 v1.1 · 非活动标签底色调整 · 非产品截图 · 所有数据均为样例',12,self.t['secondary'])
        self.text(self.width-72,self.height-32,'BASE  d83bf1b  /  '+self.theme.upper(),12,self.t['secondary'],anchor='end')
    def save(self,name):
        header=f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}"><title>Tabby Linux design proposal — not a product screenshot</title><desc>Original proposed interface, fictional data, source baseline {BASE_SHA}. Not pixel-accurate product evidence.</desc>'
        (ROOT/'svg'/f'{name}.svg').write_text(header+'\n'+'\n'.join(self.p)+'\n</svg>\n')


def tab(b,x,y,label,index,state='inactive',width=220,window_focused=True):
    t=b.t
    selected=state in ('active','focus','blur')
    theme=next(name for name,value in THEMES.items() if value is t)
    b.p.append(f'<g data-tab-state="{state}" data-tab-selected="{str(selected).lower()}" data-window-focused="{str(window_focused).lower()}" data-theme="{theme}">')
    b.rect(x,y,width,36,t['active'] if selected else t['hover'] if state=='hover' else t['inactive'],6)
    marker=t['unfocused'] if state=='blur' else t['accent']
    if selected:b.rect(x+12,y+34,width-24,2,marker,1)
    if state in ('focus','inactivefocus'):b.rect(x-2,y-2,width+4,40,'none',8,t['accent'],2)
    b.text(x+12,y+23,str(index),12,t['index'] if selected else t['inactiveIndex'])
    b.icon(x+31,y+10,'terminal',t['text'] if selected else t['inactiveText'])
    b.text(x+54,y+23,label,13,t['text'] if selected else t['inactiveText'],600 if selected else 400)
    if selected or state in ('hover','inactivefocus'):b.icon(x+width-26,y+10,'close',t['secondary'] if selected else t['inactiveText'])
    b.p.append('</g>')


def shell(b,split=True,recovery=False,window_focused=True):
    t=b.t;x=72;y=174;w=1296;h=696
    b.rect(x,y,w,h,t['terminal'],8,t['subtle'])
    # Window decorations are illustrative and belong to the Linux window manager.
    b.rect(x,y,w,30,t['title'],8);b.rect(x,y+15,w,15,t['title'])
    b.text(x+w/2,y+20,'Tabby',12,t['secondary'],anchor='middle')
    b.line(x+w-91,y+15,x+w-81,y+15,t['secondary'],1.4)
    b.rect(x+w-58,y+10,10,10,'none',1,t['secondary'],1.2);b.icon(x+w-29,y+7,'close')
    ty=y+30;b.rect(x,ty,w,44,t['chrome'])
    b.icon(x+16,ty+14,'tree')
    tab(b,x+48,ty+4,'SSH · 示例开发机',1,'active' if window_focused else 'blur',window_focused=window_focused)
    tab(b,x+272,ty+4,'本地终端',2,window_focused=window_focused)
    tab(b,x+496,ty+4,'构建输出',3,window_focused=window_focused)
    b.circle(x+692,ty+21,2.5,t['secondary'])
    for dx,name in [(w-192,'plus'),(w-162,'chevron'),(w-126,'search'),(w-90,'split'),(w-54,'menu')]:b.icon(x+dx,ty+14,name)
    py=ty+44;footerY=y+h-24;paneHeight=footerY-py;left=776 if split else w
    for px,pw,label,role,focused in [(x,left,'dev@demo.example.invalid · work','共享',True)]+([(x+left,w-left,'本地 · ~/workspace','本地',False)] if split else []):
        b.rect(px,py,pw,28,t['chrome'])
        b.text(px+16,py+19,label,12,t['text'] if focused else t['secondary'],500)
        b.text(px+pw-16,py+19,role,12,t['secondary'],anchor='end')
        if focused:b.rect(px+16,py+26,24,2,t['accent'] if window_focused else t['unfocused'],1)
    if split:b.line(x+left+.5,py,x+left+.5,footerY,t['divider'],1)
    bodyY=py+28
    if recovery:
        b.rect(x,bodyY,w,76,t['warningBg'])
        b.icon(x+16,bodyY+15,'pause',t['warning']);b.text(x+44,bodyY+28,'恢复已暂停',16,t['warning'],600)
        b.text(x+44,bodyY+55,'work 仍被其他客户端使用。请选择访问方式。',14,t['warning'])
        b.button(x+w-350,bodyY+20,120,'选择方式',True)
        b.button(x+w-218,bodyY+20,100,'重新检查')
        b.text(x+w-66,bodyY+42,'取消',13,t['warning'],anchor='middle')
        bodyY+=76
    ansi={'dark':['#B1E969','#EBD99C','#5DA9F6','#CACACA'],'light':['#718C00','#EAB700','#4271AE','#4D4D4C']}[b.theme]
    lines=[('dev@demo:~/workspace$ git status',3),('On branch feature/ssh-tmux-recovery',3),('',3),('Changes not staged for commit:',3),('  modified: src/connection.ts',1),('  modified: src/tab-bar.scss',1),('',3),('dev@demo:~/workspace$ npm run test',3),('PASS  SSH session recovery',0),('PASS  Cancellation',0),('PASS  Tab identity',0)]
    if recovery:lines=[('dev@demo:~/workspace$ npm run dev',3),('Application running',3),('',3),('Last output preserved while reconnect is paused.',3)]
    for i,(value,c) in enumerate(lines):b.text(x+16,bodyY+34+i*24,value,16,ansi[c],mono=True)
    if not recovery:
        b.text(x+16,bodyY+34+len(lines)*24+24,'dev@demo:~/workspace$ ',16,t['terminalText'],mono=True)
        b.rect(x+247,bodyY+34+len(lines)*24+10,9,18,t['terminalText'])
    if split:
        rightlines=['~/workspace$ tail -f build.log','','14:32:08  Checking types','14:32:11  Bundling modules','14:32:18  Build complete','','~/workspace$']
        for i,value in enumerate(rightlines):b.text(x+left+16,py+62+i*24,value,16,t['terminalText'],mono=True)
    b.rect(x,footerY,w,24,t['chrome'])
    b.icon(x+14,footerY+4,'pause' if recovery else 'check',t['warning'] if recovery else t['success'])
    b.text(x+38,footerY+17,'恢复暂停 · tmux work · server 身份保持' if recovery else '已连接 · tmux work · 共享',12,t['secondary'])
    b.text(x+w-16,footerY+17,'Ctrl+Shift+P 命令    ·    UTF-8',12,t['secondary'],anchor='end')
    return x,y,w,h


for mode in ('dark','light'):
    b=Board(mode);b.heading('轻量标签工作台','当前会话优先，工具后退；终端内容保持原有配色。','01 / 日常工作 · '+('暗色' if mode=='dark' else '浅色'))
    shell(b)
    b.footer('调整：非活动标签增加实色底色 · 活动标签保留 2px 标记与 600 字重 · 终端配色保持')
    b.save(f'Tabby-Linux-UIUX-v1-{mode}-workspace')
    b=Board(mode);b.heading('快速打开会话','复用现有配置、命令选择器与快捷键，不把工具塞满主界面。','02 / 会话入口 · '+('暗色' if mode=='dark' else '浅色'))
    shell(b)
    t=b.t;mx=422;my=290;mw=596;mh=456
    b.rect(mx,my,mw,mh,t['active'],10,t['divider'],1)
    b.text(mx+24,my+38,'打开会话',20,weight=600);b.icon(mx+mw-38,my+23,'close')
    b.rect(mx+24,my+62,mw-48,42,t['chrome'],6,t['accent'],2)
    b.icon(mx+38,my+75,'search');b.text(mx+64,my+89,'搜索配置或输入主机…',14,t['secondary'])
    b.text(mx+24,my+134,'最近使用',12,t['secondary'])
    for i,(title,sub,selected) in enumerate([('SSH · 示例开发机','dev@demo.example.invalid',True),('本地终端','默认 Shell · ~/workspace',False),('SSH · 示例测试机','dev@staging.example.invalid',False)]):
        ry=my+146+i*64
        if selected:b.rect(mx+12,ry,mw-24,60,t['hover'],6);b.rect(mx+12,ry+14,2,32,t['accent'],1)
        b.icon(mx+26,ry+20,'terminal');b.text(mx+54,ry+23,title,14,weight=500);b.text(mx+54,ry+45,sub,12,t['secondary'])
        if selected:b.text(mx+mw-30,ry+34,'Enter',12,t['secondary'],anchor='end')
    b.line(mx+24,my+350,mx+mw-24,my+350,t['subtle'])
    b.text(mx+24,my+389,'＋ 添加 SSH 主机',14,t['accent'],500)
    b.text(mx+24,my+426,'↑↓ 选择    Enter 打开    Esc 返回',12,t['secondary'])
    b.footer('已有 Ctrl+Shift+E 打开配置选择器；命令入口保留 Ctrl+Shift+P，实际提示读取用户绑定。')
    b.save(f'Tabby-Linux-UIUX-v1-{mode}-launcher')
    b=Board(mode);b.heading('恢复状态有位置，也有出口','用图标、文案和操作解释当前状态；保留终端输出与原会话身份。','03 / 恢复暂停 · '+('暗色' if mode=='dark' else '浅色'))
    shell(b,split=False,recovery=True)
    b.footer('选择方式进入共享 / 只读 / 显式接管；自动恢复不踢掉其他客户端，也不重建消失的会话。')
    b.save(f'Tabby-Linux-UIUX-v1-{mode}-recovery')
    b=Board(mode);b.heading('窗口失焦：标签仍有位置','保留已认可的配色；非活动底色不消失，选中项采用实色中性标记。','05 / 失焦验证 · '+('暗色' if mode=='dark' else '浅色'))
    shell(b,window_focused=False)
    b.footer('失焦不降低透明度；非活动实色底色保留，当前标签仍由形状、字重和标记辨认。')
    b.save(f'Tabby-Linux-UIUX-v1-{mode}-workspace-window-blur')

b=Board('light',1440,1236);b.heading('状态对照与配色角色','变化集中在必要标记；未选中不等于不可读，窗口失焦不抹掉当前位置。','04 / 两套主题状态表')
b.text(332,187,'暗色',16,weight=600);b.text(888,187,'浅色',16,weight=600)
rows=[('活动标签','原底色 + 2px 标记 + 600 字重','active'),('非活动标签','新增实色底色；无选中标记','inactive'),('鼠标悬停','独立实色底色 + 关闭操作','hover'),('键盘焦点','非活动焦点环不改变选中项','focus'),('窗口失焦','选中与非活动底色都保留','blur'),('有新输出','小圆点 + 可读提示','activity'),('只读会话','锁形图标 +「只读」标签','readonly'),('正在重连','重试图标 + 倒计时 + 取消','retry'),('恢复暂停','暂停图标 + 选择访问方式','paused'),('错误 / 身份丢失','错误图标 + 明确原因 + 查看详情','error')]
for i,(label,note,state) in enumerate(rows):
    y=214+i*80;b.text(72,y+23,label,15,weight=500);b.text(72,y+47,note,11,b.t['secondary'])
    for mode,x in [('dark',304),('light',860)]:
        old=b.t;b.t=THEMES[mode];t=b.t;b.rect(x,y,508,60,t['chrome'],8)
        if state in ('active','inactive','hover'):tab(b,x+12,y+12,'SSH · 示例开发机',1,state,320)
        elif state in ('focus','blur'):
            tab(b,x+12,y+12,'SSH · 示例开发机',1,'active' if state=='focus' else 'blur',220,window_focused=state!='blur')
            tab(b,x+248,y+12,'本地终端',2,'inactivefocus' if state=='focus' else 'inactive',220,window_focused=state!='blur')
        elif state=='activity':tab(b,x+12,y+12,'构建输出',3,'inactive',320);b.circle(x+305,y+29,3,t['secondary']);b.text(x+349,y+35,'有新输出',12,t['secondary'])
        elif state=='readonly':b.icon(x+20,y+22,'lock');b.text(x+48,y+35,'只读 · tmux work',13,t['text']);b.text(x+330,y+35,'输入禁用',12,t['secondary'])
        elif state=='retry':b.icon(x+20,y+22,'retry');b.text(x+48,y+35,'正在重连 · 2 秒后再试',13,t['text']);b.text(x+455,y+35,'取消',13,t['accent'],anchor='end')
        elif state=='paused':b.icon(x+20,y+22,'pause',t['warning']);b.text(x+48,y+35,'恢复暂停 · 会话已占用',13,t['text']);b.text(x+470,y+35,'选择方式',13,t['accent'],anchor='end')
        else:b.icon(x+20,y+22,'warning',t['danger']);b.text(x+48,y+35,'原会话不存在',13,t['text']);b.text(x+470,y+35,'查看详情',13,t['accent'],anchor='end')
        b.t=old
for mode,x in [('dark',304),('light',860)]:
    t=THEMES[mode]
    for i,key in enumerate(['chrome','inactive','active','hover','accent','secondary']):
        px=x+i*83;b.rect(px,1055,70,28,t[key],4);b.text(px,1102,key,10,b.t['secondary']);b.text(px,1123,t[key],10,b.t['secondary'],mono=True)
b.footer('文字 ≥ 4.5:1，关键标记 ≥ 3:1；非活动/栏底 ≥ 1.25，活动/非活动 ≥ 1.35；均检查 RGB565。')
b.save('Tabby-Linux-UIUX-v1-state-matrix')
print('Generated 9 original SVG design boards; 46 color pairs pass normal/RGB565 token gates. Product source unchanged.')
