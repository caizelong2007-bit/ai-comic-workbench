# 短剧连续性状态层与变体资产开发说明

## 版本目标

本次开发实现第一阶段能力：在分镜脚本、资产提取、提示词包生成之间增加“连续性状态层”，用于记录角色服装/持物、场景层级、道具归属、关系进展和变体资产候选。

核心原则：

- 不替代 `shot.assetRefs`。分镜参考图仍以 `shot.assetRefs` 为准。
- 不改变视频模型请求结构。Seedance/API/Runway 插件的提交格式保持原样。
- 不自动生成变体资产图。第一阶段只生成 `variantCandidates`，由用户后续决定是否转为真实资产。
- 用户编辑连续性状态后，相关提示词包和视频会被标记为需要重新生成。
- 变体候选不是模型自由发挥结果。模型必须先输出 `stateChanges`，后端再按资格规则过滤，只有真正稳定可复用的新视觉形态才保留为 `variantCandidates`。

## 流程位置

```text
分集剧本
  -> 分镜脚本
  -> 连续性状态层
  -> 分镜资产提取
  -> Seedance 提示词包
  -> 视频生成
```

连续性状态层不直接决定哪些参考图提交给视频模型，而是给资产提取和提示词包生成提供上下文。例如：

- Benson 已经穿上盔甲。
- 当前场景是铁匠铺外侧，但父级场景仍属于大地图。
- 龙蛋被 Benson 抱在左臂，而不是独立摆在地上。
- 上一镜门被撞开，后续镜头需要继承破损状态。

## 数据结构

每集新增 `episode.continuityStates`：

```json
{
  "id": "CONT-SH01",
  "shotId": "SH01",
  "summary": "当前镜头中已经成立的状态摘要",
  "characters": [
    {
      "assetId": "CHAR01",
      "activeVariantId": "",
      "wearing": ["PROP05"],
      "holding": ["PROP06"],
      "carrying": [{ "assetId": "PROP01", "position": "左臂抱住" }],
      "emotion": "警惕",
      "pose": "半蹲",
      "injury": "",
      "location": "铁匠铺外侧碎石区"
    }
  ],
  "location": {
    "primaryAssetId": "LOC04",
    "parentAssetIds": ["LOC01"],
    "zone": "铁匠铺外侧",
    "damageState": "木门被撞开"
  },
  "props": [
    {
      "assetId": "PROP01",
      "ownerAssetId": "CHAR01",
      "position": "Benson 左臂",
      "state": "持续发光"
    }
  ],
  "relations": [
    {
      "fromAssetId": "CHAR01",
      "toAssetId": "CHAR04",
      "type": "trust",
      "state": "小龙蜥仍保持警惕"
    }
  ],
  "continuity": {
    "fromPrevious": "承接上一镜的状态",
    "toNext": "为下一镜留下的状态"
  },
  "stateChanges": [
    {
      "assetId": "CHAR01",
      "changeType": "wardrobe_equipment",
      "description": "Benson 穿上新手套装",
      "persistence": "multi_shot",
      "visualImpact": "high",
      "promptLayer": "variant_candidate",
      "needsVariantAsset": true
    },
    {
      "assetId": "CHAR04",
      "changeType": "pose_emotion",
      "description": "小龙蜥警惕探头",
      "persistence": "single_shot",
      "visualImpact": "low",
      "promptLayer": "video_prompt_state",
      "needsVariantAsset": false
    }
  ],
  "variantCandidates": [
    {
      "baseAssetId": "CHAR01",
      "sourceChangeType": "wardrobe_equipment",
      "name": "Benson 新手盔甲形态",
      "reason": "装备状态会持续多个镜头",
      "priority": "medium",
      "status": "suggested"
    }
  ]
}
```

## 模型与后端分工

模型负责判断：

- 哪些状态会影响后续镜头连续性。
- 某个角色是否正在穿戴、持有或携带某个资产。
- 当前小场景与父级场景的关系。
- 某个状态变化属于哪一种 `changeType`，持续多久，视觉影响多大，应该进入连续性状态、视频提示词，还是变体候选。

后端负责稳定性：

- 只保留项目资产库中真实存在的资产 ID。
- 将连续性状态按 `shotId` 合并保存。
- 分镜脚本重新生成时清空旧连续性状态，避免状态错位。
- 手动编辑或重新生成连续性状态后，将对应提示词包和视频标记为过期。
- 删除资产时同步清理连续性状态里的无效引用。
- 对变体候选做硬过滤：即使模型输出了不合格候选，也会降级为状态变化，不进入 `variantCandidates`。

## 变体资产资格规则

底层判断不是“这一镜里看起来有变化就生成变体”，而是：

```text
基础资产：这个东西是谁/是什么。
连续性状态：当前它处于什么状态。
变体资产：它是否进入了一个可复用的新稳定外观。
```

只有同时满足以下条件，才允许进入变体候选：

1. 外观变化是稳定的，不是单镜头动作。
2. 变化会持续多个分镜或至少一段剧情。
3. 变化会明显影响角色、场景或道具识别。
4. 仅靠原资产参考图加视频提示词，难以稳定复现。
5. 生成一张新参考图后，后续复用价值明显。

