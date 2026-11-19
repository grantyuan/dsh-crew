# L3 代际汇总 + context_recall 原文下钻实施计划

工作分支：`feat/context-auto-compaction`（worktree `/home/yus/work/dsh-agent-team-cac`，基线 `7b12bb1`）

## Context

P1.5 已接通真实 Session 摄入、embedding 回填、idle 预生成与 preset `/compact`，但还留两个明确缺口：

1. `context_review` 的 `clusters[].generations` 仍是固定空数组，L3 代际汇总与图内 rollup 未实现。
2. `context_recall` 只能 search，无法按 `cu:` / `seg:` 引用回读原文，也无法返回取代状态与置信度。

本轮只做这两件；不放宽既有压缩阈值，不改版本号/README，不做性能脚本与维护文档更新。

## 设计结论

### 1. L3 代际汇总与图内 rollup

**汇总来源**：每代 = 一个 Session。优先使用该代已提交的 L2 segment digest；没有 segment 时退回该代 L1 unit 的确定性抽取。汇总为**零模型、零 surface 改写**：

- 决策原句逐字追加，不重写、不再摘要；只做去重与有界截断。
- 上限 600 token ≈ 2400 字符（常量 `CONTEXT_GENERATION.maxSummaryChars`）。
- 有 L2 时 confidence 0.8；仅有 L1 抽取时 0.6。
- 只写派生索引，不进 prompt、不进 surface，因此不触发任何缓存重算，也不需要过 `S×N > 2R` 成本判定；该判定仍只属于既有 surface L2 合并路径（`planContextCompaction` 不改）。

**新文件** `packages/agent-team/src/context/generation.ts`：

- `generationRef(sessionId) => gen:<sessionId>`
- `generationNodeId(sessionId) => mn:gen:<sessionId>`
- `buildGenerationSummary({ sessionId, segments, units })`：输出有界文本，决策逐字、承诺/开放问题追加。
- `rollupGeneration(store, memberId, sessionId, { now? })`：
  - `store.listSegments` + `store.listUnits`；
  - 为每个 L2 segment upsert 图节点 `mn:<segmentId>`（level `L2`、kind `summary`、ref `segmentId`、label 取 digest.summary 前 120 字符）；
  - upsert L3 节点 `mn:gen:<sessionId>`（level `L3`、kind `generation`、ref `gen:<sessionId>`、label = 完整有界汇总、confidence 如上）；
  - upsert `derived_from` 边：L3 → 每个 L2 segment 节点；
  - 返回 `ContextGenerationRecord`；无 unit 且无 segment 时返回 `undefined`。
- `readGenerationSummaries(store, memberId, sessionIds)` 复用 store 查询。

**存储/类型**：

- `context/types.ts` 新增 `ContextGenerationRecord { ref, sessionId, summary, confidence, validFrom, segments }`。
- `store.ts` 新增只读查询 `generationSummaries(memberId, sessionIds)`：查 level `L3`、kind `generation` 的节点，再按 `derived_from` 边取 segment refs。写入复用既有 `upsertNode` / `upsertEdge`，不新增表，不升 schema。
- 无需新 schema 版本。

**触发**（按既定策略：代关闭/rollover 时汇总；图内汇总零缓存代价）：

- `pipeline.ts` 维护 `lastSessionByMember`。`recordSessionEvent` 发现 Member 的 sessionId 变化时，后台 `void rollupGeneration(previousSessionId)`，即代关闭即汇总。
- `ContextPipeline` 新增 `rollupGeneration(memberId, sessionId)`（fire-and-forget、异常只记日志）。
- `scheduleContextIdle` 在既有 `prepare()` 旁调用一次 rollup，使当前代在 idle 也有可用 L3；不 await、不调模型。
- 不在 `context_review` 内写索引，保持工具只读。

**review 输出**：

- `ContextReviewCluster.generations` 从 `readonly string[]` 改为结构化数组：
  `ContextReviewGeneration { ref, sessionId, summary, confidence, segments }`。
