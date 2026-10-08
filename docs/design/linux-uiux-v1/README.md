# Tabby Linux UI/UX v1 — 部分交付 / design review candidate

**原创设计示意，非产品截图；设计待评审，尚未实施新的 UI 功能。**

本次先交付已经成功上传的设计稿和说明。推荐「轻量标签工作台」：低饱和蓝灰、局部选中与焦点标记，保留终端 ANSI 配色和用户终端字体。

## 可查看的设计文件

- [深色主界面 PNG](png/Tabby-Linux-UIUX-v1-dark-workspace.png)
- [浅色主界面 PNG](png/Tabby-Linux-UIUX-v1-light-workspace.png)
- [深浅十种状态对照](png/Tabby-Linux-UIUX-v1-state-matrix.png)
- [深色会话入口](png/Tabby-Linux-UIUX-v1-dark-launcher.png) · [浅色会话入口](png/Tabby-Linux-UIUX-v1-light-launcher.png)
- [深色恢复暂停](png/Tabby-Linux-UIUX-v1-dark-recovery.png) · [浅色恢复暂停](png/Tabby-Linux-UIUX-v1-light-recovery.png)
- [深色 RGB565 设计量化比较](png/Tabby-Linux-UIUX-v1-dark-workspace-RGB565-simulation.png) · [浅色 RGB565 设计量化比较](png/Tabby-Linux-UIUX-v1-light-workspace-RGB565-simulation.png)
- [完整目标规格与参考资料](SPEC.zh-CN.md) · [对比度计算记录](contrast-audit.json)
- [设计生成源](generate_design.py) · [本地打包生成源](package_design.py)

## 部分交付范围

此提交包含 7 张原创设计 PNG、2 张明确标记的 RGB565 比较、规格、对比度记录及两个生成源。规格说明的是完整设计目标包；其中尚未出现在此分支的文件仍属待交付内容。

**待补：10 页评审 PDF、7 个可编辑 SVG、tokens.json、manifest.json。** 本页不提供这些未交付文件的链接，也不将其视为已上传完成。

## 验证与限制

原 PNG 已实际解码并检查：主要画板 1440×1000，状态表 1440×1236。RGB565 仅逐像素截断并复制颜色位数，未缩放或裁剪，不代表真实 xrdp。30 组颜色同时通过 RGB888/RGB565 数学门槛；不代表完整产品 GUI、可访问性或真实远程桌面测试。

所有主机、命令输出、时间和状态均为虚构样例。Linux 产品参考基线为 `d83bf1b4904e439533d074aa6f7d3b48ebde5776`（PR 3）。本候选仅新增此文档目录；产品源代码、工作流和 PR 3 保持不变。

正常离线生成使用 Inkscape、Noto Sans CJK SC / DejaVu Sans Mono，以及 Pillow / ReportLab。生成脚本输出的 PDF/SVG 等属于本地生成物，不等于已经完成远端交付。真实 Linux/xrdp、窗口失焦、DPI、主题兼容及恢复交互留待设计评审后的实现验证。
