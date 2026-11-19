# 成员工作状态机（working/busy/idle/waiting/free）+ set_status 工具

## Context

需求：给每个 Team 成员 agent 增加工作状态 working/busy/idle/waiting/free；agent 通过 `set_status` 工具自主控制 busy/idle/waiting/free；处于 free/busy 时除 human 与团队负责人外的发件人（Team Assistant、其他成员）不能给它发消息；收到 human/负责人消息后自动切 working；"任务结束" marker 完全移除，turn 完成信号改为调用 `team_set_status(idle/waiting/free)`。

已确认决策：拦截=拒绝并提示发送者（channel send 整体原子拒绝，Team Assistant 自动通知走日志）；marker 完全移除不留兼容；working 不允许显式设置。

## 领域模型

- 新类型 `AgentTeamMemberWorkStatus = 'working'|'busy'|'idle'|'waiting'|'free'`，定义在 `packages/agent-team/src/types/entities.ts`。
- `AgentTeamAgentMember` 加可选字段 `workStatus?`（旧 ledger 缺省省略，不迁移）。读取统一走辅助 `workStatusOf(member)`，缺省 `'idle'`（新旧 member 一致，新增 member 不显式写 idle）。
- 新 ledger op `team/member-status-changed`，data 用轻量 `{ memberId, workspaceId, status, previous }`（状态变更高频，不用全量快照；workspaceId 显式携带命中 operationWorkspaces）。

## 1. Ledger 接线（packages/agent-team）

- `types/operations.ts`：新 op interface + operation union。
- `spec.ts`：`agentTeamOperationSchema` union 加 zod schema。
- `types/requests-results.ts`：`AgentTeamSetMemberStatusRequest { requestId, memberId, workspaceId, status }` + result `{ receipt, member }`；`ledger.ts` L267 旁加 `AgentTeamAuthorizedSetMemberStatusRequest`。
- `ledger.ts` 新方法 `setMemberStatus`（照 `setMemberState` L6359 模式：enqueue → byRequest 幂等 → 校验 member enabled、status ∈ busy/idle/waiting/free → 写 op → apply）。授权仅 member 自身 actor（Host 自动 working 也以 recipient 的 member actor 提交，同 `member-session-rolled-over` 先例）。
- switch 接线全集：`operationWorkspaces`（L1726，显式 case）、threadRef 派生 switch（L4180-4214，加 `return []`）、applyTo（L5176+，更新 member 的 workStatus）、validateOperation（L4245+）、sameActor/assertSame 幂等辅助（照 setMemberState）。

## 2. 工具与 core（packages/tool-agent-team + index.ts）

- core：`index.ts` 加 `setMemberStatusForAgent(agent, request)`（memberCall 围栏，照 `sendMessageForAgent` L4920）。
- 工具：`tool-agent-team/src/index.ts` 仿 `team_message` L466 定义 `team_set_status`：参数 `status` enum（busy/idle/waiting/free）+ `workspace`；execute 用 `service/member/workspaceOf`；render 一行 "Status committed — @handle is now <status>"；显式传 working 报错 "working is managed by the Host…"。
- `member-runtime.ts` AGENT_TEAM_TOOL_NAMES 增 `team_set_status`（Host 启动断言 L7135 自动要求 preset 提供——工具与名单必须同版本发布）。

## 3. 拦截与自动 working

- 拦截在 **ledger 内**（mentions 在锁内派生，Host 看不到 body mention）：`sendMessage` L1986、`reply` L2037、`assistantReply` L2111、`sendDm` 在 recipients/direct target 派生后、写 op 前校验：recipient `workStatusOf` ∈ {free, busy} 且 sender 非 human 且 sender ≠ 该 workspace designated leader（ledger 内判：`leader===true` + participatesIn）→ 抛新 `AgentTeamDeliveryBlockedError`（携带 handle、status，提示 "only the Human or your designated leader can reach @x while free/busy"）。channel send/reply/DM 一律 pre-commit 整体拒绝；@all 含 blocked 成员同样整体拒绝并在错误里点名。
- 自动 working：`index.ts` 的 `sendMessageAs` L6449 / `replyAs` L6651 / `dmAs` L5256 在 `emitCommittedOutcome` 后遍历 `directMarkers`，recipient 状态 ≠ working 且 sender 为 human 或 recipient 所在 workspace designated leader（复用 `designatedLeaderOf` L6598）→ 以 recipient 的 member actor 提交 working op。仅对 directMarkers 触发，不因 follower chatter 触发。
- Team Assistant 自动通知（全部经 `sendMessageAs(assistant actor)`）：各 void 通知点补 try-catch + `logger.warn`（decision：走日志）。`completion-liaison` 的 `onCompletedStop` 只在成员宣告 idle/waiting 时打开 episode（busy=仍在工作、free=非工作时间，pushTasks/report-check 天然跳过），拒绝契约判定从 marker stop 改为 completed stop。`continuation-watcher`、`truncation-escalation`、`question-recurrence`、`capability-assessment` 等站点补 catch。

