# P0 验证记录（2026-11-15）

- 分支：`feat/context-auto-compaction`（worktree `/home/yus/work/dsh-agent-team-cac`，基线 `3b05c4a`）
- 环境：Node 24.22.3、Vitest 4.1.10、Harness 同级 checkout；Python 3.12 + torch 2.6.0（CPU）+ transformers 4.57.6 + onnxruntime 1.32 + llama-cpp-python 0.3.36；12 核 / 30 GB / 无 GPU
- 网络：本轮所有 HF 下载、API 与模型卡查询走 HTTP 代理 `http://127.0.0.1:1095`（用户提供的 `172.0.0.1:1095` 无监听；同一端口的 `socks5h` 握手失败，只有 HTTP 代理可用）
- 结论：P0-1/2/3 通过；**P0-4 通过（换模型后：Qwen3-4B-Instruct-2507 Q4，中英都高于基线）**；**P0-5 通过（换模型后：granite-embedding-97m-multilingual-r2，官方 int8 中英都不掉分）**

判定口径（沿用既有阈值，未放宽）：决策以远程 `gemma-3-4b-it` 的双语准确率为基线；嵌入以 `Qwen3-Embedding-0.6B` fp32 的双语检索为基线。任何档位只有中英都不低于基线才可作默认。

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

## P0-4 决策模型：两条陈述关系判定 —— **通过（换模型后）**

### 评估集与方法

- `.scratch/local/p0/decision_bilingual.json`：120 条人工标注用例，中文 60 + 英文 60，none/update/refute 各 20，中英一一对应（同一事实槽位）。
- 本地候选统一用 `llama.cpp`（`eval_gguf_decision.py`，`temperature=0`，`n_ctx=2048`，`n_threads=8`，`max_tokens=32`）；远程基线用 OpenAI 兼容端点（`eval_gemma_bilingual.py`）。
- 输出契约：4B 与远程基线用 `{"relation":"none|update|refute"}` 严格 JSON；1.7B/1B 用单词标签（小模型会把 JSON 的枚举模板原样复读，见下）。Laya 用其原生 typed question（`choice`）。
- 指标为准确率 + 三分类召回；延迟为单次调用墙钟（本机为共享机器，p50/p95 含噪声，见末节「测量噪声」）。

### 结果（实测）

| 模型 | 参数量 | 许可 | 发布 | 运行方式 | 中文 acc | 英文 acc | 中文召回 n/u/r | 英文召回 n/u/r | p50 中/英 | 峰值 RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `laya` multilingual | 322M | 见模型卡 | 2025 | CPU | 0.517 | 0.650 | .75/.00/.80 | .95/.15/.85 | 131/135 ms | — |
| `gemma-3-1b-it` Q4_K_M | 1.0B | Gemma | 2025-03 | CPU | 0.367 | 0.550 | .20/.05/.85 | .00/.70/.95 | 3.0/2.4 s | 1162 MB |
| `Qwen3-1.7B` Q8_0 | 2.03B | Apache-2.0 | 2025-04 | CPU | 0.900 | **0.883** | .90/1.00/.80 | .95/.75/.95 | 7.3/5.2 s | 2178 MB |
| **`Qwen3-4B-Instruct-2507` Q4_K_M** | 4.02B | Apache-2.0 | 2025-08 | CPU | **0.967** | **0.950** | .95/.95/1.00 | .90/.95/1.00 | 10.3/12.9 s | 4460 MB |
| `gemma-3-4b-it`（远程基线） | 4.30B | Gemma | 2025-02 | 远程 GPU | 0.900 | 0.833 | .90/.80/1.00 | .75/.75/1.00 | 网络往返 | — |

（n/u/r = none/update/refute 召回。延迟采样自同一台机器，期间有其它后台任务竞争。）

### 结论

