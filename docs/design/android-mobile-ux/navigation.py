"""Navigation and key-bar proposal only. No SSH, Android or credential operations."""
import json

CSS = """
.nav-root{display:flex;flex-direction:column;flex:1;min-height:0;position:relative}
.nav-root [hidden]{display:none!important}.nav-root .home{flex:0 0 48px;font-size:23px}
.nav-title{touch-action:pan-y}.nav-title .title-line{display:block;font-size:14px;color:#e7edf3;margin:0}
.nav-title .title-meta{font-size:11px;color:#acbbc7}.nav-title .arrows{display:inline;color:#acbbc7;font-size:12px}
.nav-tabs{display:flex;overflow-x:auto;flex:1;min-width:0;touch-action:pan-y;scrollbar-width:none}
.status .nav-tabs button{flex:0 0 176px;text-align:left;border-bottom:3px solid transparent;padding:4px 12px;font-size:14px}
.nav-tabs button span{display:block;font-size:11px;color:#acbbc7;margin-top:3px}
.nav-tabs button[aria-selected=true]{border-bottom-color:#74e4c8;background:#253342}
.wide-context{flex:0 0 160px;padding:0 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wide-context span{display:block;font-size:11px;color:#acbbc7;margin-top:4px}.nav-terminal{overflow:auto;overscroll-behavior:contain}
.quickkeys{height:48px;min-height:48px;display:flex;background:#19232e;box-shadow:inset 0 2px #74e4c8;position:relative}
.key-viewport{display:flex;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;touch-action:pan-y}
.quickkeys button{height:48px;min-width:48px;flex:0 0 56px;background:transparent;color:#e7edf3;border-right:1px solid #30404e;font-size:14px}
.quickkeys .all-keys{flex:0 0 64px;font-size:13px;background:#253342;z-index:1}.key-viewport .group-end{margin-right:12px}
.key-fade{position:absolute;right:64px;top:0;width:22px;height:46px;pointer-events:none;background:linear-gradient(90deg,transparent,#19232e);text-align:right;line-height:46px;color:#74e4c8}
.quickkeys .modifier{flex:0 0 64px;background:#74e4c8;color:#111820;font-size:12px;line-height:1.25}
.quickkeys button:disabled,.key-grid button:disabled{color:#627788}.key-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.key-grid button{min-height:48px;min-width:48px;background:#253342;color:#e7edf3;border:1px solid #465967;border-radius:6px}
.nav-feedback{position:absolute;left:8px;right:8px;bottom:8px;background:#253342;color:#e7edf3;padding:10px;font-size:12px;border-radius:8px;pointer-events:none}
.status{border-bottom:0;box-shadow:inset 0 -1px #30404e}
.ime{border-top:2px dashed #7795ab}.suggest:before{content:"IME候选示意";font-size:10px;color:#acbbc7;align-self:center}
.ime-note{font-size:11px}.keyboard-boundary{color:#246e60;font-weight:600}
"""

KEYS = ["Esc","Tab","Ctrl","Alt","←","↑","↓","→","Home","End","PgUp","PgDn","Del","Ins"]
SESSIONS = [("logs","只读"),("work","已连接"),("jobs","已断线")]

def heading(index=1, wide=False):
    home='<button class="home" data-screen="navigation-home" aria-label="回到连接与会话">⌂</button>'
    if wide:
        tabs=''.join(f'<button role="tab" data-nav-session="{i}" aria-selected="{str(i==index).lower()}" aria-label="{n}，demo@lab.example，{s}，第{i+1}项，共3项">{n}<span>{s}</span></button>' for i,(n,s) in enumerate(SESSIONS))
        middle='<div class="wide-context">demo@lab.example<span data-current-summary>work · 已连接</span></div><div class="nav-tabs" role="tablist" aria-label="终端会话">'+tabs+'</div><button data-screen="navigation-sessions" aria-label="全部会话，3项">3 ▾</button>'
    else:
        n,s=SESSIONS[index]
        middle=f'<button class="identity nav-title" data-screen="navigation-sessions" aria-label="当前{n}，第{index+1}项，共3项；点击查看全部，左右拖标题切换"><span class="title-line"><span class="arrows" aria-hidden="true">‹ </span><b data-current-name>{n}</b> <small data-current-position>{index+1}/3</small> <span class="arrows" aria-hidden="true"> › ▾</span></span><span class="title-meta" data-current-summary>demo@lab.example · {s}</span></button>'
    return '<div class="status">'+home+middle+'<button data-screen="navigation-ime" aria-label="显示键盘">⌨</button><button data-screen="more" aria-label="更多终端操作">•••</button></div>'

