# 分镜剪辑连续性与运镜标准

## 背景

动态分镜时长已经可以根据剧情容量生成 5-15 秒片段，但实际视频验收发现一个新的问题：每个分镜内部内容基本合理，分镜之间在剪辑逻辑上仍可能割裂。

典型问题：

```text
SH04：Benson 掉入矿洞。
SH05：Benson 直接开始挖紫水晶。
```

观众期望的剪辑逻辑应该是：

```text
SH04：Benson 掉入矿洞，倒在碎石堆上，尘土散开，远处出现紫光。
SH05：Benson 在洞底醒来，咳嗽，摸到木镐，顺着紫光抬头，发现紫水晶，再靠近。
```

本需求追求的不是不同视频片段首尾帧完全无缝，而是正常剪辑语言下的叙事顺畅：因果合理、动作承接合理、镜头进入方式合理、剪辑省略有依据。

## 目标

1. 分镜之间具备清晰的叙事因果。
2. 每个分镜知道自己如何进入、表达什么、如何结束。
3. 正常剪辑手法可以被明确表达，而不是全部强行连续。
4. 运镜服务于剧情动机，避免无意义推近、环绕、升镜头。
5. 提示词包生成时优先覆盖开头承接、核心动作、结尾状态。
6. 不改变现有视频生成 API 请求结构。

## 核心数据结构

后续分镜脚本建议增加以下字段。

```json
{
  "id": "SH05",
  "durationSec": 12,
  "cutRelation": "continuous_action",
  "entryBeat": "Benson 倒在矿洞碎石堆上，咳嗽醒来，摸索掉在旁边的木镐。",
  "mainBeat": "他顺着紫光抬头，发现石壁里的紫色晶石，小心靠近。",
  "exitBeat": "Benson 举起木镐，停在即将敲下第一下的瞬间。",
  "cameraMotivation": "从摔落后的主观混乱转向关键道具揭示。",
  "pace": "impact_pause",
  "ellipsis": "none",
  "continuityCheck": "承接上一镜摔落结果；不能直接站立挖矿。"
}
```

## 剪辑关系

`cutRelation` 用来描述当前分镜和上一分镜的剪辑关系。

| 类型 | 用途 | 要求 |
| --- | --- | --- |
| `continuous_action` | 连续动作承接 | 必须有明确 `entryBeat`，承接上一镜 `exitBeat` |
| `reaction_cut` | 角色反应镜头 | 开头应先表现看到/听到/意识到什么 |
| `match_cut` | 动作、构图或方向匹配剪辑 | 需要说明匹配对象，例如手部动作、视线方向、运动方向 |
| `time_cut` | 合理省略时间 | 必须说明省略了什么，以及当前镜头从什么结果状态开始 |
| `location_cut` | 场景切换 | 需要重新建立场景，但要说明与上一场的因果关系 |
| `montage` | 蒙太奇压缩 | 必须是多个低风险动作压缩，不承载复杂关键剧情 |
| `reveal_cut` | 揭示/反转剪辑 | entry 可以制造悬念，main 必须揭示新信息 |

## 运镜动机

每个分镜需要有 `cameraMotivation`，避免“为了动而动”。

推荐枚举：

- `follow_action`：跟随角色移动。
- `reveal_information`：揭示新信息或关键道具。
- `emphasize_threat`：强化威胁压迫。
- `show_reaction`：突出情绪反应。
- `guide_attention`：引导视线到关键物体。
- `build_suspense`：制造悬念。
- `impact_aftershock`：冲击后的停顿和恢复。
- `spatial_establish`：建立场景空间关系。

## 剪辑节奏

`pace` 用于控制片段内部节奏。

| 类型 | 用途 |
| --- | --- |
| `slow_tension` | 慢速悬念、观察、靠近 |
| `normal_action` | 标准动作推进 |
| `quick_panic` | 慌乱、追逐、逃跑 |
| `impact_pause` | 摔落、爆炸、冲击后的停顿 |
| `montage_fast` | 采集、奔跑、准备等快速压缩 |
| `emotional_hold` | 情绪停留、反应特写 |

## 省略方式

`ellipsis` 用于说明剪辑是否省略过程。

| 类型 | 用途 | 限制 |
| --- | --- | --- |
| `none` | 不省略，直接承接 | 下一镜必须接上一镜结果 |
| `slight` | 省略几秒无效动作 | 只能省略起身、转身、走几步等低信息动作 |
| `clear_time_jump` | 明确时间跳切 | 需要在 entryBeat 说明跳切后的状态 |
| `montage_compression` | 蒙太奇压缩 | 不适合关键情绪或关键因果动作 |

## 模型负责什么

LLM 适合判断具有语义和创作性的内容：

1. 判断分镜之间的剪辑关系。
2. 为每个分镜生成 `entryBeat / mainBeat / exitBeat`。
3. 判断哪些过程可以省略，哪些必须承接。
4. 选择合理的运镜动机和剪辑节奏。
5. 在提示词包中把 entry/main/exit 分配到 subShots。
6. 在复杂剧情中判断何时使用 reaction cut、match cut、montage、reveal cut。

LLM 生成要求：

