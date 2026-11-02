# 04 — 收缩：删除 dock 旧形态，维护文档收口

**What to build:** 旧 TeamPageDock 形态彻底消失：右栏只住系统边栏，仓库不再有 dock 的 store/组件/样式/持久化键；维护文档描述与代码一致，并把「中间栏不可插件化拆分」等三项限制记入在案。

**Blocked by:** 02, 03
**Status:** ready

设计口径见 [../spec.md](../spec.md) §5.1、§5.3、§5.5、§6。删除边界（本票开始时先复核，随 01–03 落地可能已收缩）：dock 组件与其 pane 栈/store、其 CSS module、`dsh.agent-team.dock.v1` 存储键读写、以 cordis 服务提供的 dock store、右栏阴影相关 locale 键（dockTitle/dockSplit/dockToggleButton 等）、其单测与客户端 spec。

## 删除与迁移

- [ ] 全仓 grep dock store 的 import 面：确认票 01–03 后残余消费者只剩将被删的测试；`navigation.ts` 的 `TeamTabFace`/`restoreTabFace` 若仅剩「最后站立界面」重放用途则保留并核对语义，若已无调用者一并删。
- [ ] 旧 spec 中仍有效的断言（如团队模式入口重放、地址解析）迁移/合并进票 01–03 建立的新 spec，然后删除 dock 单测与 dock 客户端 spec。
- [ ] `dsh.agent-team.dock.v1` 不迁移、不清理旧键（浏览器呈现记忆，自然淘汰；不加兼容层）。
- [ ] 删除后跑 `npm run test`、`npm run typecheck`；`npm run test:browser` 全套截图（desktop + 390×844）检视。

## 文档收口

- [ ] `docs/architecture/client-and-remote.md` 与其 `.zh.md`：座位表删 `rightbar` 阴影行；「render as tabs in the right-column dock」段落改写为「Team 页面以六个 tab 类型住进系统右侧边栏（两段式公开注册），频道/线程按 `dsh-resource://team/...` 寻址可多开并览」；持久化段落把 dock pane 布局记忆改为「tab 集合与布局归系统边栏 per-session 序列；导航快照只承担模式/Workspace/最后 face 记忆；`dock.v1` 已退役」。
- [ ] 新增/合并「在案限制」段（三项，措辞按 spec §6：中间栏拆分、2-pane 预算、会话归属）。
- [ ] grep `docs/frontend-design/`（sidebar-browser.md、message-center.md、layout-and-typography.md 等）中的 dock/右栏描述，同步改口径；如 `scripts/check-docs.mjs` 有 ceiling 行受影响则同步。
- [ ] `.scratch/README.md` 与工作项 README 状态更新；里程碑截图按证据规则挑少量人工确认图入 validation/。

## 验收

- [ ] 仓库中不存在任何 dock 运行时代码、存储键写入点或死 locale 键
- [ ] 文档与代码一致，限制三项在案，中英文档成对更新
- [ ] `npm run test`、`npm run typecheck`、`npm run test:browser` 全绿且截图检视合格
- [ ] 未修改 `../deepseek-harness`