def keybar(locked=False, writable=True):
    chip='<button class="modifier" data-clear-modifier aria-label="Ctrl已锁定，点击解除">Ctrl<br>锁定 ×</button>' if locked else ""
    keys=''.join(f'<button data-nav-key="{k}"{"" if writable else " disabled"} class="{"group-end" if k in ("Alt","→") else ""}" aria-label="终端{k}键">{k}</button>' for k in KEYS)
    return '<div class="quickkeys" role="toolbar" aria-label="Tabby终端快捷键栏">'+chip+'<div class="key-viewport">'+keys+'</div><span class="key-fade" aria-hidden="true">›</span><button class="all-keys" data-screen="navigation-all-keys">全部键</button></div>'

def install(add, button, terminal, ime, sheet, short):
    def screen(index=1, keyboard=False, wide=False, locked=False, sidebar=False):
        n,s=SESSIONS[index]
        description="本地画面保留。\n输入已关闭；不自动重连。" if index==2 else "只读连接。\n可回看、选择与复制。"
        text=short if index==1 else f'<span class="dim">{n} · demo@lab.example</span>\n\n{description}'
        area='<div class="terminal nav-terminal"><pre>'+text+'</pre><div class="nav-feedback" role="status" hidden></div></div>'
        if sidebar:
            rows=''.join(f'<button class="host" data-nav-open="{i}">{name}<span>{state}</span></button>' for i,(name,state) in enumerate(SESSIONS))
            area='<div class="split"><aside class="sidebar" aria-label="可选会话面板"><h2>会话</h2>'+rows+button("收起面板","fold","action secondary")+'</aside>'+area+'</div>'
        return f'<section class="nav-root" data-nav-index="{index}" data-nav-wide="{int(wide)}" data-nav-ime="{int(keyboard)}" data-nav-locked="{int(locked)}">'+heading(index,wide)+area+(keybar(locked,index==1)+ime() if keyboard else "")+'</section>'
    # Replace primary proposal screens; retain 08/09/14/15 identifiers.
    add("terminal","08 · 专注终端 · 键盘关",screen(),note="本轮提案：Home独立；标题1/3位置与点击列表；滑标题才切会话。")
    add("terminal-ime","09 · 专注终端 · 键盘开",screen(keyboard=True),note="09保留：薄荷边界上方是Tabby快捷键；demo/工作/输入法属于系统IME候选示意。")
    add("fold","14 · 展开 · 专注终端",screen(wide=True),"wide",note="同一48dp顶栏显示Tab；Tab拖动只滚动，点击选中；当前身份摘要固定可见。")
    add("fold-ime","15 · 展开 · 键盘开",screen(keyboard=True,wide=True),"wide",note="同一行显示更多快捷键，不加第二行。系统IME独立于Tabby。")
    add("fold-panel","16 · 展开 · 可选会话面板",screen(wide=True,sidebar=True),"wide",note="Home与同栏Tab保留；用户主动面板占240dp，不靠缩字号补列数。")
    add("landscape","17 · 横屏短窗口",'<section class="nav-root" data-nav-index="1" data-nav-wide="0" data-nav-ime="1" data-nav-locked="0">'+heading()+'<div class="terminal nav-terminal"><pre>'+short+'</pre><div class="nav-feedback" role="status" hidden></div></div>'+ime()+'</section>',"landscape",note="短窗口使用标题选择器与Home；默认折叠快捷条。800×360、IME180是假设，终端132dp预算。")
    for key,label,index,keyboard,locked in [
        ("navigation-phone","40 · 窄屏会话导航",1,False,False),
        ("navigation-ime","41 · 标题与键栏各自横滑",1,True,False),
        ("navigation-first","42 · 首项 · 只读",0,False,False),
        ("navigation-last","43 · 末项 · 已断线",2,False,False),
        ("navigation-locked","44 · Ctrl锁定可见",1,True,True),
    ]:
        add(key,label,screen(index,keyboard,locked=locked),note="浏览器手势模拟：没有远端输入；门槛为设计候选，原生验收未完成。")
    add("navigation-wide","45 · 宽屏同栏Tab",screen(wide=True),"wide")
    rows=''.join(f'<button class="host" data-nav-open="{i}"><strong>{n} · {s}</strong><span>demo@lab.example · 第{i+1}/3项</span></button>' for i,(n,s) in enumerate(SESSIONS))
    add("navigation-sessions","46 · 全部会话",sheet("会话 · 3 / 4",rows+button("管理会话","navigation-manage","action secondary")+button("返回终端","navigation-phone","action quiet")))
    add("navigation-home","47 · Home回连接与会话",'<div class="status"><button class="home" data-screen="navigation-home" aria-label="连接与会话主页">⌂</button><button class="identity" data-screen="navigation-sessions">连接与会话<span>3个会话 · 连接仍在保持</span></button><button data-screen="navigation-manage" aria-label="管理会话">•••</button></div>'+'<div class="body"><h1>连接与会话</h1><p>连接仍在运行。Home只导航，不断开。<br>打开原终端，恢复原视口。</p>'+rows+button("＋ 添加主机 / 新连接","connect")+button("管理会话","navigation-manage","action secondary")+'</div>')
    add("navigation-manage","48 · 独立管理入口",sheet("管理会话",'<p>切换、关闭与重排分开。标题不带小关闭叉；普通长按不改变顺序。</p><div class="card">work · 已连接'+button("移动到前一项（示意）","navigation-manage","action secondary")+button("移动到后一项（示意）","navigation-manage","action secondary")+button("断开并关闭…","disconnect","action secondary")+'</div>'+button("完成","navigation-sessions")))
    grid=''.join(f'<button data-nav-key="{k}" aria-label="终端{k}键">{k}</button>' for k in KEYS+["F1","F2","F3","F4"])
    add("navigation-all-keys","49 · 全部键与修饰键",sheet("全部终端键",'<p>Tab与Home是远端键，不是应用导航。滑动不发键；仅当前已连接可写会话可点击发送。</p><div class="key-grid">'+grid+'</div><h2>修饰键</h2><p>默认单次。锁定仅属于当前会话，切换/Home/失联时清除。</p><button class="action secondary" data-lock-modifier="Ctrl">锁定Ctrl（示意）</button><button class="action secondary" data-lock-modifier="Alt">锁定Alt（示意）</button>'+button("完成","navigation-ime")))
    add("key-generate","50 · 用户允许生成密钥",sheet("为此设备创建SSH密钥",'<p>仅用户主动允许后生成。此设计稿不会生成密钥。</p><div class="card">名称：此设备 · 实验环境<br>候选：Ed25519（软件生成）<br><span class="small">以Keystore AES密钥包裹本地加密保存，不能称Ed25519硬件不可导出。算法兼容性仍须实测。</span></div><p>无云同步、默认不导出私钥。导出/备份与删除有独立说明和确认。</p>'+button("示意：允许生成并查看安装目标","key-install")+button("取消","credentials","action secondary")))
    add("key-install","51 · 确认安装公钥",sheet("将公钥加入此账号？",'<div class="card">demo@lab.example:22<br>已核对主机：FICTITIOUS-HOST<br>公钥：Ed25519 · FICTITIOUS-PUBLIC<br><span class="small">虚构指纹，不能用于真实核对</span></div><p>只追加公钥，保留已有授权与限制。同一key已存在时不重复加无限制条目。不是每次密码登录自动执行。</p>'+button("确认此目标，示意安装并验证","key-verified")+button("取消，不更改服务器","credentials","action secondary")))
    add("key-verified","52 · 新连接验证结果",sheet("密钥登录已验证（示意）",'<p>新独立连接只用该公钥认证成功，才更新此状态；原密码连接保留。</p><div class="card">demo@lab.example · 此设备密钥<br><span class="small">只对已确认的这一目标有效</span></div><p>失败/超时不移除密码方式。结果不确定时不自动删密钥；回滚只针对可证明本次新增的精确条目并再次确认。</p>'+button("返回当前终端","navigation-phone")+button("查看本地密钥设置（示意）","credentials","action secondary")))

    add("key-import","53 · 现有私钥导入能力",sheet("使用私钥文件",'<p>ded417ba原型已支持普通/加密OpenSSH私钥，通过系统文件选择器临时导入内存。</p><div class="card">文件：design-key（虚构，无实际文件）<br>口令：••••••••（示意）</div><p>已有导入能力不等于Keystore持久保存或SSH agent。恢复需重新导入；现有fixture确认普通/加密Ed25519。</p>'+button("示意：核对主机并连接","trust")+button("返回连接表单","connect","action secondary")))
    add("key-settings","54 · 本地SSH密钥管理",sheet("此设备的SSH密钥",'<div class="card">此设备 · 实验环境 · demo<br>Ed25519 · FICTITIOUS-PUBLIC<br><span class="small">仅关联 lab.example:22 / demo · 已验证（虚构）</span></div><p>默认逐主机/账号独立密钥。共用密钥需逐目标确认，不能批量自动安装。</p>'+button("创建设备密钥…","key-generate")+button("导出私钥说明…","key-export","action secondary")+button("删除本地密钥…","key-delete","action secondary")+button("返回本地凭据","credentials","action quiet")))
    add("key-delete","55 · 删除本地密钥",sheet("删除此设备的密钥？",'<p>删除本地加密私钥与内存认证/重连意图。不会自动删除服务器上的公钥，远端撤销需要逐目标另行确认。</p><div class="card">关联：lab.example:22 / demo<br><span class="small">保留密码或管理员备用访问；当前SSH不会自动断开。</span></div>'+button("确认删除本地副本（示意）","credentials","action danger")+button("取消","key-settings","action secondary")))
    add("key-export","56 · 私钥导出风险",sheet("私钥导出是独立操作",'<p>默认不导出、不云同步。公钥可提供管理员安装；私钥副本会扩大凭据暴露范围。</p><p>候选方案：用户明确确认后导出口令保护的OpenSSH文件。Keystore密文仅此设备能解密，不能当跨设备备份。</p><p>重装或丢失Keystore密钥可能使本地私钥不可用，需保留备用访问。导出能力是否进入首批仍待决定。</p>'+button("返回密钥设置","key-settings")+button("取消","credentials","action secondary")))
    add("key-restricted","57 · 安装受限或无法验证",sheet("未确认安装成功",'<p>目标账号无权限写入，或公钥策略/文件路径不符合安全检查。没有sudo、覆盖已有文件或放宽权限。</p><p>密码登录仍保留。超时结果可能不确定；先核实，不自动删除已有公钥或本地密钥。</p>'+button("返回当前终端","navigation-phone")+button("查看密钥状态","key-settings","action secondary")))
    add("key-generation-failed","58 · 安全保存失败",sheet("密钥未创建完成",'<p>Keystore或加密存储不可用。没有以明文保存或上传临时私钥，也没有更改任何服务器授权。</p><p>原密码/已导入密钥登录方式保持可用。</p>'+button("返回本地凭据","credentials")+button("再次查看创建说明","key-generate","action secondary")))