- 不能只写本镜头核心动作，必须写开头承接和结尾状态。
- 如果使用时间省略，必须说明省略原因和跳切后的状态。
- 如果上一镜是摔倒、昏迷、被击退、传送、爆炸、坠落，下一镜不能直接进入复杂操作，必须先恢复/醒来/确认环境。
- 如果上一镜揭示新信息，下一镜必须先有发现或反应，再进入操作。

## 后端负责什么

后端负责确定性校验和稳定兜底，避免每次换剧本效果大幅波动。

### 1. 字段归一化

如果 LLM 没返回新字段，后端补默认值：

```text
cutRelation: 根据场景是否变化、动作是否连续推断
entryBeat: 从上一镜 exitBeat 或当前 action 前半段生成简短承接
mainBeat: 当前 action
exitBeat: 当前 action 的结果状态
cameraMotivation: 默认 follow_action 或 reveal_information
pace: 根据动作密度估算
ellipsis: 默认 none
```

### 2. 连续性校验

后端检查明显不合理的剪辑断层：

- 上一镜 `exitBeat` 包含摔倒/坠落/昏迷/被击退，下镜 `entryBeat` 不能为空。
- `continuous_action` 必须有 entryBeat，并且不能从全新状态开始。
- `time_cut` 必须有 ellipsis 说明。
- `montage` 不能承载关键反转、关键道具首次出现、角色重大决定。
- 下一镜如果直接使用关键道具，上一镜或本镜 entry 必须先建立发现/接近/拿起。

### 3. 提示词包兜底

提示词包生成时，后端应保证：

- 第一个 subShot 覆盖 `entryBeat`。
- 中间 subShots 覆盖 `mainBeat`。
- 最后一个 subShot 覆盖 `exitBeat`。
- 若 subShots 没覆盖 entry/main/exit，后端在 seedancePrompt 中补入对应描述。
- timeRange 仍按 durationSec 校验，不允许超过片段时长。

### 4. 稳定性策略

- 后端不做复杂创作重写，只做规则校验和缺省补齐。
- 对明显冲突的字段增加 warning 或自动标记 stale，而不是静默生成不合理视频。
- 用户手动编辑过的分镜不自动覆盖，只在重新生成分镜/提示词包时应用新标准。

## 前端展示与编辑

前端一级页面不展示所有长文本，避免页面拥挤。

建议：

- 分镜卡片仍显示摘要、时长、资产、提示词状态。
- 右上角编辑入口进入弹窗。
- 弹窗中增加剪辑信息区域：
  - 剪辑关系
  - 开头承接
  - 核心动作
  - 结尾状态
  - 运镜动机
  - 节奏
  - 省略方式
  - 连续性提示

手动修改保存后：

- 分镜提示词包标记为 stale。
- 重新生成提示词包时使用修改后的剪辑字段。
- 不直接影响资产库和视频 API 适配器。

## 与现有流程关系

现有流程保持：

```text
分集剧本
-> 分镜脚本
-> 资产提取
-> Seedance 提示词包
-> 视频生成
```

新增剪辑字段位于“分镜脚本”层，并传递到“Seedance 提示词包”层。

不变内容：

- 资产提取逻辑不变。
- 资产库不变。
- Prompt Mention 编辑器不变。
- Seedance/APIMart/Runway 请求结构不变。
- 视频生成仍然使用 prompt + reference assets + duration。

## 当前落地范围

本阶段已按文档实现以下能力：

- 分镜生成 prompt 要求输出 `cutRelation / entryBeat / mainBeat / exitBeat / cameraMotivation / pace / ellipsis / continuityCheck`。
- 后端在 `normalizeShots` 与旧项目读取时补齐上述字段，避免旧数据无法进入新流程。
- 多分镜压缩合并时保留入镜、核心动作、出镜和剪辑字段。
- Seedance 提示词包生成 prompt 明确要求按 entry/main/exit 组织 subShots。
- 后端默认 subShots 兜底会把第一个小片段分配给 entryBeat，中间分配给 mainBeat，最后分配给 exitBeat。
- Seedance prompt 基础文本会包含剪辑关系、节奏、省略方式、入镜、核心动作、出镜和运镜动机。
- 分镜编辑弹窗支持查看和修改剪辑字段；保存后会让对应提示词包和视频进入 stale 状态。
- 提示词包导出会包含新的剪辑字段，便于后续人工验收和外部调试。

暂未改变：

- 视频生成 API 请求字段。
- 资产提取规则。
- 资产库结构。
- Prompt Mention Editor 的交互。

## 验收样例

### 错误效果

```text
SH04：Benson 掉入洞里。
SH05：Benson 站在洞里，直接开始挖紫水晶。
```

### 期望效果

```text
SH04 exitBeat：
Benson 摔在矿洞碎石堆上，尘土散开，前方石壁透出微弱紫光。

SH05 entryBeat：
Benson 咳嗽醒来，摸到掉在旁边的木镐，扶着碎石慢慢坐起。

SH05 mainBeat：
他顺着紫光抬头，看见石壁里的紫色晶石，小心靠近。

SH05 exitBeat：
Benson 举起木镐，犹豫后准备敲下第一下。
```

验收标准：

- 观众能理解上一镜和下一镜的因果关系。
- 不要求首尾帧完全无缝。
- 不出现“摔倒后直接站好执行复杂动作”的跳跃。
- 运镜与剧情动机一致。
- subShots 时间段覆盖 entry/main/exit。
