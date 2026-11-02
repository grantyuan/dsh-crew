# 02 — 归还 rightbar，入口接线切到系统边栏（switch）

**What to build:** 团队模式下系统右侧边栏重新挂载并可正常使用：右栏不再是 TeamPageDock，而是系统边栏；左栏入口、消息 ref chips 改为调用 `ctx.sidebarRight.openResource/openTab` 打开票 01 的 tab 类型；中间栏对话里的文件链接点击恢复可见打开；对话头部 ExpandButton 复活。dock 代码此时仍在仓库但不再挂载右栏（contract 留给票 04）。

**Blocked by:** 01
**Status:** ready

设计口径见 [../spec.md](../spec.md) §5.1、§5.2、§5.4。

## 改动面

- 插件入口：删除 `rightbar` 的模式阴影、`dockInject` 与 `syncPresentation`（原经 `ctx.layout.openRightbar/closeRightbar` 报告呈现的整段）；`inject` 名单增补 `sidebarRight`、`sidebarRightTabs`。`sidebar.workspaces` 与 `sidebar.settings` 阴影不动。
- 左栏（TeamWorkspaceBrowser 及各面板）：原 `{ openDock(); selectInbox() }` 类点击改为一律「先更新导航快照（记忆职责保留），再调 `sidebarRight`」：
  - 收件箱/任务/消息中心 → `openTab(kind, { params: { workspaceId } })`；
  - 频道行 → `openResource(频道地址)`；线程行与成员队列任务行 → `openResource(线程地址, { params: { channelRef, taskRef?, taskNumber?, threadOrigin? } })`；
  - 会话历史菜单项 → `openTab('team-session-history', { params: { memberId, workspaceId } })`；
  - 成员卡片点击的中间栏会话嵌入（`enterMemberSession` + `uiWorkspace.openSession`）维持现状不变。
- TeamMessage ref chips：`openRef` 的落点从导航快照改为上面对应的 open 调用（成员会话 chip 仍走中间栏嵌入）。
- 宽窄两栏的 dock 开合 toggle 按钮移除（列展开由 `openResource/openTab` 自动完成；收起归系统边栏自己的控件）。相关 locale 键本票不删（票 04 统一清）。
- 进入团队模式的重放：按导航快照最后 face 调用对应 open（成员会话 runtime-only 记忆规则不变）。
- 无会话降级：`sidebarRight` 在无选中会话时命令会 throw；左栏/chips 的调用统一 catch，降级为仅更新导航、不弹窗（区别于 ChatView 自己的文件打开错误弹窗路径，那边零改动）。

## 实施切片

- [ ] 组件测试先行：扩展测试 harness（`runtimeWithTeam` 模式）——provide `sidebarRight`/`sidebarRightTabs` 服务替身（记录 open 调用的地址与 params），断言各入口点击的调用形状；断言无会话替身下点击不抛、仅导航快照更新。
- [ ] 切换入口注册：删 rightbar 阴影段，跑既有客户端测试，把断言右栏是 dock 的旧期望改到「系统边栏在场、Team 页面经 open 调用出现」的新形态（旧 dock 单测此票允许保留为红名单或直接改造——票 04 才删文件）。
- [ ] `npm run test:browser`：桌面截图确认团队模式下右栏为系统边栏、点频道后 tab 出现在栏内；390×844 截图确认窄视口自动全屏行为可用；检视截图并确认可达性（按钮 aria、键盘焦点）。
- [ ] `npm run test`、`npm run typecheck` 通过；提交。

## 验收

- [ ] 团队模式默认右栏 = 系统右侧边栏（其引导页/展开按钮正常工作）
- [ ] 左栏六类入口与消息 chips 均能在边栏开出对应 tab；同址重复点击是 reveal 不是重复开
- [ ] 「对话」窗口文件链接在团队模式下点击可在右栏打开（含错误弹窗路径不再误报）
- [ ] 进入团队模式重开最后站立界面；刷新后恢复仍成立
- [ ] 窄视口（390×844）可用；不修改 Harness 仓库
