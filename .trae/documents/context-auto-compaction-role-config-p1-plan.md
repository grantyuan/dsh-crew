# 功能角色模型配置 + 回退链 + P1 落地计划

工作分支：`feat/context-auto-compaction`（worktree `/home/yus/work/dsh-agent-team-cac`，基于 `3b05c4a`）

## Context

此前设计把 `decision` / `embedding` 模型选型做成对话内的二选一待裁定项。用户已改向：模型不再由对话选型，而是在配置界面为每个功能角色填写访问配置，全部可选；运行时按「角色专用 → assistant 角色 → Agent 主模型」回退，并把嵌入改为未配置时自动下载推荐档位。目标是让功能可用性不再依赖一次性选型结论，同时保留原有客观延迟/质量阈值，不因回退而放宽。

## 关键决策（本计划默认值）

1. **配置粒度**：Host 全局 settings，四个角色共享；Member 仍通过既有 opt-in 策略决定是否参与上下文管线。不把端点/密钥写入 ledger，避免密钥进入 append-only 历史。
2. **留空语义**：`assistant` / `decision` / `extraction` 留空即不启用该角色。`embedding` 是唯一例外：默认启用，留空时使用内置本地模型；用户显式关闭后只走词法。这是需求 3 的直接结果，会在设置页明确写出。
3. **嵌入回退顺序**：`embedding 专用端点 → 本地内置 granite int8 → assistant 兼容 embeddings 端点 → 词法`。主模型永远不能承担嵌入。本地优先是为满足「未配置时自动下载并使用」且离线可用；assistant 仅作为本地运行时缺失时的兼容回退。
4. **主模型回退**：仍受角色原超时（assistant 25s、decision/extraction 12s）约束；超时即降级并记录 `fallback-over-budget`，不放宽阈值。
5. **本地 ONNX 运行时**：`@huggingface/transformers` 放入 `optionalDependencies`，动态 import；安装失败、加载失败、下载失败都降级词法，不影响主包启动。若最终不接受该依赖体积，代码接口不变，可降为 optional peer（只下载、不内置运行时）。
6. **API key**：随现有 `externalApiToken` 同级存于 settings profile，明文本地落盘；Remote 只返回 `apiKeySet`，永不回传明文或掩码；日志统一脱敏。不引入钥匙串（后续可加 `apiKeyEnv`）。
7. **P1 提交**：按 P1.1–P1.5 分票、每票一个 commit；每票独立测试，UI/工具面变化时跑 `npm run test:browser`。

## 功能模型的调用点与时机（本次补充）

先澄清术语，避免把两个“助理”混为一谈：

- **Agent 主模型**：运行 Member 对话的模型（`member.scheduledModel ?? member.model ?? agentDefaultModel`），不由本功能配置。
- **`assistant` 功能角色**：只负责上下文摘要/判断的专用模型，不是主模型；它只是回退链的第二跳。
- **功能模型不替代主模型**：主模型继续负责对话与决策；功能模型在它之外做预计算、压缩和关系判定，结果通过召回快照和两个工具回到主模型。

### 调用点/时机矩阵

