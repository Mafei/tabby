#!/usr/bin/env python3
"""Build an offline, fictional design review. No application runtime is imported."""
import html
import json
import re
from pathlib import Path
from navigation import CSS as NAV_CSS, SCRIPT as NAV_SCRIPT, install as install_navigation, review_pages

ROOT = Path(__file__).resolve().parent
E = html.escape
CSS = """
*{box-sizing:border-box}body{margin:0;background:#edf1f3;color:#152330;font-family:Arial,"Noto Sans CJK SC",sans-serif;font-size:16px}
button,a,input,select{font:inherit}button{cursor:pointer;border:0}button:focus-visible,a:focus-visible,select:focus-visible{outline:3px solid #228771;outline-offset:2px}
.mobile{position:relative;width:360px;height:800px;display:flex;flex-direction:column;background:#111820;color:#e7edf3;overflow:hidden;flex-shrink:0;font-size:16px}
.mobile.wide{width:840px;height:900px}.mobile.landscape{width:800px;height:360px}
.status{display:flex;align-items:center;height:48px;min-height:48px;background:#19232e;border-bottom:1px solid #30404e}
.status button{height:48px;min-width:48px;padding:0 12px;background:transparent;color:#e7edf3}
.status .identity{flex:1;min-width:0;text-align:left;line-height:1.1;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.identity span{display:block;font-size:11px;color:#74e4c8;margin-top:3px}.identity .warning{color:#ffc780}.identity .danger{color:#ff9c9c}
.body{flex:1;min-height:0;overflow:auto;padding:24px 20px}.body h1{font-size:26px;margin:0 0 12px;font-weight:600;letter-spacing:-.5px}
.body h2{font-size:18px;margin:24px 0 10px}.body p{line-height:1.6;margin:10px 0;color:#acbbc7}
.eyebrow{font-size:11px;color:#74e4c8;letter-spacing:1.4px;margin-bottom:10px}
.card{border:1px solid #30404e;background:#19232e;border-radius:14px;margin:12px 0;padding:16px}
.card p{font-size:14px}.card .small,.small{font-size:12px;color:#acbbc7;line-height:1.6}
.action{display:block;min-height:48px;border-radius:9px;margin:10px 0;padding:12px 16px;width:100%;background:#74e4c8;color:#111820;text-align:center;font-weight:600}
.action.secondary{color:#e7edf3;background:#253342;border:1px solid #3c5061}.action.danger{background:#ff9c9c;color:#111820}.action.quiet{color:#acbbc7;background:transparent}
.host{display:block;width:100%;text-align:left;min-height:76px;padding:16px;background:#19232e;color:#e7edf3;border-radius:12px;margin:10px 0;border:1px solid #30404e}
.host strong{font-weight:500}.host span{display:block;color:#acbbc7;font-size:13px;margin-top:8px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#74e4c8;margin-right:7px}
.field{border:1px solid #3c5061;background:#111820;border-radius:8px;padding:13px 12px;min-height:48px;margin-top:5px;line-height:1.5}.label{display:block;font-size:13px;color:#acbbc7;margin-top:15px}
.check{display:flex;align-items:center;min-height:48px;font-size:14px;gap:10px}.box{width:20px;height:20px;border:1px solid #5d7386;border-radius:4px;flex-shrink:0}.check.on .box{background:#74e4c8;color:#111820;text-align:center}
.terminal{flex:1;min-height:0;padding:8px;overflow:hidden;background:#111820;position:relative}.terminal pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:16px/20.8px "DejaVu Sans Mono",monospace;font-variant-ligatures:none}
.terminal .green{color:#74e4c8}.terminal .dim{color:#acbbc7}.terminal .amber{color:#ffc780}.cursor{display:inline-block;background:#e7edf3;color:#111820}
.keys{height:48px;min-height:48px;display:flex;background:#19232e;border-top:1px solid #30404e;overflow-x:auto}
.keys button{flex:1;min-width:48px;height:48px;background:transparent;color:#e7edf3;border-right:1px solid #30404e;font-size:14px}
.ime{height:300px;min-height:300px;background:#26333f;padding:10px 5px;color:#e7edf3;display:flex;flex-direction:column;justify-content:space-between;border-top:1px solid #465967}
.wide .ime{height:320px;min-height:320px}.landscape .ime{height:180px;min-height:180px}
.suggest{display:flex;justify-content:space-around;color:#d1dde5;font-size:15px;padding:4px 0 12px}.keyrow{display:flex;gap:4px;justify-content:center;margin:3px 0}
.keyrow span{flex:1;background:#3b4a57;border-radius:6px;min-height:42px;display:flex;align-items:center;justify-content:center;font-size:16px}
.keyrow .space{flex:4}.keyrow .enter{background:#74e4c8;color:#111820}.ime-note{text-align:center;font-size:10px;color:#acbbc7;padding:3px}
.landscape .keyrow span{min-height:20px;font-size:12px}.landscape .suggest{padding-bottom:0}.landscape .keyrow{margin:1px 0}
.scrim{position:absolute;inset:48px 0 0;background:#070c12a8;display:flex;align-items:flex-end}
.sheet{width:100%;max-height:100%;overflow:auto;padding:18px 20px 16px;background:#19232e;border-top:1px solid #496172;border-radius:20px 20px 0 0;box-shadow:0 -20px 60px #0003}
.sheet h2{margin:8px 0 12px;font-size:21px}.sheet p{font-size:14px;line-height:1.6;color:#acbbc7}
.handle{width:40px;height:4px;background:#687e8d;border-radius:4px;margin:0 auto 18px}
.menu{display:block;width:100%;min-height:48px;text-align:left;background:transparent;color:#e7edf3;padding:12px 0;border-bottom:1px solid #30404e}
.menu small{display:block;color:#acbbc7;margin-top:5px}.menu:last-child{border:0}
.split{display:flex;flex:1;min-height:0}.sidebar{width:240px;flex-shrink:0;background:#19232e;border-right:1px solid #30404e;padding:20px 14px;overflow:auto}
.sidebar h2{font-size:16px}.sidebar .host{background:#111820;padding:12px;min-height:72px}
.notice{position:absolute;left:12px;right:12px;bottom:20px;background:#253342;border:1px solid #506676;border-radius:12px;padding:16px;font-size:14px;line-height:1.5}
.selected{background:#315d73}.selection-toolbar{display:flex;background:#e7edf3;color:#111820;width:max-content;border-radius:8px;margin:12px 0 14px}
.selection-toolbar button{background:transparent;min-height:48px;padding:0 18px}.selection-handle{color:#74e4c8;font-size:23px}.fingerprint{font:12px/1.7 "DejaVu Sans Mono",monospace;overflow-wrap:anywhere;color:#e7edf3;background:#111820;padding:12px;border-radius:8px}
.badge{display:inline-block;padding:4px 8px;border:1px solid #465967;border-radius:5px;color:#acbbc7;font-size:12px;margin-top:8px}
.prototype-header{padding:18px 24px;background:#fff;border-bottom:1px solid #cad4dc;display:flex;align-items:center;gap:16px;flex-wrap:wrap}.prototype-header strong{font-size:19px}
.prototype-header select{min-height:48px;max-width:100%;padding:8px;border:1px solid #a9bbc8;border-radius:8px;background:#fff}.prototype-header a{color:#246e60}
.prototype-note{max-width:960px;margin:16px auto;color:#506676;line-height:1.6;font-size:14px;padding:0 16px}
.stage{display:flex;justify-content:center;align-items:flex-start;padding:24px;overflow:auto}
.capture .prototype-header,.capture .prototype-note{display:none}.capture .stage{padding:0;justify-content:flex-start}.capture{background:#111820}
.review{max-width:1120px;margin:auto;background:#fff}.page{padding:40px 48px;border-bottom:1px solid #dce4e9}
.page > h1{font-size:39px;line-height:1.2;letter-spacing:-1px;margin:0 0 20px}.page > h2{font-size:26px;margin:0 0 14px}.page h3{font-size:18px;margin:12px 0}.page > p,.page .gallery > div > p{line-height:1.65;color:#43586a;margin:8px 0}
.page .kicker{color:#246e60;font-size:12px;letter-spacing:2px;margin-bottom:16px}.pill{display:inline-block;border:1px solid #9fb9b2;color:#246e60;border-radius:30px;padding:8px 14px;font-size:12px;margin:0 5px 12px 0}
.gallery{display:flex;gap:30px;justify-content:space-between;align-items:flex-start;margin-top:22px}.tile{flex:1;min-width:0;margin:0}.frame{width:216px;height:480px;border:1px solid #30404e;border-radius:16px;overflow:hidden;background:#111820;box-shadow:0 10px 24px #10233020}
.frame .mobile{transform:scale(.6);transform-origin:top left}.tile figcaption{font-size:13px;line-height:1.6;color:#43586a;margin-top:12px;max-width:230px}
.wideframe{width:462px;height:495px;border:1px solid #30404e;overflow:hidden;border-radius:12px}.wideframe .mobile{transform:scale(.55);transform-origin:top left}
.landscapeframe{width:560px;height:252px;border:1px solid #30404e;overflow:hidden;border-radius:12px}.landscapeframe .mobile{transform:scale(.7);transform-origin:top left}
.callout{padding:16px 20px;background:#edf6f3;border-left:4px solid #278b76;margin:16px 0;font-size:14px;line-height:1.7}.flow{padding:16px;background:#f1f4f6;border:1px solid #d7e1e8;border-radius:8px;font-size:15px;line-height:1.9}
.wire{display:flex;gap:24px;margin:20px 0}.wirebox{border:1px solid #627888;padding:14px;width:180px;height:250px;font-size:13px;display:flex;flex-direction:column;gap:8px}
.wirebox span{border:1px solid #8498a7;padding:7px;text-align:center}.wirebox .grow{flex:1;display:flex;align-items:center;justify-content:center}
.details{padding:36px 48px}.details h1{font-size:26px}.details h2{font-size:21px;break-after:avoid}.details p,.details li{font-size:13px;line-height:1.75}.details ul,.details ol{padding-left:22px}
table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5;margin:16px 0}th,td{border-bottom:1px solid #d5dfe6;padding:8px;text-align:left;vertical-align:top}th{background:#edf1f3}
a{color:#246e60}code{font-size:.94em;background:#edf1f3;padding:1px 4px;overflow-wrap:anywhere}.details table{font-size:10px}.details a{overflow-wrap:anywhere}
@page{size:A4 landscape;margin:12mm}@media print{body{background:#fff}.review{max-width:none}.page{break-after:page;padding:12px 10px;border:0}.page > h1{font-size:34px}.page > h2{font-size:24px}
.gallery{justify-content:flex-start;gap:42px;margin-top:15px}.frame{box-shadow:none;width:194.4px;height:432px}.frame .mobile{transform:scale(.54)}.wideframe{width:420px;height:450px}.wideframe .mobile{transform:scale(.5)}.page > p,.page .gallery > div > p{font-size:13px}.tile figcaption{font-size:12px}.details{padding:0}.details table{break-inside:auto}tr{break-inside:avoid}.details h2{margin-top:22px}.pill{margin-bottom:8px}}
"""
CSS += NAV_CSS