SCRIPT = """
// Fictional interactions only; no transport or credentials exist in this document.
const nav={index:1,views:{},offsets:{},modifier:{},intent:false,last:'navigation-phone',pending:null};
window.designKeyLog=[];window.designNavigation=nav;
function navSave(){const root=stage.querySelector('.nav-root');if(!root)return;const t=root.querySelector('.nav-terminal'),k=root.querySelector('.key-viewport');if(t)nav.views[nav.index]=t.scrollTop;if(k)nav.offsets[nav.index]=k.scrollLeft;}
window.navigationBeforeLeave=()=>{navSave();if(window.cancelNavGesture)window.cancelNavGesture();};
const navNames=['logs','work','jobs'],navStates=['只读','已连接','已断线'];
function navFeedback(text){const f=stage.querySelector('.nav-feedback');if(f){f.hidden=false;f.textContent=text;}document.getElementById('note').textContent=text+' · 设计示意，未发送远端输入。';}
function navPaint(){
 const root=stage.querySelector('.nav-root');if(!root)return;
 root.dataset.activeIndex=nav.index;
 const n=root.querySelector('[data-current-name]'),p=root.querySelector('[data-current-position]'),s=root.querySelector('[data-current-summary]');
 if(n)n.textContent=navNames[nav.index];if(p)p.textContent=(nav.index+1)+'/3';
 if(s)s.textContent='demo@lab.example · '+navStates[nav.index];
 root.querySelectorAll('[data-nav-session]').forEach(b=>b.setAttribute('aria-selected',String(+b.dataset.navSession===nav.index)));
 const t=root.querySelector('.nav-terminal');if(t){
  const pre=t.querySelector('pre');
  pre.textContent=navNames[nav.index]+' · demo@lab.example\\n'+navStates[nav.index]+' · 虚构终端\\n\\n'+Array.from({length:36},(_,i)=>(i+1)+': '+(nav.index===1?'project / check / output':'保留的终端画面')).join('\\n');
  t.scrollTop=nav.views[nav.index]||0;
 }
 const writable=nav.index===1;
 root.querySelectorAll('[aria-label="显示键盘"]').forEach(b=>b.disabled=!writable);
 root.querySelectorAll('.ime,.quickkeys').forEach(el=>el.hidden=!(nav.intent&&writable));
 root.querySelectorAll('[data-nav-key]').forEach(b=>b.disabled=!writable);
 root.querySelectorAll('[data-nav-key="Ctrl"],[data-nav-key="Alt"]').forEach(b=>b.setAttribute('aria-pressed',String(Boolean(nav.modifier[b.dataset.navKey]))));
 const k=root.querySelector('.key-viewport');if(k)k.scrollLeft=nav.offsets[nav.index]||0;
 root.querySelectorAll('[data-clear-modifier]').forEach(x=>x.remove());
 const bar=root.querySelector('.quickkeys');if(bar)for(const [key,mode] of Object.entries(nav.modifier)){
  const b=document.createElement('button');b.className='modifier';b.dataset.clearModifier=key;b.textContent=key+' '+(mode==='lock'?'锁定 ×':'单次 ×');b.setAttribute('aria-label',b.textContent+'，点击解除');bar.prepend(b);
 }
}
function navSelect(index){navSave();nav.modifier={};nav.index=index;navPaint();}
window.navigationMounted=function(name){
 const root=stage.querySelector('.nav-root');if(!root){if(name==='navigation-all-keys')stage.querySelectorAll('[data-nav-key],[data-lock-modifier]').forEach(b=>b.disabled=nav.index!==1);return;}
 nav.index=nav.pending===null?+root.dataset.navIndex:nav.pending;nav.pending=null;nav.intent=Boolean(+root.dataset.navIme);
 nav.modifier=+root.dataset.navLocked?{Ctrl:'lock'}:{};
 nav.last=name;navPaint();
};
let gesture=null,blockClick=false;
window.cancelNavGesture=()=>{gesture=null;blockClick=true;};
window.addEventListener('resize',window.cancelNavGesture);
window.addEventListener('blur',window.cancelNavGesture);
document.addEventListener('lostpointercapture',e=>{if(gesture&&gesture.id===e.pointerId)window.cancelNavGesture();});
document.addEventListener('pointerdown',e=>{
 const owner=e.target.closest('.nav-title,.key-viewport,.nav-tabs');
 if(!e.isPrimary){gesture=null;blockClick=true;return;}
 blockClick=false;if(!owner)return;
 gesture={owner,id:e.pointerId,x:e.clientX,y:e.clientY,dx:0,dy:0,moved:false,horizontal:false,cancelled:false,scroll:owner.scrollLeft};
 if(owner.classList.contains('nav-title'))owner.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove',e=>{
 if(!gesture||gesture.id!==e.pointerId)return;const g=gesture;
 g.dx=e.clientX-g.x;g.dy=e.clientY-g.y;
 if(Math.max(Math.abs(g.dx),Math.abs(g.dy))>8){g.moved=true;blockClick=true;}
 if(!g.horizontal&&Math.abs(g.dy)>8&&Math.abs(g.dy)>Math.abs(g.dx)/1.5)g.cancelled=true;
 if(g.cancelled)return;
 if(Math.abs(g.dx)>8&&Math.abs(g.dx)>=1.5*Math.abs(g.dy))g.horizontal=true;
 if(g.horizontal&&!g.owner.classList.contains('nav-title')){g.owner.setPointerCapture(e.pointerId);g.owner.scrollLeft=g.scroll-g.dx;}
});
document.addEventListener('pointercancel',()=>{gesture=null;blockClick=true;});
document.addEventListener('pointerup',e=>{
 if(!gesture||gesture.id!==e.pointerId)return;const g=gesture;gesture=null;
 if(g.owner.classList.contains('nav-title')&&g.horizontal&&!g.cancelled){
  if(Math.abs(g.dx)>=Math.max(48,g.owner.clientWidth*.2)){
   const next=nav.index+(g.dx<0?1:-1);
   if(next<0||next>2)navFeedback(next<0?'已到第一个会话':'已到最后一个会话');else navSelect(next);
  }else navFeedback('拖动不足，保留当前会话');
 }
});
document.addEventListener('click',e=>{
 if(blockClick&&e.target.closest('.nav-title,.key-viewport,.nav-tabs')){e.preventDefault();e.stopImmediatePropagation();return;}
 const open=e.target.closest('[data-nav-open]'),tab=e.target.closest('[data-nav-session]'),key=e.target.closest('[data-nav-key]'),lock=e.target.closest('[data-lock-modifier]'),clear=e.target.closest('[data-clear-modifier]');
 if(key||lock||clear)navSave();
 if(open){nav.pending=+open.dataset.navOpen;nav.modifier={};show(nav.last);e.stopImmediatePropagation();}
 if(tab)navSelect(+tab.dataset.navSession);
 if(clear){delete nav.modifier[clear.dataset.clearModifier||'Ctrl'];navPaint();}
 if(lock&&nav.index===1){nav.pending=nav.index;show('navigation-ime');nav.modifier[lock.dataset.lockModifier]='lock';navPaint();}
 if(key&&nav.index===1&&!key.disabled){
  const viewport=key.closest('.key-viewport');
  if(viewport){const a=key.getBoundingClientRect(),b=viewport.getBoundingClientRect();if(a.left<b.left-.5||a.right>b.right+.5)return;}
  const value=key.dataset.navKey;
  if(value==='Ctrl'||value==='Alt'){if(nav.modifier[value])delete nav.modifier[value];else nav.modifier[value]='once';navPaint();navFeedback(value+(nav.modifier[value]?'单次已选中':'已解除'));return;}
  window.designKeyLog.push({session:nav.index,key:value,modifiers:{...nav.modifier}});
  for(const [k,m]of Object.entries(nav.modifier))if(m==='once')delete nav.modifier[k];
  navPaint();navFeedback('示意选择终端键 '+value);
 }
 if(e.target.closest('.home')){navSave();nav.modifier={};gesture=null;}
},true);
window.navigationMounted(document.body.dataset.current);
"""