- **Laya 不成立**：零样本无法区分 update 与 refute（中文 update 召回 0.00，英文 0.15），失败模式稳定复现；按现有 `{relation, target, confidence}` 契约不可用。这与「CPU 档退回规则判定」无关——是模型能力问题。
- **gemma-3-1b 不成立**：中英都远低于基线，且偏向 refute（中文 update 召回 0.05）。
- **Qwen3-1.7B Q8 可达标**：中文 0.900（等于基线）、英文 0.883（高于基线 0.833），中英都不掉分；代价是中文 update 之外仍有 refute 混淆（.80）与英文 update 召回 .75。
- **Qwen3-4B-Instruct-2507 Q4 为默认档**：中英都显著高于基线（+0.067 / +0.117），三分类召回最均衡，Q4_K_M 权重 2.33 GiB，CPU 纯回退可用（实测），4 GB 显存可放权重+2k KV。
- 未实测并因此**不纳入选型依据**：`Qwen3.5-4B` / `Qwen3.5-2B`（2026-02/03，Apache-2.0，4.66B / 2.27B）。`Qwen3.5` 在 transformers 4.57.6 中缺 `qwen3_5` 实现、本机 llama-cpp-python 0.3.36 亦不支持该 GGUF 架构；升依赖重编 llama.cpp 属于范围外改动，本机未做，按「未实测」处理。

## P0-5 嵌入模型：中英双语检索与量化档位 —— **通过（换模型后）**

### 评估集与方法

- 语料 `emb_corpus.py`：25 个主题 × 8 变体 = 200 条记忆单元，中文、英文各一套（同一主题的中英文本语义对应但不互译）；查询为每主题 1 条零词面重叠的改写，中英各 25 条。
- 指标：topic-level top-1 / top-5（25 条查询），以及量化档位与 fp32 的余弦（均值 / 最小）。
- 脚本：`eval_emb_torch.py`（transformers，CLS pooling）、`eval_emb_candidate.py`（ONNX，CLS pooling）。

### 结果（实测）

| 模型 / 档位 | 维度 | 权重体积 | 中文 top-1/top-5 | 英文 top-1/top-5 | 与 fp32 余弦（均值/最小） | 峰值 RSS |
| --- | --- | --- | --- | --- | --- | --- |
| `Qwen3-Embedding-0.6B` fp32 ONNX | 1024 | ≈2.4 GB | 0.640 / 0.760 | 0.640 / 0.760 | — | — |
| `Qwen3-Embedding-0.6B` ONNX 动态 int8 | 1024 | 600 MB | **0.040 / 0.240** | **0.120 / 0.400** | **0.145 / −0.031** | — |
| `Qwen3-Embedding-0.6B` ONNX 4-bit 权重 | 1024 | 1.79 GB | 0.640 / 0.720 | 未测 | 0.837 / −0.035 | — |
| `granite-embedding-278m-multilingual` fp32 | 768 | 556 MB | 0.960 / 1.000 | 1.000 / 1.000 | — | 2372 MB |
| `granite-embedding-311m-multilingual-r2` fp32 | 768 | 594 MB | 0.960 / 0.960 | 0.960 / 1.000 | — | 2410 MB |
| `granite-embedding-97m-multilingual-r2` fp32（torch / ONNX） | 384 | 186 MB / 390 MB | 0.920 / 1.000 | 0.960 / 0.960 | — | 1175 / 1249 MB |
| **`granite-embedding-97m-multilingual-r2` 官方 int8（`onnx/model_quint8_avx2.onnx`）** | 384 | **98 MB** | **1.000 / 1.000** | **0.920 / 1.000** | **0.967 / 0.929** | **848 MB** |

延迟（实测）：granite-97m-r2 单进程完成中英各 225 条文本（200 文档 + 25 查询）约 22 s → ≈48 ms/条（ONNX，8 线程，含其它后台任务竞争）。

### 结论

