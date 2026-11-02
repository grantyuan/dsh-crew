# Team 页面并入系统右侧边栏 — 设计快照

2026-11-02。本文件是已确认口径的决策快照；当前行为以 `packages/` 与测试为准。

## 1. 问题

用户原话（2026-11-02）：「在"团队"页面里，整个系统默认的右侧侧边栏无法显示，在"对话"窗口出现的文件链接，在"团队"页面里是无法点击在右侧侧边栏打开的。需要将中间栏，可以进行上下或左右拆分（可以同时查看多个 agent 对话，或查看多个左边栏中链接点击后的功能界面）」。

三个诉求：① 团队模式下系统右侧边栏恢复可用；② 对话窗口文件链接在团队页可点开；③ 多界面（对话 / 链接打开的功能界面）拆分并览。

## 2. 根因（已在代码中验证）

- Team 客户端用 `registerModeShadow` 以 priority -100 阴影单格 `rightbar` 槽（`client-agent-team/src/client/index.ts` 的 dockInject 与三阴影段），SlotCore「最低优先级渲染」规则驱逐了 `ui-sidebar-right` 的 `RightbarRoot`。这是刻意设计，不是 bug。
- 系统边栏不挂载 ⇒ `ui-chat` 的 `openFile → ctx.sidebarRight.openResource` 链路落进无渲染器的控制器：要么 throw（ChatView 的 fileOpenError 弹窗），要么提交到没人画的状态。对话头部 ExpandButton 成为死控件。
- 中间栏：`ui-layout` `AppFrame` 固定三轨、中轨每帧只渲染一个 `main` keyed 条目；`ConversationPanel` 只作 slot 渲染器挂载、未从 `ui-conversation/client` 公开导出，且绑定 session-maybe 作用域。⇒ **中间栏同时显示多个标准 DSH 会话无法插件化**（AGENTS.md 亦禁止复制私有 ConversationRoot/Shell/CSS，要求"记录限制而非静默依赖私有实现"）。

## 3. 决策口径（用户逐问确认）

| 问题 | 选择 | 含义 |
| --- | --- | --- |
| 拆分对象主要指什么 | 标准 DSH 对话 | 中间栏带输入框的 Session 会话界面 |
| 右侧边栏目标形态 | 团队页恢复系统右侧边栏 | 系统边栏（文件预览/资源 tab）在团队模式照常可用；Team 页面换承载 |
| Team 页面新家 | 并入系统边栏 tab 体系 | 走 `sidebarRightTabs` 两段式公开 API；文件预览与团队页面共存、多 pane 并览 |
| 中间栏多会话如何排期 | 只做插件侧 | 本期不碰 Harness；"中间栏拆分多标准会话"仅记录为限制，不立项 |
| 架构路线 | A（细粒度并入） | B「dock 整体塞单 tab」、C「浮层化」被否 |

## 4. 方案比较

- **A 细粒度并入系统边栏（选定）**：每个 Team 页面注册为独立 tab 类型；`TeamPageDock` 退役、不再阴影 `rightbar`。系统边栏原生 tab 栏/上下左右拆分/浮动窗/每 pane 最大化全部白拿；文件链接零新代码恢复可用；频道/线程按地址寻址天然支持同时开多个。全走公开 API。
- **B Dock 搬进单 tab**：改动最小但双重 tab 栏、无横向拆分、两套布局代码并存。否决（搬家不是解决）。
- **C 浮层化**：Team 页面变可拖窗口。否决（遮挡对话、390×844 成本更高、肌肉记忆决裂最大）。

## 5. 设计

### 5.1 布局与注册

- 删除 `rightbar` 的 -100 模式阴影与 `dockInject`/`syncPresentation`；`TeamPageDock.tsx`、`dock.ts`、`dock.module.css` 及其测试退役。`sidebar.workspaces`、`sidebar.settings` 阴影保留不动。
- 两段式注册 Team tab 类型（stage one `ctx.sidebarRightTabs.register`，stage two 在 `sidebar.right.pane.tab`/`sidebar.right.pane.tab.title` 按 definition `id` 注册 body/title；band 默认 `extension`）：
  - 地址型（可多开、按地址=contentId 去重，重复点击=reveal）：`team-channel` 认领 `dsh-resource://team/channel/**`；`team-thread` 认领 `dsh-resource://team/thread/**`。
  - 页面型（每 pane 单例）：`team-inbox`、`team-tasks`、`team-message-center`、`team-session-history`，经 `openTab(kind, { params })` 打开，params 携 workspaceId 等寻址参数。
  - 注册在插件激活期一次完成、不随模式生灭（避免模式切换销毁已开 tab 类型致空渲染）；guide entry 的 `title` thunk 走现有 zh/en locale。