def button(label, target, kind="action"):
    accessible = {"⌨":"显示键盘","•••":"更多终端操作"}.get(label)
    aria = f' aria-label="{accessible}"' if accessible else ""
    return f'<button class="{kind}" data-screen="{target}"{aria}>{label}</button>'

def status(label="work · demo@lab.example", state="已连接", target="sessions", tone=""):
    return '<div class="status">' + button(f'{label}<span class="{tone}">{state}</span>', target, "identity") + button("⌨", "terminal-ime", "icon") + button("•••", "more", "icon") + '</div>'

def field(label, value):
    return f'<label class="label">{label}<div class="field">{value}</div></label>'

def check(label, on=False):
    return f'<div class="check {"on" if on else ""}"><span class="box">{"✓" if on else ""}</span>{label}</div>'

def host(label, detail, target="terminal", state=""):
    return button(f'<strong>{label}</strong><span>{detail}</span>{f"<div class=badge>{state}</div>" if state else ""}', target, "host")

def ime():
    rows = ["q w e r t y u i o p", "a s d f g h j k l", "⇧ z x c v b n m ⌫"]
    return '<div class="ime" aria-label="系统输入法区域，仅示意，不是Tabby提供"><div class="suggest"><span>demo</span><span>工作</span><span>输入法</span></div>' + ''.join('<div class="keyrow">'+''.join(f'<span>{E(k)}</span>' for k in row.split())+'</div>' for row in rows) + '<div class="keyrow"><span>123</span><span>中/英</span><span class="space">空格</span><span class="enter">↵</span></div><div class="ime-note">系统输入法区域 · 候选与皮肤由用户IME提供</div></div>'