| # | 触发时机 | 同步/异步 | 使用角色（回退链） | 输入 | 输出与消费者 | 预算/失败行为 |
|---|---|---|---|---|---|---|
| 1 | 消息/工具结果落库（`agent/session-event`、turn 结束） | 同步 | 无模型 | 新消息、工具结果 | L1 unit + 规则抽取的 time/exact/关键词/facet 写入 DB | <5ms；不调用模型；写失败只记日志 |
| 2 | 新 unit 向量化 | 异步 | `embedding`（→ 本地 granite → assistant 兼容 embeddings → 词法） | unit 文本、查询文本 | `vector` 表；供下一次 pre-step 的向量召回 | 5s/批；失败跳过，标记 `degraded:'vector'` |
| 3 | 规则抽取后补全 facet | 异步 outbox | `extraction`（→ assistant → 主模型） | unit 文本 + 已有规则 facet | 补缺失的 subject/topic/role/confidence；不覆盖规则来源 | 12s；重试 3 次后丢弃 |
| 4 | 新 unit 出现同 subject/slot 候选 | 异步 | `decision`（→ assistant → 主模型） | 新 unit + top-k 候选 | `none/update/refute` 关系；写 edge、取代链、conflict log | 12s；confidence <0.65 不落边；失败保留旧状态 |
| 5 | 上下文压力触发压缩（`compactRegion` / 溢出恢复） | 同步（压缩路径内） | `assistant`（→ 主模型） | 待压缩 region | `<compacted-summary>` 摘要块，交给 Basic 引擎 framing | 25s；失败回退 `BasicCompactionEngine.summarize()` |
| 6 | turn 结束后预生成 L1/L2 摘要 | 异步 | `assistant`（→ 主模型） | 已完成 turn 的 region | pending summary（内存 + meta），供下一次 pre-step 直接 commit | 25s；generation 不匹配丢弃；不阻塞对话 |
| 7 | `agent/pre-step` 召回注入 | 同步 | 无模型 | 当前 query、DB 中 exact/词法/facet/graph、已算好的向量 | `<recall-snapshot>`；主模型在下一步看到 | <10ms；任一路不可用只记 degraded，不 await 模型 |
| 8 | 主模型调用 `context_recall` / `context_review` | 同步 | 无模型 | 查询/主题/时间范围 | 结构化条目；主模型决定是否继续深挖或回答 | 工具预算；索引不可用返回空结果与原因 |
| 9 | 启动/重试嵌入模型下载 | 异步 | 无模型（本地下载） | HF 官方清单 | 本地 int8 模型 + 状态；供 #2 使用 | 不阻塞主路径；失败转词法 |
| 10 | 用户新消息后计算查询向量 | 异步 | `embedding` | 当前 query | 查询向量；下一次 pre-step 的向量路使用 | 5s；未就绪则本次只走 exact/词法/facet/graph |

### 与主助理模型的协作顺序

1. 用户消息进入 → #1 同步写 unit/规则索引；#2/#3/#4/#10 在后台补向量、facet、关系与查询向量。
2. 下一次 `agent/pre-step` → #7 只读 DB 生成快照（不 await 模型），把上一轮已算好的召回结果注入给主模型。
3. 主模型正常对话；若快照不够，它主动调用 #8 的 `context_recall` / `context_review` 做深挖。
4. 压力到来时 → #5 由 `assistant` 角色生成摘要；平时 #6 预生成 pending，下一次 pre-step 直接 commit，避免在 pre-step 生成。
5. 任何角色都不可用时 → 规则索引、词法/精确/facet 召回、两个工具仍可用；该角色对应的高级能力（向量、关系判定、模型摘要）不执行，按既有降级处理。

### 本功能不做什么

- 不在 `agent/pre-step` 里 await 任何模型（包括查询向量、decision、assistant）。
- 不让功能模型改写主模型的对话内容；只通过快照、工具结果、压缩摘要三种受控通道影响上下文。
- 不把主模型当嵌入模型；`HostModelRoleClient.embed()` 固定失败。
- 不在每条消息上同步调用 decision/extraction；它们只消费 outbox 中的候选。

### 与各阶段的对应关系

- 第一批（阶段 1+2）：交付 #2/#3/#4/#5/#6 所需的 runtime、配置、提示词、调度与嵌入下载；**不接 pre-step**。
- P1.1：接 #1、#3，建立 unit/term/facet/outbox 与规则抽取。
- P1.2：接 #2、#7、#8、#10，交付快照注入与 `context_recall`。
- P1.3：接 #5、#6，交付分层压缩与 pending/commit。
- P1.4：接 #4、#8 的 review 分支，交付图/取代链与 `context_review`。

## 阶段 0：文档同步（先提交 `docs:`）

修改 `.scratch/active/context-auto-compaction/spec.md`：

- §26.2：删除 provider 枚举/二选一；改为 `ContextRoleEntry { baseURL, model, apiKey?, enabled }`，Host 全局 settings，字段全部可选。
- §26.9–26.13：改为「可插拔配置 + 回退链」；保留 25s / 12s / 48k / 0.65 等阈值；新增「回退到主模型超预算只报告、不放宽」条款。
- §3.2 / §3.4 / §3.5 / §4.1 / §12.1 / §13 / §14 / §17 / §25：同步全局角色配置、嵌入内置默认、P1 范围与状态，删除待裁定。
- §15 的「P1–P4 不改 Client、配置界面放 P5」改为「配置界面随第一批交付」；仍不新增 ledger operation。
- §26.16（新增）：写入「功能模型调用点与时机」矩阵，明确同步/异步边界、与主模型的分工，以及 pre-step 不 await 任何模型。