def review_pages(page, gallery, states):
    result=page("navigation","会话切换、Home与快捷键：各有自己的区域",
        gallery([("navigation-phone","左Home回主页不断开；只滑中央标题切会话，点击看列表。"),
                 ("navigation-ime","上方键栏归Tabby。下方候选词/键盘归系统IME，皮肤不由Tabby控制。"),
                 ("navigation-locked","Ctrl单次或锁定有文字反馈；锁定固定可见，切换/Home/断线清除。")])+
        '<p>每次只切一项，首尾不循环。键栏拖动仅滚动，完整按键点击才触发。所有图为设计提案，非Android截图。</p>')
    result+=page("navigation-wide","宽屏：同一行Tab，身份始终可见",
        '<div class="gallery"><div><div class="wideframe">'+states["navigation-wide"]["html"]+'</div><p>Tab拖动只滚动；点击才选中。不添第二条导航。</p></div><div style="max-width:240px"><h3>三种横向动作分开</h3><p>窄屏标题：切相邻会话。<br>宽屏Tab：找Tab，点击选择。<br>键盘快捷栏：找键，点击发送。</p><p>终端内容区不切会话。重排/关闭只在管理入口；断线项不自动重连。</p><p>原终端buffer与回看锚点保留；旧预编辑、修饰键与待确认粘贴取消。只读/断线不接受输入。</p><p>门槛、首次提示、锁定布局与密钥策略仍需真机调校/评审。</p></div></div>')
    result+=page("key-setup","设备生成密钥与公钥安装：每个目标明确确认",
        gallery([("key-generate","用户允许才生成；软件Ed25519以Keystore AES包裹，不夸大硬件不可导出。"),
                 ("key-install","密码认证与主机校验后，再确认host/port/account与公钥指纹，只追加公钥。"),
                 ("key-verified","新独立连接仅用公钥验证成功才更新状态；失败不移除密码方式或已有key。")]))
    return result