- **Qwen3-Embedding 的动态 int8 在两个语种上同时崩塌**（top-1 0.04 / 0.12，余弦 0.145 / 0.206），不是单语问题；其激活离群值不可用 naive int8 承载。权重-only 4-bit 中文保住了 top-1，但余弦尾部到 −0.035，且英文未测，不能作默认。
- **granite R2 解决了这个问题**：官方 int8 档中英 top-1/top-5 与 fp32 同级（中文 1.000/1.000，英文 0.920/1.000），逐条余弦均值 0.967、最小 0.929，没有崩塌；权重 98 MB，进程 RSS 848 MB。
- **建议默认档**：`granite-embedding-97m-multilingual-r2` 官方 int8（384 维）。fp32 同级（390 MB / 1249 MB RSS）可作为无 int8 运行时的回退；`311m-r2`（768 维）在中文 top-5 上略高，但内存约为其 3 倍，只作可选升级。
- `granite-embedding-278m-multilingual`（2024-12，Apache-2.0）在同语料上同样达标，是中英双语对比的保底替代；但它不属于 2025–2026 候选。
- **未实测**：`EmbeddingGemma-300M`（2025-07，Gemma 许可，`gated=manual`）。代理到手后仍需在 HF 侧接受条款并持有 token，本机直接 403/307；按指示改用上面 granite 系列完成对比，不阻塞整体进度。`EmbeddingGemma 2`（740M）仅在检索中见到条目，未取得可下载资产，未实测。

## 选型建议（最终档位）

| 角色 | CPU 档（默认关闭，开启后） | GPU 档（8 GB） |
| --- | --- | --- |
| `decision` | `Qwen3-4B-Instruct-2507` Q4_K_M（2.33 GiB，中 0.967 / 英 0.950）；纯 CPU 实测 p50 约 10 s/次 | 同模型 Q4/Q5 上 GPU，或沿用远程 `gemma-3-4b-it` |
| `embedding` | `granite-embedding-97m-multilingual-r2` 官方 int8（98 MB，384 维，中 1.000/1.000、英 0.920/1.000） | 同模型 fp32（或 fp16），或 `311m-r2` |
| `extraction` | 复用 `decision` 的 4B 权重（单槽 LRU，`decision > extraction`） | 同左 |
| `assistant` | 不配置（维持现状） | 不配置（维持现状） |

两项硬门槛都满足「中英都不低于基线」与「CPU 档可用」，且不引入无法接受的新依赖：决策侧只需 GGUF + llama.cpp（或后续换 ONNX/llama.cpp server），嵌入侧只需 onnxruntime + tokenizers。

## 测量噪声与口径说明

- 决策延迟来自同一台 12 核共享机器，期间并发跑过嵌入评测，单次调用墙钟波动大（4B 的 p50 从 10 s 到 32 s 都出现过，p95 最高 120 s）。上表取的是「无重并发时」的一轮完整 120 例：4B p50 10.3/12.9 s、p95 19.1/25.2 s。目标机器空闲时的绝对值应低于此。
- 4B 早期一轮用 `n_threads=12` 且与两个嵌入评测并发，中文 p50 32 s、p95 120 s，已作废，不作为选型依据。
- 决策的提示契约不同（4B/远程用 JSON，小模型用单词标签）是能力适配，不是阈值放宽；两者都要求严格单值输出。
- `Qwen3-Embedding-0.6B` 的 4-bit 英文档、`granite-311m-r2` 的 int8 档未测，按「未实测」处理，未用于任何结论。

## 尚需裁定的事项

1. **spec §26.9.1 / §26.11 的量化假设需要改**：原文假设「int8 ONNX ≈0.6 GB、掉 0.3–1 分」并绑定 Qwen3-Embedding；实测该假设不成立。建议改为「默认 `granite-embedding-97m-multilingual-r2` int8（98 MB、384 维）；Qwen3-Embedding 仅在权重-only 4-bit 下可用且英文待测」。
2. **spec §12 的 prefill 估算**：改为「6k 冷约 1.7 s、同前缀约 0.2 s」。
3. **决策默认档**：CPU 档由原计划的 Laya 改为 `Qwen3-4B-Instruct-2507` Q4；若某 Member 明确要求低延迟且接受更低召回，可显式降到 `Qwen3-1.7B` Q8（中 0.900 / 英 0.883）。