修改 `decisions.md`：顶部状态去掉「待裁定」；模型选型表改为「角色配置建议默认值」；新增回退链决议与「阈值不因回退放宽」决议。
修改 `README.md`：P0 结论下补「角色配置 + 回退链」状态与第一批验收标准。

## 阶段 1：角色配置与回退链（第一批代码）

### 1.1 域模型与配置

新增 `packages/agent-team/src/context/role-models.ts`：

- `CONTEXT_MODEL_ROLES = ['assistant','embedding','decision','extraction']`
- `ContextRoleEntry` / `ContextRoleModels`
- `defaultContextRoleModels()`：空端点、空模型、`enabled=false`（embedding 的运行时默认在解析层处理）
- `normalizeContextRoleEntry` / `isContextRoleConfigured` / `validateContextRoleEntry`
- `CONTEXT_ROLE_TIMEOUT_MS`
- `resolveContextRoleRoute({ role, roles, main, embedding })` 返回判别联合：
  - `source: 'role' | 'assistant' | 'main' | 'local' | 'lexical' | 'off'`
  - `transport: 'openai-compatible' | 'host-llm' | 'local-onnx' | 'lexical'`
  - `promptProfile: 'small' | 'general' | 'embedding'`
  - `baseURL` / `model` / `apiKey` / `provider` / `timeoutMs` / `reason`

`packages/agent-team/src/human-profile.ts`：在 `HUMAN_PROFILE_SETTINGS_SCHEMA` 增加 16 个扁平 volatile 字段（4 角色 × `BaseURL` / `Model` / `ApiKey` / `Enabled`），避免嵌套 volatile 的兼容风险；Team Host row 已是 `auto:false`，不会进通用表单。

`packages/agent-team/src/index.ts`：`Config` 增加对应 `Volatile<string | undefined>` / `Volatile<boolean>` 字段；启动时构建 `ContextRoleRuntime`，不要阻塞 ready。

### 1.2 角色客户端

新增 `packages/agent-team/src/context/role-client.ts`：

- `RoleClient.chat()` / `RoleClient.embed()` 统一结果类型。
- `OpenAiCompatibleRoleClient`：`POST {baseURL}/chat/completions`、`POST {baseURL}/embeddings`；不猜 `/v1`；仅 key 非空时带 `Authorization`。
- `HostModelRoleClient`：复用 `ctx.get('llm').stream({ provider, model, messages, system, maxTokens, signal })` + `BlockAssembler`（参照 `index.ts` 约 1986–2010 行）；`embed()` 永远抛 `role-incompatible`。
- 超时用 `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`；错误分类 `role-timeout|role-auth|role-rate-limit|role-http|role-invalid-response|role-incompatible`；消息只含状态码与 host，不含 key/请求体。
- 主模型选择：`member.scheduledModel ?? member.model ?? ctx.agentDefaultModel.currentSelection()`。

### 1.3 提示词分文件

新增 `packages/agent-team/src/context/prompts/small-model.ts`、`general-model.ts`、`role-prompts.ts`：

- 任务键：`classify | enrich | summarize | conflict | commitment`。
- `small-model.ts` 只放专用小模型提示词：短指令、单 JSON 对象、字段白名单、失败 `{}`。
- `general-model.ts` 只放 assistant / 主模型承担角色时的提示词：显式声明「你正在承担 Team 的 `<role>` 角色」、输出契约、禁止对话化。
- 两文件互不 import；`role-prompts.ts` 只做调度与共享类型。单测断言两表同任务都存在、文本不同、general 含角色约束。

### 1.4 调度、熔断、指标

新增 `packages/agent-team/src/context/role-scheduler.ts`、`role-health.ts`、`metrics.ts`、`role-runtime.ts`：

