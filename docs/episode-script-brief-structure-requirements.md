# 分集故事意图与 AI 结构化剧本需求

## 背景

当前工作台从分镜脚本开始的后半段流程已经相对稳定：

```text
分镜脚本
↓
资产提取
↓
Seedance 分镜提示词包
↓
视频生成
```

但分集剧本模块里，人工输入、AI 生成、结构化剧本之间的边界还不够清晰。现有流程既支持手动输入分集剧本，也支持 LLM 生成分集剧本，但“用户只提供本集大概意图，AI 负责扩写和结构化”的产品定位还没有明确固化。

本需求的目标是把分集剧本模块改成一个清晰的“故事意图 → AI 编剧整理 → 结构化剧本”入口，同时不影响已经跑通的下游流程。

## 核心原则

1. 用户不需要手动维护复杂结构化剧本。
2. 用户只需要讲清楚本集想表达的剧情意图、关键桥段、必须保留的角色/道具/结尾。
3. AI 负责润色、扩写、容量控制、承接上一集、对齐项目总剧本，并输出结构化 `episode.script`。
4. 如果用户没有输入意图，AI 可以基于项目总剧本和上一集内容自动构思本集意图并结构化剧本。
5. 下游流程继续读取 `episode.script`，不改分镜、资产、提示词、视频生成主逻辑。

## 不改范围

本需求只改分集剧本模块，不改以下模块的主逻辑：

```text
分镜生成
资产提取
Seedance 提示词包生成
视频生成
参考图上传
视频模型 payload
```

分镜生成仍然读取：

```js
episode.script
```

## 用户流程

### 新建剧集

点击“新建剧集”时：

```text
直接创建空白剧集
不调用 LLM
不自动生成剧本
不阻塞页面
```

新建后的剧集状态：

```json
{
  "brief": "",
  "script": null,
  "scriptStatus": "empty",
  "selectedBeats": [],
  "deferredBeats": [],
  "capacityNote": ""
}
```

### 人工编剧模式

```text
创建空白剧集
↓
用户输入本集故事意图
↓
点击“生成/完善剧本”
↓
AI 按用户意图扩写、容量控制、结构化
↓
用户审核结构化剧本
↓
生成分镜脚本
```

用户输入示例：

```text
这一集 Benson 被吸进 MC 世界，发现龙蛋是回现实的关键，但末影龙发现了他。
```

AI 需要将其整理成：

```text
本集摘要
本集目标
关键场景
关键台词
结尾钩子
本集采用内容
后续延后内容
容量说明
结构化 scenes
```

### 流水线模式

如果用户没有输入本集故事意图，点击“生成/完善剧本”时：

```text
AI 根据项目总剧本、上一集剧本、上一集结尾钩子、已有资产自动构思本集意图
↓
AI 再扩写和结构化剧本
↓
保存 episode.brief 和 episode.script
```

这样后续可以支持“一键生成下一集”的流水线能力。

## 前端交互

分集剧本页建议拆成两个核心区域。

### 本集故事意图区

字段：

```text
本集故事意图 textarea
```

说明文案：

```text
可选。填写后 AI 会按你的方向完善；不填写则 AI 会根据项目总剧本和上一集自动续写。
```

按钮：

```text
保存意图
生成/完善剧本
```

### AI 结构化剧本区

展示：

```text
本集摘要
本集目标
关键场景
关键台词
结尾钩子
本集采用内容
后续延后内容
容量说明
剧本来源模式
```

按钮：

```text
保存结构化剧本
重新整理
生成分镜脚本
```

## 状态与反馈

### 剧本状态

建议状态：

```text
empty        未填写意图，也没有结构化剧本
brief_saved  已保存意图，待 AI 整理
structuring  AI 正在整理剧本
structured   剧本已结构化
stale        意图已修改，结构化剧本待重新整理
failed       剧本整理失败
```

### 生成中反馈

点击“生成/完善剧本”后：

```text
按钮显示：生成中...
剧本预览区显示：AI 正在整理本集剧本，可继续浏览其他模块
运行记录显示：分集剧本整理中
```

页面不能卡死：

```text
不锁整个工作台
只锁当前剧集的“生成/完善剧本”按钮
允许用户切换剧集、查看资产、查看项目设置
生成完成后刷新当前剧集状态
```

### 重复点击

如果同一剧集正在生成：

```text
返回已有 job 状态
不重复调用 LLM
不重复扣费
```

### 刷新页面

如果生成过程中刷新页面：

```text
重新进入后仍显示生成中
```

如果超过合理时间，例如 20 分钟：

```text
自动标记为失败/超时
提示用户重新生成
```

可复用现有 prompt job 的超时和恢复机制。

## 数据结构建议

给 episode 增加字段：

```json
{
  "brief": "用户输入或 AI 自动构思的本集故事意图",
  "briefUpdatedAt": "2026-06-03T00:00:00.000Z",
  "script": {},
  "scriptStatus": "empty | brief_saved | structuring | structured | stale | failed",
  "selectedBeats": [],
  "deferredBeats": [],
  "capacityNote": "",
  "scriptSourceMode": "manual | brief_guided | auto_continue",
  "scriptStructuredAt": "2026-06-03T00:00:00.000Z",
  "scriptAdapterError": ""
}
```

字段说明：