def keys():
    return '<div class="keys">' + ''.join(button(label, target, "") for label,target in [("Esc","terminal-ime"),("Ctrl","terminal-ime"),("Tab","terminal-ime"),("方向","directions"),("会话","sessions"),("更多","more")]) + '</div>'

SHORT = '<span class="dim">demo@lab:~/project</span>\n<span class="green">$ </span>git status --short\n M src/main.ts\n\n<span class="green">$ </span>printf "你好，终端\\n"\n你好，终端\n\n<span class="green">$ </span>tmux display -p "#S"\nwork\n\n<span class="green">$ </span><span class="cursor"> </span>'
LONG = '<span class="dim">demo@lab:~/project</span>\n<span class="green">$ </span>npm run check\n\n> app@0.1.0 check\n> tsc --noEmit\n\n✓ 类型检查通过\n\n<span class="green">$ </span>git status --short\n M src/main.ts\n\n<span class="green">$ </span>printf "你好，终端\\n"\n你好，终端\n\n<span class="green">$ </span>tmux display -p "#S"\nwork\n\n<span class="green">$ </span>ls\nREADME.md  src  test\n\n<span class="green">$ </span><span class="cursor"> </span>'
WIDE = '<span class="dim">demo@lab:~/project</span>\n<span class="green">$ </span>git status --short\n M src/main.ts\n\n<span class="green">$ </span>npm run check\n\n> app@0.1.0 check\n> tsc --noEmit\n\n✓ 类型检查通过 · 终端字号保持 16sp\n\n<span class="green">$ </span>printf "Latin · 你好 · é · 👩‍💻\\n"\nLatin · 你好 · é · 👩‍💻\n\n<span class="dim">展开后按实际窗口重新 fit；不复制会话、不重发命令。</span>\n\n<span class="green">$ </span><span class="cursor"> </span>'

def terminal(keyboard=False, wide=False, state="已连接", tone="", selection=False, sidebar=False):
    content = WIDE if wide else (SHORT if keyboard else LONG)
    if selection:
        content = '<div class="selection-toolbar">' + button("复制","history","") + button("全选","selection","") + button("完成","terminal","") + '</div><pre><span class="dim">已冻结的解析文本 · 系统选择柄示意</span>\n\n<span class="selected"> M src/main.ts\n\n$ printf "你好，终端\\n"\n你好，终端</span>\n<span class="selection-handle">●                     ●</span></pre>'
    else:
        content = '<pre>'+content+'</pre>'
    area = '<div class="terminal">'+content+'</div>'
    if sidebar:
        area = '<div class="split"><aside class="sidebar"><h2>会话</h2>'+host("work","demo@lab.example")+host("logs","只读 · 同一主机","readonly")+button("收起面板","fold","action secondary")+'</aside>'+area+'</div>'
    return status(state=state,tone=tone)+area+(keys()+ime() if keyboard else "")

def sheet(title, content, underlying=None):
    return (underlying or terminal()) + '<div class="scrim"><section class="sheet"><div class="handle"></div><h2>'+title+'</h2>'+content+'</section></div>'

STATES = {}
def add(key, label, content, cls="", note=""):
    STATES[key] = {"label":label,"html":'<div class="mobile '+cls+'" data-state="'+key+'">'+content+'</div>',"note":note}