- 每 `(memberId, role)` 最多 1 个在飞，全局 3 个；队列上限 8；`interactive` 优先于 `background`；`dispose()` 取消排队并 abort 在飞。
- 熔断键 `role + endpointKey(source|baseURL|model)`；60s 内 5 次失败开 5min；half-open 单探测；401/403 不计入熔断、不重试。
- 指标：`context_role_calls_total`、`context_role_fail_total`、`context_role_latency_ms`、`context_role_queue_depth`、`context_role_dropped_total`、`context_role_circuit_state`、`context_embedding_state`、`context_embedding_download_bytes`。
- `role-runtime.chat(role, task, payload, opts)` / `embed(texts, opts)` / `status()`；内部完成解析→调度→熔断→调用→指标。第一批只建 runtime，不接 `agent/pre-step`。

### 1.5 Remote 与 Client

`packages/agent-team/src/types/requests-results.ts` 新增：

- `AgentTeamContextRoleView { role, enabled, configured, baseURL, model, apiKeySet, effectiveSource, effectiveModel?, promptProfile, circuit, lastError?, lastLatencyMs? }`
- `AgentTeamEmbeddingModelStatus { state, modelId, revision, dimension, bytes, totalBytes, lastError?, downloadedAt? }`
- `AgentTeamContextRoleModelsView { roles, embedding, revision }`
- `AgentTeamSetContextRoleModelsRequest`：每角色可选 `baseURL/model/apiKey/enabled`；`undefined` 保持、`null`/`''` 清空。

`packages/agent-team/src/index.ts` 新增 `@Remote`：

- `contextRoleModels()`
- `setContextRoleModels(request)`：逐字段 `SettingsPathOp` 写 `['contextRoleXxx...']`；`baseURL`/`model` 任一清空时同角色 `enabled=false`；写后 `embeddingManager.reconcile()`，返回最新 view。
- `retryContextEmbeddingModel()`：触发下载但不等待完成。

Client：

- `packages/client-agent-team/src/client/index.ts`：在现有 `settings.section` 注入旁新增 `id:'team-context-roles'`，props `{ roles: { read, save, retryEmbedding } }`。
- 新增 `ContextRoleSettingsSection.tsx`、`ContextRoleCard.tsx`、`EmbeddingModelCard.tsx`、`context-role-settings.module.css`。
- 四张角色卡：启用开关、baseURL、model、apiKey（password，留空=保持，支持显式清除）、生效来源徽标、熔断/最后错误。
- 嵌入卡：状态、进度、模型 id/维度、失败原因、重试；`runtime-unavailable` 与 `lexical` 必须明确显示降级。
- 非乐观保存：保存成功返回 view 后替换 draft；失败保留 draft 并展示错误。
- `locales.ts` 增加四角色名称/描述、字段、状态、错误、降级文案；输入均有 label，错误 `aria-describedby`，状态 `aria-live`。

### 1.6 第一批测试

新增：

- `packages/agent-team/tests/context-role-models.spec.ts`：默认值、归一化、URL 校验、留空=未启用、回退链、嵌入特例、主模型不可嵌入。
- `packages/agent-team/tests/context-role-client.spec.ts`：mock fetch 的 2xx/401/429/超时/非 JSON/维度不一致；fake `llm.stream`；错误脱敏。
- `packages/agent-team/tests/context-role-prompts.spec.ts`：两套提示词完整、文本不同、general 含角色约束。
- `packages/agent-team/tests/context-role-scheduler.spec.ts`：并发、队列满、优先级、熔断三态、按端点隔离。
- `packages/agent-team/tests/human-profile.spec.ts`：16 字段 schema、逐路径 mutate 不丢其他角色。
- `packages/client-agent-team/tests/context-role-settings.client.spec.tsx`：读取/编辑/保存、密钥不回显、清除、错误、下载状态。

命令：`npx vitest run <上述文件>`、`npm run typecheck`、`npm run lint`；UI 完成后 `npm run test:browser`。

## 阶段 2：嵌入自动下载

新增 `packages/agent-team/src/context/embedding/manifest.ts`、`model-manager.ts`、`runtime.ts`：

