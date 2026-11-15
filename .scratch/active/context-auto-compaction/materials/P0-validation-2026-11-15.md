# P0 验证记录（2026-11-15）

- 分支：`feat/context-auto-compaction`（worktree `/home/yus/work/dsh-agent-team-cac`，基线 `3b05c4a`）
- 环境：Node 24.22.3、Vitest 4.1.10、Harness 同级 checkout；Python 3.12 + torch 2.6.0（CPU）+ transformers 4.57.6 + onnxruntime 1.32
- 结论：P0-1/2/3 通过；**P0-4 不通过**；**P0-5 不通过（naive int8）**。两项都不放宽阈值，需裁定后再进入 P1。

## P0-1 `summarize()` 覆写是否可行 —— 通过

`BasicCompactionEngine` 的子类只覆写 `summarize()` 即可接管摘要来源。

- framing 由引擎负责：`summarize()` 返回裸 blocks，`region.ts` 的 `frameSummary()` 再包 `<compacted-summary>`。覆写方不得自己加包裹。
- 「摘要必须更小」在 framing 之后强制校验（`framedSummaryTokenCount >= shadowedRouteTokenCount` 直接失败），覆写方无法绕过。
- `compactNow` 走 `ManualCompactionError` 包装（错误信息变成 "manual compaction could not produce a smaller summary"，原始错误在 `cause`）；turn 内 `compactRegion` 抛原始错误。

## P0-2 framing 与压缩事务落锁 —— 通过

用真实 `AgentLoop` + `Session` 跑 6 条断言，全部通过：

| 断言 | 结果 |
| --- | --- |
| 提交后派生消息第 2 条含 `<compacted-summary>` 且文本来自覆写 | 通过 |
| `surface.replaceGeneration` 单调递增 | 通过 |
| 事件序列恰为 `compaction/start` → `compaction/summary` → `compaction/end` | 通过 |
| `compactRegion` 无打开轮次时拒绝（`no open turn`） | 通过 |
| live unmatched `compaction/start` 让第二次调用报 `compaction already in progress` | 通过 |
| `summarize()` 抛错后引擎补写带 `error` 的 `compaction/end`，锁释放，可再次提交 | 通过 |

另外两条稳定性语义（与设计直接相关）：

- `compactRegion` 用 **whole-surface** 稳定性：摘要期间追加任何 message-producing 事件 → `SurfaceChangedError`。
- idle `compactNow` 用 **selected-span** 稳定性：摘要期间在尾部追加消息不会失败。因此 D5=A 的实现必须走 turn 内 `compactRegion`，不能用 `compactNow` 代替。

**§13 的悬念关闭**：`summarize()` 抛错**不会**留下压缩锁。

## P0-3 6k 输入实测延迟 —— 通过

远程 `gemma-3-4b-it`（`n_ctx=40960`），同一端点：

| 场景 | prompt | 输出 | prefill | decode | 总 |
| --- | --- | --- | --- | --- | --- |
| 冷前缀 | 5419 tok | 35 tok | 1.71 s（≈3.2k tok/s） | 0.28 s | 2.15 s |
| 同前缀复跑 | 5419 tok | 35 tok | 0.17 s（cache 命中 5418） | 0.28 s | 0.50 s |
| 冷前缀长输出 | 5424 tok | 896 tok | 0.17 s（前缀命中） | 7.15 s（125 tok/s） | 7.42 s |

结论：L2 的 ≤25 s 预算余量很大；spec §12 的 8–20 s prefill 估算偏保守，应改为「6k 冷约 1.7 s，热约 0.2 s」。

## P0-4 Laya 多语模型的中文决策准确率 —— **不通过**

数据集：60 条人工标注中文用例（none/update/refute 各 20，`.scratch/local/p0/laya_zh_cases.json`），`convaiinnovations/laya` multilingual（322M，CPU，p50 296 ms / p95 487 ms）。

| 提问方式 | 准确率 | none | update | refute |
| --- | --- | --- | --- | --- |
| 中文 choice（三选一，长说明） | 0.450 | 0.35 | 0.05 | 0.95 |
| 中文 choice（短说明） | 0.500 | 0.65 | 0.05 | 0.80 |
| 英文 choice（三选一） | **0.617** | 1.00 | **0.00** | 0.85 |
| 中文 noul 分解（同属性/新值/否定） | 0.333 | 0.90 | 0.10 | 0.00 |
| 中文 noul 分解（改进措辞） | 0.533 | 0.95 | 0.15 | 0.50 |
| 对话式两问 | 0.383 | 0.85 | 0.15 | 0.15 |

两种二分类提问也不可用：`conflict`（互斥）binary acc 0.483、recall 0.225；`same_slot` binary acc 0.350、recall 0.075。

对照：同一 60 题用远程 `gemma-3-4b-it`（严格 JSON、temperature 0）→ **0.900**（none 0.90 / update 0.80 / refute 1.00），60 次调用共 11.5 s。

结论：Laya 在单文本 typed question 上正常（README 的 billing 例：英文 1.0、中文 0.999），但**零样本做不了「两条陈述的关系分类」**，尤其是 update 与 refute 不可分。CPU 档把 `decision` 交给 Laya 的方案，按现有输出契约 `{relation, target, confidence}` 不成立。

## P0-5 Qwen3-Embedding int8 掉分 —— **不通过（naive int8）**

语料：200 条中文记忆单元（25 主题 × 8 变体），25 条零词面重叠的改写查询；指标为 topic-level top-1/top-5 与 fp32↔量化余弦。fp32 基线 top-1 0.64 / top-5 0.76（合成集偏难）。

| 方案 | top-1 | top-5 | 与 fp32 余弦（均值 / 最小） |
| --- | --- | --- | --- |
| ONNX fp32 | 0.64 | 0.76 | — |
| PyTorch 动态 int8 | 0.56 | 0.76 | 0.671 / -0.099 |
| ONNX 动态 int8 | **0.04** | 0.24 | **0.145 / -0.031** |
| ONNX 4-bit 权重（MatMulNBits, block 32, sym） | 0.64 | 0.72 | 0.837 / -0.035 |

结论：Qwen3-Embedding 存在激活离群值，**动态 int8 量化（含激活）会破坏表示**，不能按 spec 的「int8 ONNX ≈0.6 GB、掉 0.3–1 分」执行。权重-only 4-bit 保留 top-1，可用但需更大评测确认。可选路径：fp32 ONNX（≈2.4 GB 内存）/ fp16（GPU 档）/ 4-bit 权重-only / 换更小嵌入模型。

## 需要裁定的两个偏离

1. **CPU 档 `decision`**：Laya 零样本不可用。选项：① CPU 档改用规则判定（§13 的既有降级路径），`decision` 角色只在 GPU 档启用 4B；② 用我们的 60 题规模数据微调 Laya（发布方同类微调 0.362→0.766，需训练环境）；③ 把 `decision` 输出契约降为二分类并在规则侧补 update/refute 拆分（P0-4 显示二分类也不达标，不推荐）。
2. **嵌入量化**：spec §26.9.1/§26.11 的 int8 假设不成立。选项：① 默认 fp32 ONNX（内存 ↑）；② GPU 档 fp16；③ 权重-only 4-bit（top-1 未掉，但需扩样验证）。

两项都按「不放宽 §14.2/§14.3 阈值」处理；未裁定前不进入 P1 代码实现。