add("hosts","01 · 连接工作台",status("连接", "此设备 · 本地", "hosts")+'<div class="body"><div class="eyebrow">你的工作，随时接着做</div><h1>连接</h1><p>主机配置与活动会话分开。<br>密码仅在你选择后保存在此设备。</p><h2>正在进行</h2>'+host("work","demo@lab.example · tmux","terminal","已连接")+host("logs","demo@lab.example · tmux","offline","待恢复")+ '<h2>主机</h2>'+host("实验环境","lab.example:22 · demo","connect")+button("＋ 添加主机 / 快速连接","connect")+button("密码与后台设置","credentials","action quiet")+'</div>',note="工作台保留连接入口；登录后不常驻主机表单。")
add("connect","02 · 首次连接",status("新连接","密码默认不保存","hosts")+'<div class="body"><h1>连接主机</h1>'+field("主机","lab.example")+field("端口","22")+field("账号","demo")+field("认证方式","密码 · 支持私钥文件 / 交互认证")+field("密码","••••••••")+check("保存主机配置")+check("在此设备保存密码")+ '<p class="small">虚构字段；此设计稿不接受真实凭据。<br>仅主机校验与认证都成功后才保存密码。</p>'+button("连接","trust")+button("改用私钥文件…","key-import","action secondary")+button("取消","hosts","action quiet")+'</div>')
add("trust","03 · 首次主机校验",sheet("核对主机身份",'<p>首次连接 lab.example:22。请与管理员提供的指纹核对，确认你正在连接正确主机。</p><div class="fingerprint">ED25519 · SHA256<br>FICTITIOUS-DESIGN-FINGERPRINT<br>非真实主机密钥</div><p>接受后只在此设备记录。尚未发送认证密码。</p>'+button("已核对，信任并继续","tmux")+button("取消连接","hosts","action secondary"),underlying=status("新连接","等待主机校验","hosts")+'<div class="body"></div>'))
add("tmux","04 · tmux 列表",status("demo@lab.example","选择终端会话","hosts")+'<div class="body"><h1>接着工作</h1><p>tmux · 当前 socket: default<br>共享、只读与接管均由你选择。</p>'+host("work","暂无客户端 · 点击恢复","terminal")+host("logs","已有 1 个客户端","occupied")+button("＋ 新建会话","new-session")+button("直接 SSH 终端","terminal","action secondary")+button("刷新列表","tmux","action quiet")+'</div>')
add("new-session","05 · 新建会话",sheet("新建 tmux 会话",field("会话名","work")+'<p>命名在远端原子核对。已有会话不会被覆盖，也不会自动接管。</p>'+button("创建","collision")+button("取消","tmux","action secondary")))
add("occupied","06 · 已被使用",sheet("logs 已有客户端",'<p>请选择这次连接方式。恢复时检测到占用也会暂停，不自动接管。</p>'+button("共享连接","terminal")+button("只读连接","readonly","action secondary")+button("接管…","takeover","action secondary")+button("取消","tmux","action quiet")))
add("takeover","07 · 显式接管",sheet("接管 logs？",'<p>此操作会让该 tmux 会话的其他客户端断开。会话内的远端进程仍运行。</p><div class="card">demo@lab.example · logs<br><span class="small">已核对账号、socket 与会话身份</span></div>'+button("确认接管","terminal","action danger")+button("保留其他客户端，取消","occupied","action secondary")))
add("terminal","08 · 专注终端 · 键盘关",terminal(),note="只有 48dp 状态行常驻。大块内容区不放重复品牌、新建或断开按钮。")
add("terminal-ime","09 · 专注终端 · 键盘开",terminal(True),note="360×800 安全窗口假设，IME300dp。终端矩形404dp，35×18估算；非设备测量。")
add("sessions","10 · 切换会话",sheet("会话 · 2 / 4",host("work","已连接 · demo@lab.example","terminal")+host("logs","等待网络 · 输入已暂停","offline")+button("＋ 新建连接","connect","action secondary")+button("返回连接工作台","hosts","action quiet")))
add("directions","11 · 方向键面板",sheet("方向键",'<p>每个方向有明确按钮。长按文本用于选择，不发送方向键。</p><div class="keys">'+button("←","terminal-ime","")+button("↑","terminal-ime","")+button("↓","terminal-ime","")+button("→","terminal-ime","")+'</div>'+button("返回终端","terminal-ime","action secondary"),underlying=terminal(True)))
add("more","12 · 按需操作",sheet("终端操作",''.join(button(label,target,"menu") for label,target in [("选择 / 复制文本","selection"),("粘贴…","paste"),("字号 · 16sp","font"),("鼠标模式 · 关闭","mouse"),("后台保持连接 · 关闭","background"),("连接详情 / 会话","navigation-sessions"),("密码与本地存储","credentials"),("设置密钥登录…","key-generate"),("断开此连接…","disconnect")])+button("关闭","terminal","action quiet")))
add("font","13 · 终端字号",sheet("保持可读",'<p>终端字号独立于 UI 字号，仍响应系统文字设置。不会为塞入80列自动缩小。</p><div class="card"><strong>16sp · 当前约 35 × 35</strong><p>Latin · 你好 · é · 👩‍💻</p><div class="keys">'+button("− 1sp","font","")+button("16sp","font","")+button("＋ 1sp","font","")+'</div></div><p>范围12–26sp；双指缩放更改真实字号与PTY网格。系统200%文字需另行实测。</p>'+button("恢复默认 16sp","font","action secondary")+button("完成","terminal")))
add("fold","14 · 展开 · 专注终端",terminal(wide=True),"wide",note="设计窗口840×900；85×40估算。展开也不自动出现占宽侧栏。")
add("fold-ime","15 · 展开 · 键盘开",terminal(True,wide=True),"wide",note="设计窗口840×900，IME320；终端矩形484dp，85×22估算。")
add("fold-panel","16 · 展开 · 可选会话面板",terminal(wide=True,sidebar=True),"wide",note="用户主动展开240dp会话侧栏后，网格按剩余窗口重算。")
add("landscape","17 · 横屏短窗口",status()+ '<div class="terminal"><pre><span class="dim">demo@lab:~/project</span>\n<span class="green">$ </span>git status --short\n M src/main.ts\n<span class="green">$ </span><span class="cursor"> </span></pre></div>'+ime(),"landscape",note="800×360，IME180。默认收起快捷条，终端矩形132dp；81×5估算。")
add("selection","18 · 文本选择",terminal(selection=True),note="第一批保留冻结解析文本与系统选择柄的两阶段行为，待真机验证后再简化。")
add("history","19 · 回看历史",terminal()+ '<div class="notice">文本已复制（设计状态）。<br>历史回看时暂停自动跟随；收到新输出只提示。'+button("回到最新输出","terminal","action secondary")+'</div>')
add("paste","20 · 多行粘贴确认",sheet("发送 3 行文本？",'<p>换行可能执行命令。先检查内容，确认发送到 work · demo@lab.example。</p><div class="fingerprint">git status --short<br>printf "example\\n"<br>pwd</div><p>剪贴板仅在你点击粘贴时读取。保留控制符检查、bracketed paste 与大小上限。</p>'+button("确认粘贴","terminal")+button("取消","terminal","action secondary")))
add("readonly","21 · 只读会话",terminal(state="只读 · 输入已关闭"),note="允许回看、选择和复制；键盘、粘贴、快捷键和鼠标均不得发送远端输入。")
add("mouse","22 · 显式鼠标模式",sheet("启用鼠标模式？",'<p>仅用于支持鼠标的远端程序。启用后，触控可能发送点击或滚轮事件；顶部持续显示「鼠标」。</p><p>关闭后才恢复默认本地历史滚动与文本选择。模式切换取消在途手势。</p>'+button("启用鼠标模式","mouse-active")+button("取消","terminal","action secondary")))
add("mouse-active","23 · 鼠标模式活动",terminal(state="鼠标模式 · 点击可发送远端事件"),note="初批在鼠标模式关闭双指缩放，避免第一指提前发送远端输入。")
add("offline","24 · 等待网络",terminal(state="已断线 · 输入暂停",tone="warning")+ '<div class="notice"><strong>等待网络 · 1 / 6</strong><br>本地画面保留。仅核对原 tmux 身份后恢复；普通 SSH 需手动重连。'+button("查看恢复状态","offline-details","action secondary")+'</div>')
add("offline-details","25 · 恢复详情",sheet("恢复 work",'<p>连接中断后输入已暂停。网络恢复时，在有限重试窗口内核对原主机、账号与完整 tmux 身份。</p><div class="card">第 1 / 6 次 · 等待网络<br><span class="small">超过窗口后停止自动重试</span></div><p>等待新指纹、认证或会话占用时暂停，返回 app 处理。不会自动新建或接管。</p>'+button("现在重试","missing")+button("停止恢复","stopped","action secondary")))
add("changed","26 · 主机密钥变化",sheet("主机身份变化，已停止",'<p>lab.example 的主机密钥与已记录值不同。没有发送密码，也不会自动重连。</p><div class="fingerprint">原指纹：FICTITIOUS-OLD<br>当前：FICTITIOUS-CHANGED</div><p>请通过可信渠道核实服务器变更。此页不提供「忽略并连接」。</p>'+button("返回连接工作台","hosts"),underlying=status(state="安全校验失败",tone="danger")+'<div class="body"></div>'))
add("missing","27 · 恢复目标不存在",sheet("原会话已不存在",'<p>work 的身份不再匹配。已停止恢复，不会把同名新会话当成原会话，也不会自动创建。</p>'+button("返回 tmux 列表","tmux")+button("停止此连接","stopped","action secondary")))
add("collision","28 · 新建重名失败",sheet("work 已存在",'<p>会话名已被使用。没有覆盖、接管或创建另一目标。你可以选择其他名称，或返回列表查看已有会话。</p>'+button("修改名称","new-session")+button("返回列表","tmux","action secondary")))
add("credentials","29 · 本地凭据",status("密码与存储","仅此设备","hosts")+'<div class="body"><h1>你决定保存什么</h1><p>保存主机不会保存密码。默认不保存；本地密码以 Android Keystore 密钥加密，不云同步、不写终端日志。</p><div class="card"><strong>demo@lab.example:22</strong><p>已保存 · 已绑定验证过的主机身份</p>'+button("更新密码…","update-password","action secondary")+button("删除此密码…","delete-password","action secondary")+'</div><p class="small">密钥失效或密文损坏时要求重新输入；不能保证所有设备都有硬件安全芯片。</p>'+button("此设备SSH密钥…","key-settings","action secondary")+button("后台连接设置","background","action secondary")+'</div>')
add("update-password","30 · 更新密码",sheet("更新此设备保存的密码",field("新密码","••••••••")+check("认证成功后更新保存密码",True)+'<p>先验证原主机，再尝试认证。认证失败或写入失败时保留旧条目；不回填网页密码字段。</p>'+button("验证并更新","update-failed")+button("取消","credentials","action secondary")))
add("update-failed","31 · 更新认证失败",sheet("认证失败，未更新",'<p>新密码未通过认证。旧保存条目保持不变；没有记录密码或上传崩溃报告。</p>'+button("重新输入","update-password")+button("返回本地凭据","credentials","action secondary")))
add("delete-password","32 · 删除密码确认",sheet("删除本地密码？",'<p>移除此目标的加密条目与内存重连密码，并取消待认证和自动重连。当前已认证的SSH连接可继续。</p><p>以后恢复需要重新输入。此操作不删除主机配置或已验证主机密钥。</p>'+button("删除此密码","deleted","action danger")+button("取消","credentials","action secondary")))
add("deleted","33 · 密码已删除",status("密码与存储","仅此设备","hosts")+'<div class="body"><h1>密码已删除</h1><p>此目标没有保存密码。下次认证需要你输入；待认证与自动重连已取消。</p><div class="card">demo@lab.example:22<br><span class="badge">未保存密码</span></div>'+button("返回工作台","hosts")+button("返回当前终端","terminal","action secondary")+'</div>')
add("background","34 · 后台连接说明",sheet("后台保持连接",'<p>关闭（默认）。开启后使用可见连接通知，尽量维持已建立的连接。安卓或厂商仍可能结束进程。</p><p>不会更改省电设置；不会开机自动启动。tmux 可保留远端进程，返回后仍需核对身份。</p><div class="card"><strong>通知由你控制</strong><p>提供「返回」与「停止全部连接」。锁屏不显示主机、账号或终端内容。</p></div>'+button("了解，选择通知权限","permission")+button("暂不开启","terminal","action secondary")))
add("permission","35 · 通知权限解释",sheet("允许显示连接通知？",'<p>下一步由 Android 系统询问通知权限。这份设计不请求任何真实权限。</p><p>本产品只在允许可见通知后启用后台选项；这是产品可控性要求，Android 本身并非禁止无通知权限的前台服务。</p>'+button("示意：允许并开启","notification")+button("示意：拒绝，保持前台模式","permission-denied","action secondary")))
add("permission-denied","36 · 通知权限拒绝",sheet("后台选项未开启",'<p>你未允许可见连接通知。仍可在前台使用终端；不会反复弹系统提示，不会更改手机权限。</p>'+button("返回终端","terminal")+button("重新查看说明","background","action secondary")))
add("notification","37 · 连接通知示意",status("系统通知示意","非实际 Android 通知","terminal")+'<div class="body"><div class="eyebrow">锁屏隐藏敏感信息</div><h1>后台连接已启用</h1><div class="card"><strong>Tabby · 连接保持中</strong><p>2 个活动连接。系统仍可能停止应用。</p>'+button("返回终端","terminal","action secondary")+button("停止全部连接","stopped","action secondary")+'</div><p>通知只显示通用计数与操作，不显示主机、账号、密码或终端内容。</p><p>点停止将清除重连意图、关闭连接并停止服务，不终止远端 tmux 会话。</p></div>')
add("disconnect","38 · 断开当前连接",sheet("断开 work？",'<p>关闭此 SSH 连接并取消自动恢复。远端 tmux 会话中的进程继续运行。</p>'+button("断开此连接","stopped","action danger")+button("继续工作","terminal","action secondary")))
add("stopped","39 · 用户停止",status("连接","用户已停止","hosts")+'<div class="body"><h1>连接已停止</h1><p>没有待执行的自动重连。后台服务与连接通知已结束；远端 tmux 进程未被终止。</p>'+host("work","已停止 · 需手动恢复","tmux")+button("手动连接 / 恢复","connect")+button("返回工作台","hosts","action secondary")+'</div>')

