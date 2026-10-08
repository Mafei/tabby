# Tabby Android 移动交互设计评审 · 2026-10-08

**状态：设计方案，等待关键流程与视觉评审；不是产品截图，也不是功能验收。**

先打开 [review.html](review.html) 看完整设计包，或下载后打开
[prototype.html](prototype.html) 试走流程。两者离线运行；不连接 SSH、不请求系统权限、
不保存输入。所有主机、用户名、终端内容均为虚构示例。

直接查看：[设计评审 PDF](preview/Tabby-Android-Design-Review.pdf)、
[终端与键盘图](preview/Tabby-Android-Terminal-Design.png)、
[折叠展开图](preview/Tabby-Android-Foldable-Design.png)。
这些是浏览器渲染的原创提案；系统键盘、通知、字号和网格均为示意，不是 Android 截图。
点击稿主要验证流程与面板；字号按钮、输入字段和系统选择柄是状态示意，尚不具备产品行为。

本阶段只改 `docs/design/android-mobile-ux/` 与独立设计检查工作流。
应用、原有 Android 工作流及 Linux 配色不变。后续功能候选仍须另行完成编译、
API31–37 模拟器矩阵、精确 SHA CI、ARM64 APK 与真实 Android 截图。

## 基线和证据

- 远端 `prototype/android-direct-ssh` 与 draft [PR2](https://github.com/Mafei/tabby/pull/2)
  当前 SHA：`ded417ba852295f3ad76bcca4e6e557d1288ca12`。
- 用户报告该 SHA 在 OPPO Find N6 / Android16 / API36 / ARM64 基本运行。
  这不代表折叠、中文 IME、触控、后台、安全存储或全部交互已经验收。
- PR2 的旧 CI 报告是九个 API31–37 手机/平板配置、207 项运行时用例通过。
  本设计不会将该旧证据归到新候选，也不会以浏览器渲染冒充 Android 执行。
- 独立候选：`candidate/android-mobile-ux-20261008`，从上述精确 SHA 建立独立 worktree。
  Linux draft PR3 的 `feature/linux-portable-rocky8-fonts` 不在本候选修改范围。
- 工作区 `.agents`、`.codex` 为空；基线树无 `AGENTS.md` / `.agents/skills`。
  已读 `HACKING.md`、PR 模板、`mobile/README.md`、`mobile/web/README.md`、
  原有测试与构建/交付约束。云端执行，不转用户 Mac，不操作真实手机或真实 SSH。

## 现状中需要解决的具体问题

连接表单其实已在登录后隐藏；问题不是把仍存在的表单再藏一次。
现有 `app.component.ts` 的会话栏、`session-pane.component.ts` 的顶栏、
辅助键、操作栏、输入条会叠加。顶栏同时放新增、复制、断开，既抢面积也易误触。
`styles.css` 常用目标为 44 CSS px；还不能据此声明 Android 48dp 合格。
终端固定 `14px monospace`，UI 根为 `15px`，没有显式终端字号设置、系统 sp 转换或双指缩放。
`MainActivity` 已有单一 insets 所有权与 viewport resize，应保留。

现有触控的可保留基础：点按聚焦；默认本地历史滚动；长按切换冻结的解析文本快照；
系统选择柄；显式鼠标模式；多行粘贴确认；独立、按代际替换的真实 textarea；
IME preedit 本地保留到提交。不要为了减少空间破坏这些输入与隔离保护。

后台不是 CSS 工作：原生 `handleOnPause()`、Web lifecycle 与 visibility 路径都会关闭连接；
后台停止输出 ACK 也会触发现有 1MiB 背压边界。仅删除关闭调用、给 WebView 加定时器或
加通知均不能交付可靠生命周期。连接所有权、输出订阅和 tmux 恢复需分阶段迁到原生服务。

## 来源与具体取舍

研究核实日期：2026-10-08。公开源码的 main/master 不是已发布 APK 验收；
公开截图只用于观察空间关系，不复制商标、代码或私有资产。来源索引与版本见
[sources.json](sources.json)。Termux Wiki 访问被拒，已改用第一方公开源码。

| 样本 | 可核实的优秀点 | 限制 | 我们的取舍 |
|---|---|---|---|
| Termux 终端与 ViewClient | 点按显示 IME、双指阶梯调字号；选择时抑制冲突；以字体指标计算网格 | 本地 Linux 环境不等同 SSH/tmux；其鼠标追踪/alternate-screen 滚动可以发远端键 | 采用可读字号、局部手势所有权；默认滚动只回看本地历史，不用长按发远端键 |
| ConnectBot 公开新版 HostList / Console | 主机与终端分离；主机状态有文字/图标；会话选择器、可收起工具、明确重连与断开 | 当前 main 为演进源码；自动隐藏顶栏和全屏截图可能隐藏目标身份 | 采用按需工具与单一会话入口；保留最小身份/状态条；不照搬全隐藏或默认音量键绑定 |
| Termius 官方 Mobile terminal / Workspaces | 终端专注模式、扩展键按需面板；可调字号；标准选择复制；按会话展示状态 | Mobile terminal 文档明确面向 iOS/iPadOS；长按方向、双击 Tab 与选择冲突；云同步/日志超出本任务 | 借鉴信息密度，不宣称 Android 已有同样行为；不采用隐形发送手势、AI栏、云凭据或会话日志 |
| Android 官方 adaptive / accessibility / input / FGS / Keystore | 窗口而非面板像素驱动；sp 与 48dp；IME/insets；用户控制通知和后台；不可导出密钥 | 文档不保证 OEM 杀进程、硬件安全等级、Play 审核或中文 IME 可用 | 保留现有安全边界，增加可测的平台接线与真实设备验收；不静默更改系统设置 |

具体链接：[Termux TerminalView](https://github.com/termux/termux-app/blob/master/terminal-view/src/main/java/com/termux/view/TerminalView.java)、
[Termux ViewClient](https://github.com/termux/termux-app/blob/master/app/src/main/java/com/termux/app/terminal/TermuxTerminalViewClient.java)、
[ConnectBot Console](https://github.com/connectbot/connectbot/blob/c961b2c36b17bafea5984397c821651b333e612c/app/src/main/java/org/connectbot/ui/screens/console/ConsoleScreen.kt)、
[ConnectBot HostList](https://github.com/connectbot/connectbot/blob/c961b2c36b17bafea5984397c821651b333e612c/app/src/main/java/org/connectbot/ui/screens/hostlist/HostListScreen.kt)、
[Termius Mobile terminal](https://docs.termius.com/terminal/mobile-terminal)、
[Termius Workspaces](https://docs.termius.com/terminal/workspaces)。

## 自己的信息架构与视觉语言

入口是「连接」工作台：已有主机、活动会话、待恢复会话；新用户直接看到「添加主机 / 快速连接」。
主机代表连接配置；凭据、已验证主机密钥、tmux 会话身份是三个独立对象。
保存主机不会自动保存密码。相同主机的不同账号有不同密码条目。
第一批支持简单本地列表；分组、跨端同步、SFTP、广播输入与多终端分屏暂不加入。

登录成功进入一个专注终端。单一 48dp 会话状态条显示 `会话名 · user@host`、连接/只读/鼠标等
必要状态，并提供键盘与更多入口；完整身份、端口、指纹在详情中可读。多个会话通过状态条或
键盘上的会话入口打开选择器；保留最多四个独立连接和完整 tmux 身份去重。
系统返回先关闭临时面板/选择，再收起 IME，再返回工作台，不发送 Esc，也不默认停止连接。
连接仍在后台时，工作台和通知均可停止。预测返回接线使用 Android 支持的回调。

视觉采用沉静的深灰蓝表面、浅色文字、少量薄荷绿操作提示。身份用单行高权重文字；
终端以内容为主，不重复大品牌标题。普通错误用琥珀色，主机校验失败用红色并带明确文字。
接管是危险动作，独立确认；成功、只读、未连接均有文字，不靠颜色。无竞品标志或装饰图片。

## 关键流程

1. 首次连接：新增/快速连接 → host/port/account/auth → 可选保存主机、默认关闭保存密码 →
   连接 → 首次指纹核对 → 认证 → 直接终端或 tmux 列表。拒绝信任/取消不得保存密码。
2. 密码使用：已保存条目显示「使用此设备保存的密码」，不回填 DOM；「本次改用其他密码」不覆盖旧条目。
   勾选「更新保存密码」后，只有该目标通过主机校验并认证成功才原子替换。
   删除后当前已认证 SSH 可以继续，但同目标内存重连密码清除、待认证/自动重连取消。
3. tmux：按所选 socket 列表 → 共享/只读明确选择 → 新建命名仍原子拒绝重名 → 登录终端。
   恢复核对 host/key/account/UID/socket/server/session 完整身份；不存在/替换即停止。
   有客户端时自动恢复暂停；共享、只读、接管为可选项，接管再确认，不自动选择。
4. 会话切换：打开选择器 → 点击目标 → 清除旧 composition/修饰键/鼠标手势与未确认粘贴 →
   激活目标输入租约 → 若用户原来打开键盘则恢复该目标键盘；不复制凭据或 attachment。
5. 后台：用户在前台开启「后台保持连接」 → 说明通知用途 → Android13+ 由用户决定通知权限 →
   用户明确启动服务 → Home/锁屏/展开保留连接能力 → 通知返回或停止全部连接。
6. 网络失联：即时禁止输入、保留本地画面且标「已断线」 → 有完整 tmux 身份/可用认证时有限重连 →
   等待网络/认证/主机校验/占用/身份失败有各自状态 → 返回 app 处理；普通 SSH 需手动重连新 shell。

## 字号、网格、屏幕和面积预算

几何用 dp；UI 文字初值 body16sp、label14sp、title20sp，随系统设置缩放。
终端单独初值16sp，用户范围12–26sp，1sp步进、恢复默认、显示实时列×行；不按窗口宽度自动缩小。
12sp只供用户主动选择，默认仍16sp。双指缩放更改字体与 PTY 网格，不对整屏做 CSS transform。
Android14+ 非线性 sp 转换用 `TypedValue.applyDimension`，不简单乘 `fontScale`；WebView CSS px 与 dp
按实际 viewport/density 校准，文字 px 从原生转换后再除 density。控制尺寸不随 sp 缩小。

Find N6 官方内屏2480×2248、外屏2616×1140是面板像素；不能由 PPI 推导 ColorOS 实际逻辑密度或 app窗口。
下面是假设的**设计窗口**，已排除系统栏/切口，IME高度另列；不声称是 Find N6 实测。
正式验收记录 density、fontScale、原生window/WebView/visualViewport与可见IME/insets，仅数值、不含终端文本。

计算：`cols=floor((W−水平padding−已固定面板)/实测cellW)`，
`rows=floor((H−IME−状态条−常驻快捷键−垂直padding)/实测cellH)`。
这里只用16sp、单元9.6×20.8dp、padding每边8dp作估算；xterm真实指标和 `stty size` 才是验收值。

| 设计窗口 | IME / 快捷条 | 终端矩形高度 | 占扣IME后app高度 | 占完整安全窗口 | 估算列×行 |
|---|---|---:|---:|---:|---:|
| 窄屏360×800，键盘关 | 0 / 0 | 752 | 94.0% | 94.0% | 35×35 |
| 窄屏360×800，键盘开 | 300 / 48 | 404 | 80.8% | 50.5% | 35×18 |
| 同窗口，隐藏快捷条 | 300 / 0 | 452 | 90.4% | 56.5% | 35×20 |
| 同窗口，暂保留输入条 | 300 / 48，加48输入 | 356 | 71.2% | 44.5% | 35×16 |
| 展开840×900，键盘关 | 0 / 0 | 852 | 94.7% | 94.7% | 85×40 |
| 展开840×900，键盘开 | 320 / 48 | 484 | 83.4% | 53.8% | 85×22 |
| 横屏800×360，键盘开 | 180 / 0 | 132 | 73.3% | 36.7% | 81×5 |

不要强塞80列。窄屏按真实网格向PTY报告35列，用户可旋转、展开或主动调字号。
终端UI不重排远端TUI；普通文本由终端/远端按终端宽度处理。默认不增加水平虚拟80列。
UI字号放大到200%时状态条允许增高、面板滚动；不裁掉主机或危险状态以维持表中比例。
此时重新测量，表中48dp高度只适用于默认字号。

键盘开时默认一行快捷键（Esc/Ctrl/Tab/方向/会话/更多），各≥48dp。
方向打开四向面板；可选择把常用方向键固定在可横滚的一行里，不能缩小按钮。
短窗口不足240dp时默认收起快捷条，从状态更多访问；没有键盘时不常驻快捷条。
普通SSH输入默认保留真实textarea；期望将常驻输入条变为光标附近的局部composition编辑器，
但必须先通过实际可见编辑节点、原生焦点/租约与中文IME测试。失败时暂留48dp输入条并报告面积差距，
不得放宽原有输入安全门。高保真图展示期望方案，未宣称该输入改造已通过。

字体fallback以等宽Latin为主、CJK/emoji为系统fallback。字体加载完成后量cellW/cellH再fit。
CJK宽字符、组合音标、emoji/ZWJ/variation selector由xterm的Unicode宽度提供者处理；
需与远端wcwidth/locale核对，不能用JS字符串长度定位光标。cursorX/Y来自终端buffer，
选择快照使用解析文本，重连/换字体/折叠后重新测量。首批不引入未经验证的自定义字体。

## 触控规则和误触防护

优先级：系统返回/IME与系统选择柄 → 安全模态 → 本地选择 → 双指缩放 → 显式鼠标模式 → 本地滚动 → 点击聚焦。
手势所有者一旦确定，其他路径不接收同一串事件；pointercancel、tab变更、背景、重连均释放。
跨到第二根手指时取消长按和远端mouse gesture；在远端鼠标模式中，首批禁用双指缩放并提供字号按钮，
避免第一根手指已发送点击后误称整个双指手势无远端输入。

| 状态/动作 | 行为与可发现入口 | 不允许的副作用 |
|---|---|---|
| 点按终端 | 已连接且可写时聚焦当前真实editor；显示IME。只读可选择输出 | 不发送Tab/Enter/鼠标点击；不在断线时缓存按键 |
| 单指纵滑 | 默认本地历史；回看出现「回到实时输出」≥48dp浮动入口 | 不把滑动变成箭头，不随新输出强拉回底部 |
| 长按 | 约500ms且移动不超过系统touch slop后打开冻结文本快照；再用系统选择柄 | 不发送远端键；首批仍需两次长按完成系统选词，不冒充直接canvas选择 |
| 快照选择/拖柄 | 标「选择快照 · 实时输出继续接收」；系统菜单复制；退出回实时 | 不因实时输出移动已选文字；不直接交互TUI；不复制未选择的整屏 |
| 粘贴 | 用户触发才读取剪贴板；目标身份+行数确认；多行/CR/控制内容显式确认，取消零字节 | 不自动读/执行；保持bracketed paste、ESC清理、128KiB上限、32KiB字节分块与代际校验 |
| Ctrl/Esc/Tab/方向 | Ctrl单次、可见状态；方向沿用application cursor mode；composition时先完成/取消 | 不在切Tab后沿用Ctrl；Tab辅助键是远端补全键，不切会话 |
| 切换应用会话 | 状态条/快捷条会话入口；外接Ctrl+Shift+Tab与Ctrl+Shift+PageUp/Down可配置 | 不占用普通Tab/Ctrl+Tab；不默认横滑切会话以免与选择/TUI/系统边缘冲突 |
| 鼠标模式 | 用户显式开启且远端报告支持时，「鼠标」状态常可见；切回本地滚动/选择先取消mouse所有权 | 只读/断线/模态禁发；本地选择不得向PTY发mouse序列 |
| 大小/折叠/IME变化 | 重新量布局、fit、唯一resize；保持服务连接和session身份，取消未提交composition | 不把旧光标坐标用于新网格；不重复扣IME；不在隐藏pane fit成2×1 |

双指缩放还提供可访问的A−/A+按钮；滑动、长按均有可点按替代入口。
按钮、选择器行、checkbox整行、关闭面板均至少48dp，危险动作和常用键不相邻。
TalkBack可读主机、会话、只读、失败状态和修饰键；输出阅读用冻结文本模式，
不让持续输出反复抢播。焦点按面板内顺序移动，关闭返回触发入口；外接键盘Tab导航与终端Tab
由当前焦点区域区分。小字文字目标对比≥4.5:1，装饰图标不重复朗读。

## 后台、安全和状态文案

第一批后台目标是「本次用户启动的SSH会话尽量保持」。建议独立原生service拥有transport/generation/worker，
Activity/plugin只订阅、发送带owner+generation的用户动作。后台不依赖WebView timer。
已验证连接可在后台继续；首次信任、密码提示、键盘交互、接管都暂停到前台。
启动时核实app可见并及时进入foreground，失败清理资源且UI显示「后台保持未开启，连接仅在前台使用」。

前台服务类型选择 `specialUse` 并写明用户发起的交互式SSH持续会话；这是对官方类型定义的工程判断，
尚不是Play批准。SSH不冒充聊天、媒体或三分钟任务；不以新增CHANGE_NETWORK_STATE权限凑类型。
Android15+ dataSync有六小时后台上限，不用于伪装无限终端。
通知默认隐去锁屏主机/账户细节，显示「Tabby · 2个连接」「返回」「停止全部连接」。
本产品选择可见通知作为后台开关的前提；Android13拒绝通知并非系统禁止FGS，文案必须区分这个产品选择。
权限仅在用户开启时请求，拒绝后提供前台模式；不改省电、安全、ADB授权或持久文件权限。

服务 `START_NOT_STICKY`，无boot receiver/自动重启/周期任务。通知停止立即增加epoch、取消重连、
关闭所有transport、清除内存凭据/输出并stopSelf；tmux服务器上的会话不被kill。
系统Active apps停止整个进程可能无回调；重新打开只显示可恢复入口，不自动连接。
划掉任务与配置重建分别测试；后台开关开时任务划除可保留服务，关闭时清理。
锁屏/Doze/OEM可能暂停网络或终止进程，没有永久wake lock或不断线承诺。

原生输出只保留有界内存序列队列，延续1MiB背压；前台按parse→ACK确认。
后台高输出填满队列时明确关闭并标「输出积压，等待返回后恢复」，不丢原始VT字节、不写日志文件；
tmux可在返回后新PTY显示远端当前画面，但缺失的本地历史不能假装完整。
自动恢复有限退避（1/2/4/8/16/30秒，最多6次约1分钟，网络离线时等待并设总期限），用户可随时停止。
初始建议整个恢复窗口不超过120秒，离线等待也计入；后续实现需单调时钟和可控时钟测试证明期限。
网络回调只是信号，不当作SSH成功；恢复再核对完整身份，不重放命令、create或takeover。
后台若需安全确认/认证立即暂停，通知「需要返回应用处理」。普通SSH断线仅手动重连，提示新shell。

密码默认不保存，仅支持此设备。原生Keystore AES-256-GCM、随机nonce、版本化封装，
AAD绑定规范host+port+case-sensitive account+已验证主机公钥摘要；密文存 `noBackupFilesDir`，
结合已有allowBackup=false和明确cloud/device-transfer排除规则。
Keystore不可用、密钥丢失、篡改、写失败均禁止明文降级，原子更新失败保留旧密文。
alias不含用户名；秘密不进入localStorage、saved tmux身份、Intent extras、日志、崩溃报告、Git或artifact。
保存条目在native内解密并响应认证，不把已有密码回传DOM；真正保存发生在对应host校验和认证成功之后。
当前输入不可避免暂经Web表单/JVM/Rust内存，清零仅best effort，不宣称无复制或flash安全擦除。
第一批不要求生物认证密钥以免自动恢复不可用；不声称所有设备为StrongBox。

| 状态 | 最小常可见文案 | 下一步 |
|---|---|---|
| 已连接 | `work · demo@lab.example · 已连接` | 点击身份详情/会话切换 |
| 只读 | `work · 只读` + host身份 | 输入/粘贴/鼠标禁用，仍可复制 |
| 回看/选择 | `回看历史` / `选择快照` | 回到实时输出/结束选择 |
| 失联重试 | `已断线 · 8秒后重连`，旧输出保留 | 停止重连/详情；输入禁用 |
| 无网 | `等待网络 · 已断线` | 有限等待或停止，不排队输入 |
| 主机密钥变化 | `主机密钥已变化 · 已拒绝` | 核实身份；不能点一次忽略 |
| 认证失败 | `登录失败 · 更新密码后重试` | 不无休止尝试旧密码；存储不自动覆盖 |
| 会话不存在/替换 | `原会话不存在 · 恢复已停止` | 改选会话或明确新建，不隐式创建 |
| 被占用 | `已有客户端 · 自动恢复暂停` | 共享/只读/经二次确认接管 |
| 用户停止 | `已停止连接` | 手动连接；旧重试不得复活 |
| 存储失败 | `未保存密码 · 本次连接可继续` | 重试保存/删除条目；无明文降级 |

异常不只吐瞬时toast。状态条承载最小摘要，详细原因/操作面板保留到用户处理；
主机校验失败、接管和多行粘贴为阻断模态。窄屏模态可滚动，取消与确认始终可达。

## 实际验收矩阵与分阶段方案

| 层 | 窗口/平台 | 必测流程 | 证据/限制 |
|---|---|---|---|
| 设计浏览器 | 360×800、420×900、840×900、800×360；触摸与键盘 | 全部方案屏、面板、字号预算、无外部资源/存储、48px设计目标与对比 | HTML渲染/点击记录，不等于Android dp/IME/SSH |
| Web回归 | 原56案例 + 新状态/字号/手势；1.0/1.3/2.0文字设置 | 原preedit与ACK安全、重复/缺失tmux、代际、暂停恢复、组合输入与mouse仲裁 | production AOT +测试桥，保存synthetic标记 |
| Kotlin/Rust/真实loopback | 测试账户、生成密钥、真实tmux | 背景所有权、cancel/stop race、未知/改变host失败、vault更新/删除/篡改/不可用 | 不用真实用户账号；不上传fixture密钥/元数据 |
| Android矩阵 | API31 phone、32 tablet、33 phone、34 tablet、35 phone、36 phone/tablet、37 phone/tablet | 保留旧207必测；Home/恢复/停止、网络失联、permission grant/deny/revoke、Keystore与output上限、IME/insets/rotate、截图 | x86_64执行；ARM64库与公共payload绑定，不能声称ARM64设备交互验收 |
| 可访问性 | API34+默认与200%；TalkBack/外接键盘 | 触摸范围dp、读屏焦点、文本不裁、只读/危险状态、A+/A−替代缩放 | 在一次性模拟器配置；不改真实设备设置 |
| Find N6后续人工 | 外屏/内屏、展开中、横竖屏、系统IME/指定中文IME、display/font配置 | 输入和选柄、键盘、density度量、网络切换、锁屏/后台、服务停止、APK升级签名 | 用户自行安装测试；明确目前仅基本运行已报告 |

网络切换先用loopback故障注入验证旧socket失效、有限重连和新socket身份；这不能冒充实际Wi-Fi→蜂窝。
一次性模拟器可测试app离线/系统模拟网络；Find N6真实网络切换留用户操作验收。
取消粘贴/信任/接管、只读、mouse本地选择和停止后重试要求PTY观察到零额外输入。
密码新增/更新/删除后重启app验证；认证失败不能覆盖旧密码；hostkey变化必须在密码发送前拒绝。

阶段D（本次）：源码和第一方研究、关键流程/线框/高保真/可点按方案/面积与状态预算、独立draft设计PR。
提交用户评审；不把图当成功能完成。

阶段S：在独立候选上实现Keystore存储与原生service基础，最小开关/通知权限说明。
先原生/JVM/loopback+Android新用例；保持旧UI行为直到安全接线通过。

阶段U1（评审后）：连接工作台、tmux列表和专注终端单一状态条；会话/方向/更多面板、字号设置；
先保留textarea安全门。先360dp+IME验证，再展开/横屏；失败保留明确降级输入条。

阶段U2：中文IME局部composition编辑器、双指缩放、历史锚点、鼠标仲裁与系统选柄深入验收；
可选固定侧栏与更多键布局在可读网格预算下启用，不默认分屏。

阶段V：精确提交SHA重跑旧九行与新测试；审计APK权限/ABI/签名/源码绑定；
提供ARM64 APK、checksum、真实模拟器截图和报告，用户自行安装验收。
禁止merge/release/store/自动安装真实手机。旧ded417ba候选一直保留。

评审重点：专注终端的单条身份布局；16sp初值与窄屏35列取舍；快捷条是否默认随IME显示；
第一批保留冻结快照的两次长按；后台默认关闭/通知前提；保存密码仅成功认证后提交。

## 复现设计包

```sh
python3 docs/design/android-mobile-ux/build.py
python3 docs/design/android-mobile-ux/validate.py
```

`build.py` 只生成设计HTML；`validate.py` 验证计划来源、预算、对比、设计文件边界。
`render.py` 用已安装的Playwright与Chromium渲染/点按方案，导出PDF、PNG和设计执行报告到
`evidence/`（Git忽略）。不下载浏览器、不操作Android设备，不执行真实认证。