- 固定模型：`ibm-granite/granite-embedding-97m-multilingual-r2`，文件 `config.json`、`tokenizer.json`、`tokenizer_config.json`、`special_tokens_map.json`、`onnx/model_quint8_avx2.onnx`（约 98MB，384 维）。
- 缓存目录：`dshHomePath('agent-team','models','granite-embedding-97m-multilingual-r2','r2-int8')`；支持 `HF_ENDPOINT` / `DSH_AGENT_TEAM_HF_ENDPOINT`。
- 下载：`*.part` 流式写入、Content-Length + SHA-256 校验、原子 rename、末尾 `manifest.json`；单飞 + `download.lock`（30min stale）；进度节流 250ms。
- 失败：状态 `failed`，保留旧完整版本；下次启动或手动重试才重新下载；词法立即可用。
- 运行时：动态 `import('@huggingface/transformers')`，`env.allowRemoteModels=false`、`allowLocalModels=true`；加载 `model_quint8_avx2.onnx`；mean pooling + L2 normalize，断言 384 维；批量上限 8；加载失败为 `runtime-unavailable`。
- 下载只在 `embedding` 启用时触发；未启用不产生网络请求。

测试：`context-embedding-manager.spec.ts`（本地 HTTP fixture 模拟下载、校验失败、并发去重、断点/重试、离线 ready）、`context-embedding-runtime.spec.ts`（动态 import 失败降级、维度断言）。

## 阶段 3：P1 分票

### P1.1 专用存储 + L1 units/keywords/facets

新增 `packages/agent-team/src/context/{types,schema,store,units,keywords,facets,extract-rules,coordinator}.ts`。

- 独立 SQLite DB：`dshHomePath('agent-team','context','v1.sqlite')`，`node:sqlite`，WAL、busy_timeout、`user_version=1`。不复用 ledger KV 后端。
- 表：`unit`（UNIQUE(member_id,session_id,seq)、member/generation/status/hash 索引）、`term`、`facet`、`unit_fts`（FTS5 unicode61+trigram，不可用则 LIKE 回退）、`recall_state`、`outbox`。
- 同步抽取（零模型）：时间归一、精确键（反引号/路径/URL/issue/commit/错误码/命令）、`Intl.Segmenter('zh')` 关键词、facet（time/space/role/topic）；单条 <5ms；在写入事件事务内完成。
- 异步补全：`outbox kind='enrich'` 调 `extraction` 角色，只补缺失项，不覆盖规则来源，失败 3 次丢弃，不阻塞。
- 测试：`context-store.spec.ts`、`context-extract-rules.spec.ts`、`context-keywords.spec.ts`、`context-facets.spec.ts`、`context-coordinator.spec.ts`。

### P1.2 召回 + 快照注入 + `context_recall`

新增 `recall.ts`、`recall-snapshot.ts`、`vector-index.ts`；修改 `member-context.ts`、`context-tools.ts`、`member-runtime.ts`。

- 五路：exact / lexical(FTS BM25) / facet / vector / graph(2-hop)；RRF `Σ w/(60+rank)`；每路 top50，融合 top12；默认排除 superseded/过期；不可用路只记 `degraded`。
- pre-step 只调同步 `renderRecallSnapshot()`，不 await 模型；`snapshotHash` 未变不注入；`<recall-snapshot generation replaces>` 含 ref/时间/状态/短摘要。
- `context_recall` 工具参数 `query/mode/limit/includeSuperseded/timeRange/subjects/roles`；输出 `items/degraded/reason`；索引不可用返回空与原因，不抛错。
- 测试：`context-recall.spec.ts`、`context-recall-snapshot.spec.ts`、`context-tools.spec.ts`、`member-tool-policy.spec.ts`；工具面变化跑 `npm run test:browser`。

### P1.3 L2 分层压缩

新增 `compaction.ts`、`epoch-planner.ts`、`summaries.ts`、`commitments.ts`。

- `AssistantCompactionEngine extends BasicCompactionEngine`，只覆写 `summarize()`，路由 `assistant` 角色；失败回退 `super.summarize()`。
- turn 结束后异步预生成 pending（≤6k tokens/块）；pre-step 只同步 `commit`，generation 不匹配丢弃；不调用 `compactRegion`。
- `segment` 表：L0 窗口/L1 主题/L2 代，只追加；合并条件 `S×N > 2×P` 且超硬上限。
- 承诺/决定抽取要求原文子串 + sha256 校验，失败回退 Basic 摘要。
- 测试：`context-compaction.spec.ts`、`context-summaries.spec.ts`、`context-pressure-boundary.spec.ts`。

