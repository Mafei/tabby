# Tabby Linux UI/UX v1.1：非活动标签底色

**原创设计示意，非产品截图。整体配色已获认可，本次仅按反馈增加非活动标签的实色底色；产品 UI 未实施。**

## 查看设计

- [深色主界面 PNG](png/Tabby-Linux-UIUX-v1-dark-workspace.png) · [浅色主界面 PNG](png/Tabby-Linux-UIUX-v1-light-workspace.png)
- [十种状态对照](png/Tabby-Linux-UIUX-v1-state-matrix.png)
- [深色窗口失焦](png/Tabby-Linux-UIUX-v1-dark-workspace-window-blur.png) · [浅色窗口失焦](png/Tabby-Linux-UIUX-v1-light-workspace-window-blur.png)
- [12 页评审 PDF](proposal.pdf)
- [前后变化说明与旧版链接](REVISION.zh-CN.md)
- [完整规格与参考资料](SPEC.zh-CN.md)
- [颜色与尺寸令牌](tokens.json) · [对比度记录](contrast-audit.json) · [导出设计验证](design-validation.json)
- [可编辑 SVG](svg/) · [所有 PNG 及 RGB565 比较](png/) · [实际交付文件清单](manifest.json)

## 本次调整

非活动底色为深色 `#0D1320`、浅色 `#CAD8E9`，不使用透明度或模糊。原活动底色、强调色、主界面颜色、尺寸及终端 ANSI 均保留。活动标签继续使用 2px 标记与 600 字重；非活动为 400 字重且没有选中标记。浅色非活动文字使用已有主文字角色，保证新底色上的对比度。悬停、非活动键盘焦点和窗口失焦分别展示；焦点不改变当前会话。

## 完整交付与验证

本目录已包含 9 张原创 PNG、2 张 RGB565 比较、9 个 SVG、12 页 PDF、规格、令牌、记录、生成源及清单。原来部分交付中缺失的 PDF/SVG/令牌/清单已补齐。

46 组原色/RGB565 配色检查通过。40 个导出的标签状态组及主界面实际像素经过检查；深浅主界面终端正文像素与旧版一致。关键文字至少 4.5:1，标记至少 3:1，非活动/栏底至少 1.25:1，活动/非活动至少 1.35:1，悬停/非活动至少 1.15:1；状态同时具备形状、字重、焦点环或操作提示。

原配色和此前固定提交 `2d5ac0975fc7001473c96a08759389a385093009` 保持可查看。产品参考基线为 PR 3 的 `d83bf1b4904e439533d074aa6f7d3b48ebde5776`。此次仅更新此文档目录，不改应用源码、工作流或 PR 3。

所有主机、输出和状态都是虚构样例。RGB565 为设计量化模拟，不是真实 xrdp；完整 Tabby GUI、DPI、可访问性、第三方主题及连接恢复仍需实现后的验证。

## 生成源

`generate_design.py` 生成 SVG、令牌和配色记录；普通 Inkscape 离线导出 PNG。`package_design.py` 使用本目录的 `SPEC.zh-CN.md`、Pillow 和 ReportLab 生成本地量化比较及 PDF/ZIP，字体为 Noto Sans CJK SC / DejaVu Sans Mono。交付的 `proposal.pdf` 是生成 PDF 的字节相同副本，使用英文文件名便于链接。生成源与本目录清单不会连接真实 SSH、读取真实凭据或改变产品配置。