- `review.ts` 按 cluster 内 unit 的 sessionId 批量读取已存在的 L3 汇总；`segments` 只保留属于本 cluster 的 segment；没有 L3 的会话不臆造。
- `narrative` 增加 generation 数量。
- 同步更新 `types/requests-results.ts`、`tool-agent-team/src/context-tools.ts` 的 output schema/render/description；渲染每代一行 `gen:<sessionId> · confidence · summary`。

### 2. `context_recall` 的 `read` 子命令

**新文件** `packages/agent-team/src/context/read.ts`：

- `parseContextReadRef(ref)` 支持：
  - `cu:<sessionId>:<seq>`
  - `seg:<sessionId>:<fromSeq>-<toSeq>`
- `readContextSource(store, memberId, { ref, maxChars = 4000 })`：
  - 用 `store.listUnits(memberId, sessionId, { fromSeq, toSeq })` 取原文（摄入时已保存消息原文，跨代同样可用）；
  - 逐条渲染 `[seq role/kind] text`，按 `maxChars` 截断并返回 `truncated`、`totalChars`；
  - 用 `store.unitStatuses` 与 `store.getNode(contextNodeId(unitId))` 返回每条与整体的 `status`、`supersededBy`、`validTo`、`confidence`；
  - 无命中返回 `read-ref-not-indexed`，不抛错；纯只读，不写索引。
- `service.ts` 新增 `read(memberId, request)`，把异常归一为 `read-failed` / `index-unavailable`。

**Host 与工具**：

- `AgentTeamContextRecallRequest` 增加 `ref?`、`maxChars?`；`AgentTeamContextRecallToolOutcome` 增加可选 `read`。
- `contextRecallForAgent`：有 `ref` 走 `service.read`，否则保持现有 search。
- `context-tools.ts`：
  - `query` 改为非必填；新增 `ref`、`maxChars` 参数；执行时要求 query/ref 至少一个。
  - output schema 增加 `read` 对象（`ref/sessionId/fromSeq/toSeq/text/truncated/totalChars/status/confidence/supersededBy?/validTo?/units`）。
  - render 增加 read 分支：打印来源、状态、置信度、截断说明；原 search 分支不变。
  - description 去掉 L3 占位说明，并写明 `read` 用于摘要引用回读、不是 checkpoint ref。

## 测试

新增：

- `packages/agent-team/tests/context-generation.spec.ts`
  - 有 L2 segment 时生成 L3 节点、`derived_from` 边、决策原句逐字保留、长度有界；
  - 无 segment 的短代使用 L1 抽取并返回 summary/confidence；
  - pipeline session 切换触发旧代 rollup（用 fake time/直接调用）。
- `packages/agent-team/tests/context-read.spec.ts`
  - `cu:` 单条回读；
  - `seg:` 区间回读 + `maxChars` 截断；
  - superseded 的 `status/supersededBy/validTo` 与 confidence；
  - 缺失 ref 返回 `read-ref-not-indexed`。

修改：

- `context-review.spec.ts`：先 rollup，再断言 `clusters[0].generations` 返回真实 `{ ref, sessionId, summary }`，并保留原有决策/取代断言。
- `packages/tool-agent-team/tests/context-tools-render.spec.ts`：更新 review generations schema/render 断言；补 read 分支渲染与 schema。
- 如 Host/tool 集成测试对 recall 输出形状有断言，按新可选字段做最小调整。

## 验证与提交

1. `npm run build`（worktree `-cac`；集成测试经 package exports 读 `lib`）。
2. `npx vitest run packages/agent-team/tests/context-generation.spec.ts packages/agent-team/tests/context-review.spec.ts packages/agent-team/tests/context-read.spec.ts packages/agent-team/tests/context-recall.spec.ts packages/tool-agent-team/tests/context-tools-render.spec.ts`
3. `npm run typecheck`、`npm run lint`。
4. 如触及 Host 工具面且时间允许，补跑相关 `member-lifecycle` context 用例；全量 `vitest` 的既有并行 flaky 不作为本轮阻塞项。
5. 两个独立票分别提交：
   - `feat: roll up L3 generation summaries into context review`
   - `feat: add original-source reads to context recall`
6. 报告两个提交号、改动、真实测试结果与剩余缺口；不碰版本号/README，不更新维护文档与性能脚本。
