# v1.1：非活动标签加入实色底色

用户已认可此前 Linux 配色，并提出「非选中状态最好也有个底色」。本次保留整体风格、活动底色、强调色、工具栏和终端内容，只调整非活动标签的表现，并补齐完整设计包。

| 项目 | 之前 | 本次 |
| --- | --- | --- |
| 非活动标签 | 没有独立底色，与标签栏同色 | 深色 `#0D1320`、浅色 `#CAD8E9` 的实色圆角底色 |
| 活动标签 | `#303B4A` / `#FFFFFF`，2px 强调线、600 字重 | 完全保留；比非活动更亮，仍有独有标记 |
| 非活动文字 | 次级文字角色、400 字重 | 深色保持；浅色使用现有主文字角色，保证新底色上的可读性；仍为 400 字重 |
| 悬停 | 原 hover 底色与关闭操作 | 保留原 hover 颜色，独立于非活动底色；不出现选中标记 |
| 键盘焦点 | 展示焦点环 | 状态表同时展示当前标签及获得焦点的非活动标签；焦点不改变选中项 |
| 窗口失焦 | 展示当前标签中性标记 | 两类底色均保留，不降低透明度；新增深浅主界面失焦画稿 |
| 终端内容 | 原 ANSI 与字体 | 主界面终端正文像素与旧版逐像素相同 |

原版本：[深色主界面](https://github.com/Mafei/tabby/blob/2d5ac0975fc7001473c96a08759389a385093009/docs/design/linux-uiux-v1/png/Tabby-Linux-UIUX-v1-dark-workspace.png)、[浅色主界面](https://github.com/Mafei/tabby/blob/2d5ac0975fc7001473c96a08759389a385093009/docs/design/linux-uiux-v1/png/Tabby-Linux-UIUX-v1-light-workspace.png)。原提交保持可查看，未强推或覆盖。

本次：[深色](png/Tabby-Linux-UIUX-v1-dark-workspace.png)、[浅色](png/Tabby-Linux-UIUX-v1-light-workspace.png)、[状态对照](png/Tabby-Linux-UIUX-v1-state-matrix.png)、[深色失焦](png/Tabby-Linux-UIUX-v1-dark-workspace-window-blur.png)、[浅色失焦](png/Tabby-Linux-UIUX-v1-light-workspace-window-blur.png)。

验证包括 46 组原色/RGB565 配对、40 个导出的标签状态组、实际 PNG 中的底色/标记像素、深浅主界面终端正文像素未变。文字至少 4.5:1，关键标记至少 3:1，非活动底色相对标签栏至少 1.25:1，活动相对非活动至少 1.35:1，悬停相对非活动至少 1.15:1。状态还用形状、字重、外环或操作区别，不只依赖颜色差异。

新增底色不使用透明度或模糊，现有调色角色和尺寸全部保持。完整记录见 `tokens.json`、`contrast-audit.json` 和 `design-validation.json`。

所有图像均为原创设计示意，不是产品截图。配色方向和此项设计微调获得授权，产品 UI 实现仍未开始；真实 Tabby/xrdp、DPI、辅助技术、主题兼容及连接恢复验收留待实现阶段。