install_navigation(add,button,terminal,ime,sheet,SHORT)

def tile(key, caption):
    return '<figure class="tile"><div class="frame">'+STATES[key]["html"]+'</div><figcaption><strong>'+E(STATES[key]["label"])+'</strong><br>'+caption+'<br><em>设计提案 · 虚构数据</em></figcaption></figure>'

def gallery(items):
    return '<div class="gallery">'+''.join(tile(k,c) for k,c in items)+'</div>'

def page(key, title, body):
    return '<section class="page" id="'+key+'"><div class="kicker">TABBY ANDROID / DESIGN REVIEW / 2026.10.08</div><h2>'+title+'</h2>'+body+'</section>'

def inline(s):
    s = E(s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',r'<a href="\2">\1</a>',s)
    s = re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',s)
    s = re.sub(chr(96)+r'([^'+chr(96)+r']+)'+chr(96),r'<code>\1</code>',s)
    return s

def markdown(source):
    out=[]; paragraph=[]; table=[]; listing=[]
    def flush():
        if paragraph:
            out.append('<p>'+inline(' '.join(paragraph))+'</p>'); paragraph.clear()
        if table:
            rows=[line.strip().strip('|').split('|') for line in table]
            out.append('<table><thead><tr>'+''.join('<th>'+inline(c.strip())+'</th>' for c in rows[0])+'</tr></thead><tbody>')
            for row in rows[2:]:
                out.append('<tr>'+''.join('<td>'+inline(c.strip())+'</td>' for c in row)+'</tr>')
            out.append('</tbody></table>'); table.clear()
        if listing:
            out.append('<ul>'+''.join('<li>'+inline(x)+'</li>' for x in listing)+'</ul>'); listing.clear()
    for line in source.splitlines():
        if not line.strip(): flush()
        elif line.startswith('#'): flush(); level=len(line)-len(line.lstrip('#')); out.append(f'<h{level}>'+inline(line[level:].strip())+f'</h{level}>')
        elif line.startswith('|'): table.append(line)
        elif line.startswith('- ') or re.match(r'^\d+\. ',line): listing.append(re.sub(r'^(- |\d+\. )','',line))
        else: paragraph.append(line.strip())
    flush()
    return ''.join(out)

def build():
    script = """
const models=JSON.parse(document.getElementById('models').textContent);
const stage=document.getElementById('stage'), picker=document.getElementById('picker');
function show(name){if(!models[name])return;if(window.navigationBeforeLeave)window.navigationBeforeLeave();stage.innerHTML=models[name].html;picker.value=name;document.getElementById('note').textContent=models[name].note||'设计提案：按钮仅切换虚构状态，不执行真实操作。';document.body.dataset.current=name;if(window.navigationMounted)window.navigationMounted(name);}
document.addEventListener('click',e=>{const b=e.target.closest('[data-screen]');if(b)show(b.dataset.screen);});
picker.addEventListener('change',()=>show(picker.value));window.designShow=show;window.designStates=Object.keys(models);
const q=new URLSearchParams(location.search);if(q.has('capture'))document.body.classList.add('capture');show(q.get('screen')||'hosts');
"""
    script += NAV_SCRIPT
    options=''.join('<option value="'+key+'">'+E(value["label"])+'</option>' for key,value in STATES.items())
    proto='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabby Android · 设计提案</title><style>'+CSS+'</style><body><header class="prototype-header"><strong>Tabby Android · 可点击设计稿</strong><span>设计提案 / 非真实产品</span><select id="picker" aria-label="选择设计状态">'+options+'</select><a href="review.html">设计评审包</a></header><p class="prototype-note">离线虚构流程；不连接 SSH、不读取剪贴板、不请求权限、不保存凭据。尺寸为假设窗口，系统键盘和通知为示意。</p><main class="stage" id="stage"></main><p class="prototype-note" id="note"></p><script type="application/json" id="models">'+json.dumps(STATES,ensure_ascii=False).replace('</','<\\/')+'</script><script>'+script+'</script></body></html>'
    cover='<section class="page"><div class="kicker">TABBY ANDROID / DESIGN PROPOSAL / 2026.10.08</div><h1>让终端回到主角。<br>手机、折叠屏，接着工作。</h1><span class="pill">独立候选 · 不修改 Linux PR3</span><span class="pill">设计阶段 · 待评审</span><span class="pill">虚构主机 · 零真实凭据</span><p>当前原型基本运行，但状态栏、会话栏、工具与输入条叠加。首批方案把连接配置放回工作台，让登录后的终端尽量占据可用窗口；后台连接和密码保存有明确用户控制。</p><div class="callout">所有界面是设计提案，不是运行中的 Android 应用截图。字体、网格、键盘高度、折叠与后台行为仍需实施后测试。用户确认旧候选在 Find N6 基本运行，不等于本方案验收。</div><div class="flow">工作台 → 主机 / 可选本地密码 → 主机校验 → SSH / tmux列表 → 专注终端<br>终端 → 会话选择 / 更多 / 临时面板；网络失联 → 暂停输入 → 核对完整身份 → 有限恢复<br>后台开启 → 可见通知与停止；密码默认不保存 → Keystore本地加密 → 更新 / 删除</div><p>旧已验证候选：ded417ba852295f3ad76bcca4e6e557d1288ca12<br>候选分支：candidate/android-mobile-ux-20261008<br>完整来源、状态文案、约束与实施验收表在后半部分；离线点击稿见 prototype.html。</p></section>'
    pages=[cover]
    pages.append(page("structure","信息架构与布局骨架",'<p>连接前配置，连接后专注。一个状态行承载身份与会话入口；工具按需出现，不在终端重复整个导航结构。</p><div class="wire"><div class="wirebox"><span>连接工作台</span><span>活动 / 待恢复会话</span><span class="grow">本地主机列表</span><span>＋ 新连接</span></div><div class="wirebox"><span>会话身份 / 状态 · 48dp</span><span class="grow">终端网格<br>真实字体、真实 PTY</span></div><div class="wirebox"><span>会话身份 / 状态 · 48dp</span><span class="grow">终端网格</span><span>单行快捷键 · 48dp</span><span>系统 IME</span></div><div class="wirebox"><span>终端保持可见</span><span class="grow">按需底部面板<br>安全确认 / 会话 / 字号</span></div></div><div class="callout">系统返回依次关闭临时面板、退出选择、收起键盘、返回工作台；不会发送 Esc，也不会默认断开。只读、鼠标、失联与安全失败保留文字标识。</div><p>首批不加入云同步、分屏广播、SFTP 或 AI 工具栏；独立保留主机、密码条目、已验证主机密钥与完整 tmux 身份。</p>'))
    pages.append(page("first","首次连接：默认不保存密码",gallery([("hosts","活动会话和本地主机分开；一只手从下方进入新连接。"),("connect","保存配置与保存密码是两个选项。连接与校验失败不写密码。"),("trust","主机校验先于认证；指纹不匹配立即停止。")]) ))
    pages.append(page("focus","登录后：屏幕属于终端",gallery([("terminal","关闭键盘，不常驻辅助键。Home与标题切换区分开。"),("terminal-ime","09编号保留。上方薄荷边界快捷栏归Tabby；demo/工作/输入法是系统IME候选示意。"),("more","字号、选择、粘贴、后台与断开集中到按需面板。")])+'<p>16sp / cell9.6×20.8dp均为估算。360×800、IME300：终端404dp，占扣IME后窗口80.8%，约35×18。键盘区域皮肤与候选由用户输入法决定，图中标签是设计注释。</p>'))
    pages.append(page("tmux","会话安全：共享、只读、显式接管",gallery([("tmux","保留 socket、会话列表和直接 SSH 路径。"),("occupied","检测到占用暂停恢复；用户选共享、只读或接管。"),("takeover","接管影响其他客户端，单独二次确认。")]) ))
    pages.append(page("fold","展开后：字号保持，空间增加",'<div class="gallery"><div><div class="wideframe">'+STATES["fold"]["html"]+'</div><p>840×900假设窗口；默认不强加侧栏。</p></div><div style="max-width:235px"><h3>窗口驱动布局</h3><p>用实际安全窗口和铰链区域，不用设备名称或面板像素猜密度。</p><p>展开、旋转不创建第二个会话，不重发命令。每次重新量字体、fit与发送PTY尺寸。</p><p>会话面板只在用户展开时占240dp；折回自动收起面板。</p><p>UI大字、CJK/emoji、IME焦点、选择快照与光标位置须独立验收。</p><a href="prototype.html?screen=fold-panel">点击稿：展开会话面板</a></div></div>'))
    pages.append(page("fold-ime","展开与横屏：不要强塞80列",'<div class="gallery"><div><div class="wideframe">'+STATES["fold-ime"]["html"]+'</div><p>展开IME320：终端484dp，约85×22。</p></div><div style="max-width:240px"><h3>短窗口有另一套预算</h3><p>横屏800×360、IME180：默认收起快捷条；终端132dp，约81×5。</p><p>通过旋转、展开或主动调字号增加列数；不自动缩到无法阅读。</p><p>UI使用sp；Android14+非线性转换交给原生TypedValue。控制目标保持≥48dp。</p><p>安全的真实textarea与中文composition优先。若局部输入器未通过测试，暂留48dp输入条，手机终端降到356dp、35×16。</p></div></div>'))
    pages.append(page("touch","触控：选择与粘贴都有明确边界",gallery([("selection","冻结解析文本与系统选择柄；不从canvas像素猜字符。"),("paste","多行先确认目标与文本；粘贴只由用户点击触发。"),("mouse","显式鼠标模式，持续标记；默认本地历史滚动。")]) ))
    pages.append(page("recovery","断线保留画面，但停止输入",gallery([("offline","本地画面有明确断线标识，不误当实时状态。"),("missing","完整身份不存在或已替换时停止，不自动新建。"),("changed","密钥变化无忽略入口；尚未发送认证凭据。")]) ))
    pages.append(page("vault","密码：选择保存，也能更新与删除",gallery([("credentials","本地Keystore保护；网页不回填保存密码。"),("update-failed","新密码认证或写入失败，旧条目原子保留。"),("delete-password","删除取消同目标的待认证与自动恢复；当前连接可继续。")]) ))
    pages.append(page("background","后台：可见、可停止、有限恢复",gallery([("background","默认关闭，前台主动启用。不修改省电或手机安全设置。"),("notification","通用通知提供返回和停止；锁屏不泄露目标。"),("stopped","用户停止清除重连意图；不自动复活，也不杀远端tmux。")]) ))
    pages.append(page("stages","从评审到可验证功能候选",'<table><tr><th>阶段</th><th>交付</th><th>退出条件</th></tr><tr><td>D · 本次</td><td>来源、流程、骨架、高保真、点击稿、面积预算、安全与验收矩阵</td><td>关键设计可审阅；所有图明确标注提案；不把浏览器稿当产品截图</td></tr><tr><td>A · 原生基础</td><td>服务拥有SSH连接；通知停止、epoch取消、网络恢复；Keystore存储</td><td>模拟凭据 / 本地隔离fixture验证前后台、队列边界、更新删除与安全失败</td></tr><tr><td>B · 第一批交互</td><td>工作台 / 专注状态行、按需面板、字号、触控与输入器安全降级</td><td>保留已有SSH/tmux语义、主机校验、IME输入租约及所有错误路径</td></tr><tr><td>C · 交付验收</td><td>精确SHA CI、API31–37手机/平板矩阵、ARM64 APK、真实Android截图</td><td>不引用旧207项作为新功能证据；ARM64真机交互由用户另验，不自动安装</td></tr></table><div class="callout">后台服务候选类型 specialUse 是工程推断，须按官方规范说明用途；不能承诺通过应用商店审核。系统杀进程不会持续SSH；远端tmux保留进程也不保证补全失联期间全部输出。</div><p>本次提交仅设计文档与检查，不构建改进版APK。旧已验证PR2与Linux PR3保留；候选不合并、不发布。</p>'))
    pages.insert(4,review_pages(page,gallery,STATES))
    review='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabby Android · 设计评审包</title><style>'+CSS+'</style><body><main class="review">'+''.join(pages)+'<article class="details">'+markdown((ROOT/"README.md").read_text())+'</article></main></body></html>'
    (ROOT/"prototype.html").write_text(proto)
    (ROOT/"review.html").write_text(review)
    (ROOT/"states.json").write_text(json.dumps({k:{"label":v["label"],"note":v["note"]} for k,v in STATES.items()},ensure_ascii=False,indent=2)+"\n")
    print(f"Built {len(STATES)} fictional design states; no app changes.")

if __name__ == "__main__":
    build()