### P1.4 图与取代链 + `context_review`

新增 `graph.ts`、`supersede.ts`、`conflict.ts`；修改 `context-tools.ts`、`member-runtime.ts`。

- `edge(src,dst,kind,weight,valid_from,valid_to)`，kind `supersedes|derived_from|caused_by|same_subject|same_decision`。
- 规则：同 subject+slot+更晚时间 → supersedes 候选；`decision` 角色 confidence ≥0.65 才落边。
- 取代事务：旧节点 `valid_to/status/superseded_by` + 边 + conflict log + 失效 snapshot。
- `context_review`：当前/历史分组、只读、可含 superseded；输出 ref/status/valid 区间/supersededBy/source/短引文。
- 测试：`context-graph.spec.ts`、`context-supersede.spec.ts`、`context-review.spec.ts`、`context-tools.spec.ts`；工具面变化跑 `npm run test:browser`。

### P1.5 集成、性能、文档

- 把 `coordinator` 接到 Session 事件；只在启用上下文角色的 Member 上启动。
- 新增 `scripts/context-perf.mjs` 与 `test:perf`：600/400/300 units，测 L1 写入、召回 p50/p95、快照注入，按 source 分组。
- 更新 `docs/architecture/tools-and-preset.md`（12→14）、`docs/team-collaboration/memory-and-context.md`、`docs/architecture/host-authority.md`、`package-ownership.md`、`docs/development/start-and-checks.md`、`packages/agent-team/README.md`。
- 全量：`npm run typecheck && npm run lint && npm test && npm run build && npm pack --dry-run && npm run test:browser`。

## 验收标准

### 第一批（完成即报告）

1. 四角色可独立填写/留空；留空显示未启用且不影响其他角色。
2. `decision` 专属模型清空后依次落到 assistant、主模型；三者都无显示 `off`；回退时实际使用 general 提示词。
3. `embedding` 未配置时自动下载官方 int8，384 维；下载/运行时/网络失败显示 `failed|runtime-unavailable|lexical`，主路径无阻塞。
4. `contextRoleModels` 响应无 `apiKey` 字段，仅 `apiKeySet`；日志无密钥/prompt/响应正文。
5. 401 不无限重试；超时按角色预算截断；熔断状态可见。
6. `npm run typecheck`、`npm run lint`、第一批全部单测、`npm run test:browser` 通过；桌面与 390×844 截图可见设置区与嵌入状态。
7. spec/decisions 无「二选一 / 待裁定」；阈值数字未改；新增「主模型回退超预算」报告条目。
8. 附按 `source` 分组的 p50/p95 表；主模型超过 25s/12s 时明确标注「未满足既有阈值」，不放宽。
9. 调用点可验证：单测断言 `agent/pre-step` 路径内没有任何 `role-runtime.chat/embed` 调用；`decision`/`extraction` 只在 outbox 后台任务触发；`assistant` 只在压缩或 turn 后预生成触发；主模型只通过快照/工具/压缩摘要消费结果。

### P1 各票

每票通过自身单测；涉及工具表面/设置页时通过 `npm run test:browser`；最终全量门禁通过。

## 风险

- `@huggingface/transformers` 会带入 `onnxruntime-node`/`sharp`，安装体积与平台 ABI 是主要风险；已放 optional，失败即词法。
- 嵌入默认启用会在首次启动触发约 100MB 下载；设置页必须显示进度与关闭开关。
- 主模型回退受原超时约束，可能频繁超时；只报告、不放宽。
- 专用 SQLite DB 是可重建派生数据；删除后从 Session 事件重建，不纳入 ledger 备份语义。
- P1 体量大，按票提交；若某票阻塞，先报告实测数据与缺口，不降级绕过。

## 报告节点

1. 分支已存在（`feat/context-auto-compaction`），无需新建；开始前报告当前提交。
2. 配置界面可用（阶段 1.5 完成）立即报告。
3. 第一批代码完成（阶段 1 + 2）立即报告，附验收证据。
4. P1 每票完成或阻塞时报告。
