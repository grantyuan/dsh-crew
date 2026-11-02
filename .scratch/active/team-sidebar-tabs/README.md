# Team 页面并入系统右侧边栏（team-sidebar-tabs）

**状态**：四票全部完成，实现提交于 feat/team-sidebar-tabs（d358172→796bc77）。待 operator 在 dev profile（`dsh web --profile web-dev`）人工验收；验收后按生命周期归档并把里程碑证据入 validation/。
**最近核对**：2026-11-02
**当前前沿**：票 03（多开并览语义打磨）；完成后票 04 收缩删除 dock。串行 01→02→03→04。需与 `active/message-center`（其 P2 Client 页面 = `team-message-center` tab）协调。执行环境注意：browser 用 `CHROME_PATH=/usr/local/bin/chromium`；三个「设置」按钮相关的 e2e 失败在 main 基线即存在（邻近 Harness 漂移），票 04 复核。
**完成条件**：团队模式下系统右侧边栏可见可用（对话文件链接可点开、ExpandButton 生效）；六个 Team 页面以 tab 形式活在边栏里，可同时打开不同频道/线程并可用系统拆分/浮动并览；dock 旧代码与 `dsh.agent-team.dock.v1` 删除；`npm run test`、`npm run typecheck`、`npm run test:browser` 通过，desktop 与 390×844 截图检视合格。
**正式文档出口**：落地行为写进 `docs/architecture/client-and-remote.md` 与 `.zh.md`（座位表、布局段、持久化边界段），限制段保留 spec §6 三项；`docs/frontend-design/sidebar-browser.md` 如涉及则同步；随后本目录归档。

## 决策快照

见 [spec.md](spec.md)。它记录用户口径、根因验证、方案比较（选定 A：细粒度并入）、注册与接线设计、持久化边界与三项在案限制。

## 票据

| # | 票据 | 状态 |
| --- | --- | --- |
| 01 | [Team tab 类型注册与 body 薄适配层（expand）](issues/01-tab-types-and-bodies.md) | complete |
| 02 | [归还 rightbar，入口接线切到系统边栏（switch）](issues/02-return-rightbar-and-wire-entries.md) | complete（待提交） |
| 03 | [多开并览语义与页面行为打磨](issues/03-multi-view-and-navigation-semantics.md) | ready（blocked by 02） |
| 04 | [收缩：删除 dock 旧形态，维护文档收口](issues/04-contract-delete-dock-and-update-docs.md) | complete |

## 不做什么

不修改 `../deepseek-harness`：中间栏拆分多标准会话、超过 2 个 docked pane 的预算调整均记为限制（spec §6），不立项、不贡献上游；dock 旧状态不做迁移兼容。