允许进入变体候选的 `changeType`：

- `wardrobe_equipment`：换装、穿盔甲、戴面具、装备形态。
- `transformation`：变身、升级、黑化、觉醒、体型变化。
- `persistent_damage`：持续多镜头的伤痕、破损、污染。
- `prop_phase_change`：核心道具裂开、启动、进化、形态变化。
- `location_structural_change`：场景结构被炸毁、重建、永久打开/坍塌。

不允许进入变体候选的内容：

- 动作：探头、跳舞、奔跑、摔倒。
- 情绪：警惕、害怕、尴尬、愤怒。
- 姿态：蹲下、伸手、回头、持剑。
- 临时效果：落灰、发光增强、烟雾、火光、震动。
- 轻微脏污：沾灰、汗水、泥点。
- 镜头语言：特写、推近、跟拍、摇镜。
- 临时持物位置：左手抱住、右手拿着、放在脚边。

后端最终过滤条件：

```text
eligible =
  changeType 属于允许列表
  且 persistence 是 multi_shot 或 episode_arc
  且 visualImpact 是 medium 或 high
  且 needsVariantAsset = true
```

补充的后端推导规则：

```text
如果 characters[].wearing 中出现可穿戴装备资产，
且穿戴者是角色资产，
则后端可以自动生成“角色 + 装备形态”的变体候选。
```

这条规则用于避免模型漏写 `stateChanges` 时丢掉真正有生产意义的变体。例如：

```text
CHAR01 Benson wearing PROP05 新手套装
-> Benson 新手套装形态
```

但这条规则只适用于穿戴/换装/装备组合，不适用于：

- 手持道具：Benson 手持剑。
- 携带道具：Benson 抱着龙蛋。
- 姿态动作：Benson 跳舞、探头、摔倒。
- 临时脏污或光效：沾灰、发光、震动。

例如：

- `Benson 新手套装形态`：保留为变体候选。
- `Benson 新手套装沾灰形态`：通常降级为连续性状态或视频提示词。
- `野生方块小龙蜥警惕探头形态`：降级为视频提示词状态。
- `紫色龙蛋脉冲加快`：通常降级为提示词，除非变成“裂纹龙蛋形态”。
- `铁匠铺震动落灰`：通常降级为场景状态，除非变成“被毁后的铁匠铺”。

## 前端交互

分镜制作页新增：

- 顶部“生成连续性状态”按钮：批量生成当前剧集所有分镜状态。
- 每个分镜脚本卡片下方的连续性状态面板：
  - 未生成时显示“生成状态”。
  - 生成中显示独立 loading。
  - 失败时保留失败状态并允许重试。
  - 已生成时只展示摘要、承接/转出和若干状态标签。
- 编辑弹窗：
  - 摘要、承接上镜、引向下镜为普通文本。
  - 角色、场景、道具、关系、变体候选使用 JSON 文本框。
  - 保存后写入后端，并标记该分镜提示词包和视频需要更新。

## 与下游模块的关系

资产提取：

- 读取 `continuityStates`，理解“Benson 穿着盔甲”这类关系。
- 资产引用仍写入 `shot.assetRefs`。
- 不因为连续性状态存在就强制把所有相关资产都塞入参考图。

提示词包生成：

- 读取 `continuityStates`，把角色、装备、持物、场景层级表达成关系，而不是孤立资产堆叠。
- 不新增资产库不存在的资产。
- 不改变最终提交给视频模型的请求字段。

视频生成：

- 继续使用现有提示词包和参考图列表。
- 连续性状态不作为独立字段提交给视频模型，只影响提示词包内容。

## 验收方案

基础验收：

1. 进入一个已有项目和剧集，确保已生成分镜脚本。
2. 点击“生成连续性状态”，页面不应卡住，每个分镜能显示状态摘要。
3. 刷新页面后，连续性状态仍然存在。
4. 点击单个分镜的编辑按钮，修改摘要或 JSON，保存后能回显。
5. 保存后，对应提示词包或视频应出现需要更新的提示。

下游验收：

1. 对已有连续性状态的分镜执行“提取资产”，确认不报错。
2. 生成提示词包，确认提示词包仍保持原有结构。
3. 不调用视频模型也可以通过导出提示词包检查最终内容是否变化。

删除验收：

1. 删除某个资产库资产。
2. 确认分镜资产引用、提示词包引用和连续性状态中的该资产 ID 都被移除。
3. 不影响其他资产和其他分镜状态。

## 回滚方式

如果需要撤销该功能：

1. 回退 `server.js` 中 `/api/generate/continuity`、`/api/continuity/save`、连续性 prompt、normalize 和下游 prompt 注入逻辑。
2. 回退 `public/index.html` 中连续性按钮和编辑弹窗。
3. 回退 `public/app.js` 中连续性状态渲染、编辑、API 调用和 job 映射。
4. 回退 `public/styles.css` 中 `.continuity-*` 样式。
5. 已保存项目中的 `episode.continuityStates` 可以保留；旧版本会忽略该字段。