- `brief`：本集故事意图。用户填写时来自用户；用户不填时可由 AI 自动生成。
- `script`：AI 整理后的结构化剧本，沿用现有结构。
- `scriptStatus`：剧本整理状态。
- `selectedBeats`：AI 判断本集采用的剧情点。
- `deferredBeats`：AI 判断延后到后续集的剧情点。
- `capacityNote`：本集容量取舍说明。
- `scriptSourceMode`：结构化剧本来源。

## 后端接口建议

### 创建空白剧集

现有创建剧集接口调整为：

```http
POST /api/episodes
```

行为：

```text
只创建空白 episode
不调用 LLM
不生成 script
```

### 保存本集故事意图

新增：

```http
POST /api/episodes/brief
```

请求：

```json
{
  "episodeId": "EP01",
  "brief": "这一集 Benson 被吸进 MC 世界，发现龙蛋是回现实的关键。"
}
```

行为：

```text
保存 episode.brief
如果已有 script 且 brief 发生变化，scriptStatus = stale
如果没有 script，scriptStatus = brief_saved
不清空下游内容，除非用户确认重新整理后进入新流程
```

### 生成/完善结构化剧本

新增：

```http
POST /api/episodes/structure-script
```

行为：

```text
读取 episode.brief
如果 brief 非空：brief_guided
如果 brief 为空：auto_continue
调用 LLM
保存 episode.brief、episode.script、selectedBeats、deferredBeats、capacityNote
scriptStatus = structured
```

## LLM 输出结构

```json
{
  "brief": "AI 优化或自动构思后的本集故事意图",
  "script": {
    "title": "string",
    "logline": "string",
    "synopsis": "string",
    "previousRecap": "string",
    "episodeGoal": "string",
    "endingHook": "string",
    "continuityNotes": "string",
    "scenes": [
      {
        "id": "SC01",
        "title": "string",
        "location": "string",
        "timeOfDay": "string",
        "mood": "string",
        "action": "string",
        "narration": "string",
        "dialogue": [
          { "speaker": "string", "text": "string" }
        ],
        "visualNotes": "string"
      }
    ]
  },
  "selectedBeats": ["string"],
  "deferredBeats": ["string"],
  "capacityNote": "string",
  "sourceMode": "brief_guided | auto_continue"
}
```

## LLM 结构化要求

提示词应明确：

```text
用户只提供故事意图，你需要整理成适合 6-10 个 15s 分镜的分集剧本。
不要把所有用户想法都塞进本集。
根据目标时长控制容量。
把超量内容放入 deferredBeats。
非台词说明用中文。
台词按项目对白语言。
保持项目主线与上一集连续。
输出现有 script 结构，不改变下游字段。
```

如果用户提供 brief：

```text
用户意图是本集优先方向，必须保留核心事件。
如果内容过多，只选择最适合本集时长的部分，其余放入 deferredBeats。
不要偏离项目总剧本和上一集状态。
```

如果用户未提供 brief：

```text
用户没有提供本集意图。
请根据项目总剧本、上一集内容、上一集结尾钩子、项目已有资产，自动构思本集故事意图。
本集要承接上一集，并为下一集留下钩子。
```

## 容量控制

结构化阶段就要控制单集容量，不应等到分镜生成后才压缩。

建议规则：

```text
一集通常承载 6-10 个主要剧情 beat
每个 15s 分镜承载 1 个主要剧情推进点
每个 15s 分镜包含 1-2 个连续动作
每个 15s 分镜包含 0-1 句短台词
超过容量的内容进入 deferredBeats
```

AI 应输出：

```text
本集采用内容 selectedBeats
后续延后内容 deferredBeats
容量说明 capacityNote
```

## 分镜生成入口

分镜生成主逻辑不改，但入口增加提示。

如果：

```text
episode.scriptStatus !== structured
```

提示：

```text
当前分集剧本尚未经过 AI 整理，建议先点击“生成/完善剧本”。继续生成将使用当前旧剧本或故事意图。
```

第一版建议允许继续，不强制拦截，避免影响现有流程。

## 旧项目兼容

旧项目没有 `brief` 或 `scriptStatus` 时：

```text
如果 episode.script 存在 → 视为 structured
如果 episode.synopsis 存在但 episode.script 不存在 → 可视为 brief_saved
如果都没有 → empty
```

旧的 `episode.synopsis` 可迁移或映射为 `brief`。

## 风险控制

1. 不改变下游字段结构。
2. 不改变分镜生成的输入字段名，仍然使用 `episode.script`。
3. 不删除旧剧本，brief 修改只标记 stale。
4. AI 整理失败时保留旧 script。
5. 新建剧集不调用 LLM，避免创建时卡顿或无反馈等待。

## 验收标准

1. 新建剧集立即成功，不触发 LLM。
2. 用户填写 brief 后可保存。
3. brief 为空时，点击“生成/完善剧本”可自动根据项目和上一集续写。
4. brief 非空时，点击“生成/完善剧本”按用户意图生成结构化剧本。
5. 生成过程中页面不锁死，有明确 loading 和运行记录。
6. 刷新页面后能恢复生成中/失败/完成状态。
7. 结构化剧本保存到 `episode.script`。
8. 下游分镜生成仍然可正常使用，不改资产/提示词/视频流程。
9. 修改 brief 后已有结构化剧本标记为 stale。
10. 旧项目仍可打开和继续生成。