- body 组件是薄适配层：从 `navigation.params`/地址解析 ref，渲染现有页面组件（`TeamChannelPage` 等原样保留）；页面不再以导航快照为唯一渲染输入。

### 5.2 交互接线

- 左侧栏（`TeamWorkspaceBrowser`）各入口：更新导航快照（保留记忆职责）+ `sidebarRight.openResource/openTab`（列展开由 openResource 一步完成）。
- Team 消息 ref chips（task/thread/member-session 等）：改指向对应 tab 打开。
- 中间栏标准对话文件链接：系统边栏回挂即自动恢复；ExpandButton 复活。
- 嵌入成员会话：维持现状（中间栏单会话切换）。
- dock 开合 toggle 按钮移除（右栏展开/收起归系统边栏）。
- 执行期补充两条口径：线程类页面（Channel/Thread）的 Back 经包裹动作 reveal 下层列表/频道 tab，自己 tab 保留；session-history 的「返回」额外关闭自己的 tab（`useTabInfo().tab.actions.close()`）——它下层没有 Team 页面可回，「离开页面」在 tab 世界就是关 tab。e2e 与单测均按此钉住。

### 5.3 状态与持久化

- `dsh.agent-team.dock.v1` 退役、不迁移、不兼容（浏览器呈现记忆，非 Team 事实，不加投机兼容层）。
- pane 布局与 tab 集合交由系统边栏 per-session 序列持久化；Team 不建平行权威。
- 导航快照职责收缩为：模式/Workspace 记忆 + 进入 Team 模式时重开最后站立界面（动作=对应 openTab/openResource）；成员会话 runtime-only 记忆规则不变。
- 明确语义：Team tab 属于当前会话的边栏（VS Code 式 per-session 保留）；切会话由系统边栏 retained-session 机制接管。

### 5.4 边界与降级

- 窄视口（<768px）：继承系统边栏自动全屏；390×844 走 `npm run test:browser` 截图验收。
- 无选中会话时 `sidebarRight` 命令 throw：左栏点击处理统一 catch，降级为仅更新导航，不弹窗。
- 与 `active/message-center` 衔接：其 P2 Client 页面即 `team-message-center` tab 形态；实施排期需与该工作项前沿协调。

### 5.5 测试与文档出口

- 单元：tab 定义注册（kind/id 冲突、glob 认领、title thunk、guide 排序）、params→ref 适配、点击对 openResource/openTab 的调用；替换 `dock.spec.ts`/`team-dock.client.spec.tsx`。
- `npm run test:browser` 必跑（slot 接管、bundle 装配、可见 UI），desktop + 390×844 检视截图、键盘/焦点/dialog 可达。
- 维护文档：`docs/architecture/client-and-remote.md`（EN+zh）改座位表（去 rightbar 阴影）、dock 段落、持久化边界段落；限制段记录本快照 §6。

## 6. 记录在案的限制（本期不做，均因 Harness 扩展点不足）

1. **中间栏不可插件化拆分多标准会话**：`AppFrame` 中轨单面板；`ConversationPanel` 未导出且绑定 slot session 作用域。需 Harness 上游能力（如中轨接入 `ui-dockkit` 拆树）。
2. **系统边栏拆分预算**：`split()` 受 2 个 docked pane 预算与 room rule 约束（Harness 侧策略）；更多 pane 需上游调整。浮动窗可部分绕过。
3. **Team 页面的会话归属**：系统边栏按会话保留 tab；团队事实是 Workspace 级，跨会话切换时 tab 集合随会话走。

## 7. 主要取舍

获得：链接可用、右栏回归、多界面并览（2 pane+浮窗）、dock 代码净删除。
代价：Team 页面视觉 chrome 跟随系统 tab 栏；多开上限受 §6.2；中间栏多标准会话本期无解（§6.1）。
