# Team 页面并入系统右侧边栏（team-sidebar-tabs）

**状态**：spec 已确认（2026-11-02 与用户逐问对齐），tickets 待 writing-plans 产出。
**最近核对**：2026-11-02
**当前前沿**：把 spec §5 拆成纵向切片 tickets（expand–contract：先注册 tab 类型与新接线，与 dock 并存；再迁移各页面入口；最后删除 `TeamPageDock`/`dock.ts`/`dock.v1` 旧形态）。需与 `active/message-center`（其 P2 Client 页面 = `team-message-center` tab）协调排期。
**完成条件**：团队模式下系统右侧边栏可见可用（对话文件链接可点开、ExpandButton 生效）；六个 Team 页面以 tab 形式活在边栏里，可同时打开不同频道/线程并可用系统拆分/浮动并览；dock 旧代码与 `dsh.agent-team.dock.v1` 删除；`npm run test`、`npm run typecheck`、`npm run test:browser` 通过，desktop 与 390×844 截图检视合格。
**正式文档出口**：落地行为写进 `docs/architecture/client-and-remote.md` 与 `.zh.md`（座位表、布局段、持久化边界段），限制段保留 spec §6 三项；`docs/frontend-design/sidebar-browser.md` 如涉及则同步；随后本目录归档。

## 决策快照

见 [spec.md](spec.md)。它记录用户口径、根因验证、方案比较（选定 A：细粒度并入）、注册与接线设计、持久化边界与三项在案限制。

## 票据

待 writing-plans 产出后填入 `issues/`。

## 不做什么

不修改 `../deepseek-harness`：中间栏拆分多标准会话、超过 2 个 docked pane 的预算调整均记为限制（spec §6），不立项、不贡献上游；dock 旧状态不做迁移兼容。
