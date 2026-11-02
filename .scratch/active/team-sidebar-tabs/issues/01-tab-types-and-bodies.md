# 01 — Team tab 类型注册与 body 薄适配层（expand）

**What to build:** 六个 Team 页面各自注册为系统右侧边栏的一等 tab 类型（阶段一 definition + 阶段二 body/title），频道/线程按 `dsh-resource://team/...` 地址寻址、天然支持同时多开。本票结束时新类型与旧 dock 并存（dock 仍占 `rightbar`，应用行为不变），但新 body 已能在测试 runtime 里渲染真实页面。

**Blocked by:** None — can start immediately
**Status:** complete（2026-11-02）

设计口径见 [../spec.md](../spec.md) §5.1、§5.2。契约先例：Harness `ui-sidebar-documentpreview` 包的浏览器侧入口（阶段一 `ctx.sidebarRightTabs.register(definition)`，阶段二 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: <definition id>, locale, store?, inject }, Body))`，chip title 可选注册到 `sidebar.right.pane.tab.title` 同 key 下；注册在激活期一次完成、不随团队模式生灭）。

## 决策密集片段（照此实现，勿另造）

- Kind 与形态：
  - 地址型（`multiple: true`，contentId=地址即幂等 reveal）：`team-channel` 认领 `dsh-resource://team/channel/**`；`team-thread` 认领 `dsh-resource://team/thread/**`。
  - 页面型（不设 multiple ⇒ 每 pane 每 kind 单例）：`team-inbox`、`team-tasks`、`team-message-center`、`team-session-history`。
  - definition `id` 格式：`agent-team.<kind>`。`title(address)` 用 thunk 读 `team` locale 命名空间。
- 地址文法与 params：
  ```text
  dsh-resource://team/channel/<workspaceId>/<channelRef>
  dsh-resource://team/thread/<workspaceId>/<threadRef>
  ```
  线程所在 channelRef/taskRef/taskNumber/threadOrigin 走 navigation params 而非地址（同一线程在不同频道上下文里是同一个 tab）。params 类型经声明合并注入：`SidebarRightResourceParamsMap` 增 `team` 键、`SidebarRightTabParamsMap` 增四个页面 kind 的键（workspaceId / memberId 等，JSON-shaped）。
- body 适配层：现有六个页面组件 props 不变（数据 callbacks 均索引自 `TeamPagePayload`，见 slots.ts 的 payload 定义），新增一个 per-kind 薄 body 组件，把阶段二 inject 拿到的 sessionId/actions、tab 的 `navigation.address/params`（按地址前缀 narrow 出 workspaceId/channelRef/threadRef）与现有 remote 闭包/drafts/TeamChangeStream 装配成页面 props。页面不再以导航快照为唯一渲染输入；params 缺省时回退导航快照的当前 workspaceId（guide 打开场景）。
- 每个页面 kind 提供 `guide` entry 一枚（收件箱/任务/消息中心），order 递增，标题走 locale thunk。

## 实施切片

- [x] 纯单元先行：地址 builder/parser 往返测试（含 branded ref 字符转义）；`title`/`canOpen`/glob 认领测试用真实 tab-registry 类构造（它只依赖 ctx.effect，无 DOM）。断言：同地址重复 claim 的 contentId 相同；线程地址不认领成频道 kind。
- [x] 适配层组件测试：测试 runtime 的 Frame 声明 `sidebar.right.pane.tab` 会话级 seat 并渲染注册体，喂一条 channel 地址的 navigation，断言渲染出频道页时间线；再喂两个不同频道地址，断言各自解析出各自 channelRef。
- [x] 在插件入口以阶段一+阶段二完成六个 kind 的注册与 locale 键补充（zh/en 成对）。旧 dock 注册路径一律不动。
- [x] `npm run test` 与 `npm run typecheck` 通过；提交。

## 实施备注（落地时与票面差异）

- 测试 harness 用 `runtimeWithTeam` 内新增的 `sidebarRightTabs` 记录替身与独立裸 bench 的最小替身；真实 `SidebarRightTabRegistry`（Harness 私有实现）不直接构造，claim 语义以 `canOpen` + 地址解析器的等价纯单元覆盖。
- body 适配层测试用手动构造的 tab occurrence 直挂组件（真实 rightbar seat 机器不在本包测试范围），两频道独立性由此证明。
- 全量并发 `npm run test` 存在基线即在的负载抖动（member-lifecycle/digest/inbox 超时，干净树同样失败）；本包 34 文件 325 用例单独全绿，改动文件单独全绿。

## 验收

- [x] 六个 kind 注册成功且与内置 kind 无冲突（extension band；重复注册幂等 disposer 生效）
- [x] 频道 tab 的 body 测试渲染出真实频道页，地址参数解析正确
- [x] 两个不同频道/线程地址的 tab 各自独立渲染（多开的逻辑前提）
- [x] 应用现状零变化：dock 仍占右栏，既有 dock 测试全绿
- [x] 不做：中间栏改动、Harness 改动、dock 数据迁移