## 4. Guard / Liaison 改造

- `response-guard.ts`：
  - `AssistantResponseShape` 加 `setStatusTerminal`：`classifyAssistantResponse` 扫 tool-call block（ContentBlock tool-call 字段：`{type:'tool-call', id, name, arguments: string}`），`name==='team_set_status'` 且 arguments JSON 的 status ∈ {idle,waiting,free}。
  - Coordinator 加 per-turn `announcedTerminal` map：onAssistantMessage 命中置位；onTurnStop `reasonKind==='completed' && announcedTerminal` → `'completed'`；纯文本无工具调用轮次一律 faulty（不再有文本豁免）。
  - `TurnStopOutcome`/`StoppedTurnTail` 的 `'marker'` 改名 `'completed'`；`classifyStoppedTurnTail` 改为扫描最后 turn 内所有 assistant/message 的 tool-call block（不再只看最后一条文本）。删除 `COMPLETION_MARKER`/`endsWithCompletionMarker`/`TRAILING_DECORATION`。
- 消费点改名：`index.ts` L1410（fresh-start policy + truncation onCleanStop + liaison onCompletedStop）、boot tail 消费（~L6975）；`truncation-escalation.ts` onCleanStop → onCompletedStop。
- nudge 文本 `index.ts` L780 重写："继续就调下一个工具；收尾就在相关 Thread 交付后调用 team_set_status(idle/waiting/free)——那是 turn 的完成信号"。
- `completion-liaison.ts`：L383 push 文本去掉 marker 引用，改为引导 set_status；模块注释同步。

## 5. 提示词与文档

- `cordis.patch.yml` L106-108 Loop discipline 改写（英文为主）："…When the work you owe is delivered where your teammates can see it, close the turn by calling `team_set_status` — `idle` when nothing is assigned to you, `waiting` when you await another Member's or the Human's feedback, `free` when you are off duty. That call is your turn's completion signal: the Host's response guard treats a stop without any tool call as a faulty round and steers a continue. Set `busy` only at the start of a focused stretch the Human or your leader asked for — while `busy` or `free`, only the Human and your designated leader can reach you; your own work and Task tools stay available."
- `team_set_status` description：四态含义、busy 按用户/负责人要求在专注段开始时设置、free/busy 的拦截后果、working 由 Host 管理。
- 文档同步：`docs/architecture/host-authority.md`（拦截权威在 ledger）、`docs/architecture/tools-and-preset.md`（工具清单）、`packages/agent-team` 与 `packages/tool-agent-team` README；按 `docs/AGENTS.md` 路由规则补分支。

## 6. Client（最小化）

- `workStatus` 经 `AgentTeamClientMember`（entities.ts L449 的 Omit 派生）自动下发；`TeamMemberRow.tsx` 加状态徽标（busy 醒目色、free 灰、缺省按 idle）。
- 跑 `npm run generate:typert`（禁手改 lib/typert.*）。

## 7. 测试

- 改造：`response-guard.spec`（终态检测、completed 改名、纯文本 faulty）、`completion-liaison.spec`（idle/waiting 触发、free/busy 跳过）、`member-lifecycle.spec` / `member-prompt.spec` / `member-tool-policy.spec`（所有 `${text}${COMPLETION_MARKER}` 收尾改为末轮注入 team_set_status tool-call；复用 `member-lifecycle.spec.ts` L185-195 的 toolCallResponse helper，提升为共享 helper）。
- 新增：ledger op replay/幂等 spec；拦截规则矩阵 spec（sender×status：human/leader 直达，member/assistant/@all 拒绝）；自动 working spec；工具 spec（working 拒绝、render）。
- `preset-delegation.spec` / `shipping.spec` 若引用旧 discipline 文本同步更新。

## 8. 验证

`npm run typecheck` → 定向 vitest（response-guard / member-lifecycle / completion-liaison / member-tool-policy / preset-delegation / shipping）→ `npm test` → `npm run build` → UI 变更跑 `npm run test:browser`，检查 artifacts/browser 截图（desktop + 390×844）。

## 风险与取舍

- 纯文本收尾全判 faulty 比 marker 时代更严格，依赖提示词改写到位；上线后观察 nudge 频率。
- 崩溃孤儿：持久 workStatus='working' 无收尾——boot 恢复发现 faulty tail 且 workStatus==='working' 时由 Host 补 working→idle（记为后续项）。
- AGENT_TEAM_TOOL_NAMES 与工具必须同版本发布，否则旧 preset 成员激活被启动断言拒绝。
- busy/free 拦截使 Team Assistant 类提示静默丢失（仅日志），运维需接受。
