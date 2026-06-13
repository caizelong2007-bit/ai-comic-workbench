# 分镜资产与提示词包流程需求

## 背景

当前工作台的后半段生产链路已经基本跑通：

```text
分镜脚本
-> 分镜资产
-> Seedance 提示词包
-> 视频生成请求
```

但在实际验收中出现了一个主从关系混乱的问题：前端分镜制作页中间的“资产”栏，在已有提示词包时优先展示 `promptPackage.assetRefs`，而不是 `shot.assetRefs`。

这会造成倒挂：

```text
分镜脚本已经提取到某个资产
shot.assetRefs 已经包含该资产
但旧提示词包没有引用该资产
于是前端资产栏也不显示该资产
```

例如《龙蛋领主》第 2 集 SH03：

```text
分镜脚本：Benson 冲到半塌的废弃铁匠铺前，撞开木门并滚入室内
shot.assetRefs：包含 LOC04 废弃铁匠铺
promptPackage.assetRefs：仍使用旧的 LOC01 三国边境大世界，没有 LOC04
前端资产栏：显示提示词包资产，因此看起来像没有提取铁匠铺
```

这会让用户误判资产提取失败，也会让后续视频生成不一定使用正确的一致性参考。

## 核心目标

1. 明确分镜脚本、分镜资产、提示词包、视频请求之间的生产顺序和主从关系。
2. 让画面一致性以项目资产库和分镜资产为核心，而不是由提示词包反向决定。
3. 保证用户看到的资产列表就是本分镜真实确认过的资产列表。
4. 提示词包只作为下游派生数据，不得反向覆盖分镜资产。
5. 有参考图资产用于 `image_urls`，无参考图资产仍可作为文本语义资产进入提示词。
6. 当分镜资产发生变化时，明确提示词包和视频结果需要重新生成，避免所见和实际提交不一致。

## 数据职责

### 项目资产库

项目资产库是项目级一致性的基础，包含角色、场景、道具。

来源：

```text
LLM 从剧本/分镜中提取
用户手动添加
资产生成时补充
历史剧集复用
```

作用：

```text
提供稳定资产 ID
维护别名、描述、提示词、参考图
跨剧集复用，保证角色、场景、道具一致
```

项目资产库中的资产可以没有参考图。没有参考图不代表资产无效，只代表它暂时不能作为视频模型的图片参考。

### 分镜脚本

分镜脚本是“这一镜要拍什么”的源头。

关键字段：

```text
camera
action
entryBeat
mainBeat
exitBeat
dialogue
assetNotes
visualNotes
continuity
```

职责：

```text
定义本镜画面内容和剪辑意图
提供资产提取依据
不直接决定最终 image_urls
```

### 分镜资产

分镜资产是“这一镜应该优先使用哪些资产保持一致性”。

保存位置：

```text
shot.assetRefs
```

来源：

```text
LLM 资产提取
项目资产库语义复用
本地资产名/别名/提示词匹配
用户手动添加或删除
```

职责：

```text
作为本分镜资产主数据
驱动提示词包生成
驱动用户可视化审核
记录哪些稳定资产应参与本镜画面一致性
```

规则：

```text
shot.assetRefs 是主数据
promptPackage.assetRefs 不得反向覆盖 shot.assetRefs
无参考图资产仍可出现在 shot.assetRefs
用户在分镜资产栏添加/删除资产，只影响本分镜，不删除项目资产库
```

### 提示词包

提示词包是“把分镜脚本和分镜资产翻译成视频模型可执行内容”。

保存位置：

```text
episode.promptPackages[]
```

输入：

```text
shot
shot.assetRefs
项目资产库
资产参考图
项目风格
视频模型 profile
```

输出：

```text
seedancePrompt
subShots
soundDesign
audio
dialogue
assetRefs
assetReferences
```

职责：

```text
组织 Seedance 可执行提示词
把本镜资产绑定进子镜头、台词、音效和最终提示词
区分可作为 image_urls 的有图资产和只能文本描述的无图资产
标记自身是否相对 shot.assetRefs / shot 内容过期
```

限制：

```text
提示词包不得创造新的 assetId
提示词包只能引用项目资产库中已有资产
提示词包应优先使用 shot.assetRefs
提示词包里的 assetRefs 是派生数据，不是分镜资产主数据
```

提示词包可以在自然语言里出现临时画面元素，例如灰尘、火光、碎石、箭矢、木门。这些不是稳定资产，通常不需要进入资产库。

如果提示词包出现稳定资产，但没有绑定项目资产 ID，应视为潜在漏绑，例如：

```text
文本出现“废弃铁匠铺”
但没有 @LOC04
```

### 视频请求

视频请求是最终提交给视频模型的内容。

输入：

```text
提示词包
资产参考图
项目视频属性
视频模型配置
```

输出：

```text
requestPayload.prompt
requestPayload.image_urls
duration
size
resolution
generate_audio
```

规则：

```text
有图资产 -> 可进入 image_urls，并在 prompt 中绑定顺序
无图资产 -> 只能进入 prompt 文本，不进入 image_urls
最终请求不得反向修改提示词包或分镜资产
```

## 推荐生产流程

### 1. 生成分镜脚本

从分集结构化剧本生成 5-15 秒分镜。

输出：

```text
episode.shots[]
```

每个 shot 应包含清晰的画面、动作、剪辑承接、资产提示。

### 2. 提取分镜资产

对每个分镜执行资产提取。

输入：

```text
shot
项目资产库
已有资产图
```

输出：

```text
更新项目资产库
更新 shot.assetRefs
```

提取标准：

```text
优先复用项目已有资产
识别稳定角色、主场景、关键道具、核心生物
忽略气氛、光效、普通杂物、短暂动作、声音、字幕
同一分镜最多保留有限数量的关键资产
无图资产仍可进入 shot.assetRefs
```

重要资产判断：

```text
主角或说话角色
当前主场景
推动剧情的道具
影响角色行动的生物/敌人
会跨镜头复用的资产
画面中需要外观一致的对象
```

### 场景资产层级选择规则

场景资产需要区分“故事发生的大区域”和“当前镜头实际拍摄的局部场景”。

例如《龙蛋领主》中：

```text
LOC01 三国边境大世界
  -> LOC02 废弃矿山入口 / 矿山侧路
    -> LOC04 废弃铁匠铺 / 铁匠铺外
```

如果一集故事整体发生在三国边境大世界，但某个分镜实际画面发生在铁匠铺外，那么本镜主场景应优先使用：

```text
LOC04 废弃铁匠铺
```

而不是优先使用：

```text
LOC01 三国边境大世界
```

场景资产选择优先级：

```text
当前镜头明确出现的具体场景
> 当前动作发生的局部空间
> 当前区域/建筑外部
> 故事发生的大区域/世界观背景
> 兜底通用场景
```

“大世界”资产适合用于：

```text
远景、航拍、建立地理关系
展示雪国/森国/沙漠国整体布局
表现三国边境大环境
没有更具体场景资产时临时兜底
```

“局部场景”资产适合用于：

```text
角色正在进入、停留、战斗、操作、躲避的空间
镜头主体动作实际发生的位置
需要保持门、窗、熔炉、招牌、道路、矿洞入口等布局一致的场景
```

因此，参考图不应压过场景具体度。

```text
场景具体度 / 当前镜头命中度
> 是否已有参考图
```

有参考图可以作为加分项，但不能让有图的上层大区域资产压过无图但更准确的局部场景资产。

如果当前镜头主场景没有参考图，应保留该资产引用，并提示用户生成参考图，而不是自动替换成有图但不准确的上层场景。

### 3. 用户审核分镜资产

前端中间“资产”栏必须展示：

```text
shot.assetRefs
```

不应因为提示词包存在而改为展示 `promptPackage.assetRefs`。

资产状态建议展示：

```text
有参考图
无参考图
已用于提示词包
未同步到提示词包
```

交互：

```text
删除资产：只从本分镜 shot.assetRefs 移除，不删除资产库
添加资产：从项目资产库选择，写入 shot.assetRefs
点击资产：打开资产详情弹窗
无参考图资产：可提示“仅文本引用，不能作为 image_urls”
```

### 4. 生成提示词包

提示词包必须以 `shot.assetRefs` 为主输入。

生成时：

```text
把 shot.assetRefs 中的重要资产绑定到 seedancePrompt 和 subShots
有参考图资产写入 assetReferences
无参考图资产仍可在 prompt 文本中以 @资产名 或明确名称出现
不得新增不存在的 assetId
```

如果模型试图输出未知 assetId：

```text
后端过滤未知 assetId
记录 warning 或校验信息
前端提示可能存在未绑定资产
```

如果模型试图输出不属于本分镜 `shot.assetRefs` 的已知 assetId：

```text
后端同样过滤掉该引用
提示词包不得把项目资产库中的其他资产反向写成本分镜资产
前端右侧可提示“提示词包包含额外资产/已被过滤或需要重新生成”
```

也就是说，`availableAssets` 只是模型识别资产 ID 的查询目录，真正允许写入本分镜提示词包的白名单是：

```text
shot.assetRefs
```

### 5. 提示词包审核与编辑

右侧“提示词包”区域展示派生数据。

建议展示：

```text
当前提示词包引用资产
与 shot.assetRefs 的差异
缺少参考图的资产说明
是否已过期
```

如果用户手动编辑提示词包：

```text
只修改提示词包
不自动新增项目资产
若 @ 选择资产，只能从本分镜 shot.assetRefs 中选择
如果需要引用新的项目资产，必须先把该资产添加到本分镜资产栏，再进入提示词编辑器 @ 引用
保存后更新 promptPackage.assetRefs
视频结果标记为过期
```

### 6. 生成视频

提交视频时：

```text
prompt 来自提示词包
image_urls 来自提示词包引用资产中有图的资产
无图资产保留在 prompt 文本中，不进入 image_urls
```

提交前校验：

```text
提示词包是否过期
提示词包是否引用未知 assetId
提示词包引用资产是否与 shot.assetRefs 存在重大差异
视频是否早于最新提示词包
```

## 前端展示规则

### 分镜制作页四栏关系

```text
左栏：分镜脚本
中栏：分镜资产 shot.assetRefs
右栏：提示词包 promptPackage
视频栏：视频任务和结果
```

中栏资产展示规则：

```text
永远显示 shot.assetRefs
不存在提示词包时显示 shot.assetRefs
存在提示词包时仍显示 shot.assetRefs
```

右栏提示词包展示规则：

```text
显示 promptPackage.assetRefs
显示是否缺少 shot.assetRefs 中的资产
显示是否引用了 shot.assetRefs 外的资产
显示是否缺少参考图
```

### 状态标签建议

资产卡可显示：

```text
参考图
无图
已同步
未入提示词
文本引用
图片引用
```

提示词包可显示：

```text
与分镜资产一致
缺少 1 个分镜资产
包含额外资产
需重新生成
```

## 过期与同步规则

### shot 变化

当以下字段变化时：

```text
camera
action
entryBeat
mainBeat
exitBeat
dialogue
assetNotes
visualNotes
continuity
durationSec
```

应标记：

```text
promptPackage.stale = true
video.stale = true
```

### shot.assetRefs 变化

当用户添加/删除分镜资产，或重新提取资产导致 `shot.assetRefs` 变化时：

```text
promptPackage.stale = true
staleReason = "分镜资产已更新"
video.stale = true
```

不应静默更新提示词包。用户需要：

```text
重新生成提示词包
或手动编辑提示词包并保存
```

### promptPackage 变化

当提示词包重新生成或人工编辑保存后：

```text
promptPackage.stale = false
video.stale = true
```

### video 变化

视频结果只对应某一次提示词包提交。

如果提示词包更新：

```text
视频显示“提示词已更新，建议重新生成”
```

## 无参考图资产处理

无图资产仍然是有效资产。

在分镜资产栏：

```text
正常显示
标记“无参考图”
允许点击打开资产详情
允许生成参考图
```

在提示词包：

```text
可作为文本引用
不能进入 image_urls
```

在视频请求：

```text
有图资产进入 image_urls
无图资产只进入 prompt 文本
```

如果某个无图资产是当前镜头主场景或核心角色，应提示用户优先生成参考图。

例如：

```text
LOC04 废弃铁匠铺是 SH03 主场景
但没有参考图
前端应提示：建议生成场景参考图后再生成视频
```

## 异常与校验

### 提示词包缺少分镜资产

如果：

```text
shot.assetRefs = [CHAR01, PROP01, LOC04]
promptPackage.assetRefs = [CHAR01, PROP01]
```

前端应提示：

```text
提示词包缺少：LOC04 废弃铁匠铺
建议重新生成提示词包或手动 @LOC04
```

### 提示词包引用额外资产

如果：

```text
promptPackage.assetRefs 包含 LOC01
但 shot.assetRefs 不包含 LOC01
```

前端可提示：

```text
提示词包包含额外资产：LOC01 三国边境大世界
```

这不一定是错误。它可能是用户手动添加，也可能是旧包未同步。需要结合 `updatedAt/stale` 判断。

### 提示词包出现未知 assetId

后端应过滤未知 ID，并记录：

```text
unknownAssetRefs
```

前端提示：

```text
提示词包包含不存在的资产引用，已忽略
```

### 文本出现疑似稳定资产但未绑定

可作为后续增强：

```text
提示词文本出现“铁匠铺”
项目资产库存在 LOC04 废弃铁匠铺
但 promptPackage.assetRefs 不包含 LOC04
```

提示：

```text
可能缺少资产绑定：废弃铁匠铺
```

## 需要改动的模块

### 前端 `public/app.js`

需要调整：

```text
renderShots()
```

当前逻辑：

```js
const assets = pack ? promptPackageReferenceAssets(pack) : inferShotAssets(shot, assetCatalog);
```

目标逻辑：

```text
中栏资产 = inferShotAssets(shot, assetCatalog)
右栏提示词包 = promptPackageReferenceAssets(pack)
```

需要新增/调整：

```text
分镜资产与提示词包资产差异计算
无参考图状态展示
已同步/未同步标签
提示词包缺失资产 warning
```

涉及函数：

```text
renderShots
renderShotAssetStrip
renderPromptSummary
inferShotAssets
promptPackageReferenceAssets
saveShotReferenceAssets
removeShotReferenceAsset
```

### 后端 `server.js`

需要检查/调整：

```text
saveShotReferenceAssets / /api/shot-assets/save
doGenerateCards
attachAssetRefsToSelectedShots
doGeneratePromptPackages
normalizePromptPackages
hydratePromptPackageReferences
buildSeedanceVideoPrompt
prepareSeedanceReferenceImages
```

目标：

```text
shot.assetRefs 变化后明确标记 promptPackage stale
重新提取分镜资产导致 shot.assetRefs 变化时，同样标记 promptPackage/video stale
提示词包生成优先使用 shot.assetRefs
过滤未知 assetId
过滤不在本分镜 shot.assetRefs 内的额外 assetId
保留无图资产作为文本引用
只把有图资产传入 image_urls
场景资产排序使用“具体当前场景优先于大区域/世界观场景”的通用规则
```

### 样式 `public/index.html` / CSS

需要新增或调整：

```text
资产状态标签
无参考图占位
提示词包差异 warning
中栏资产卡布局
```

### 文档

需要同步：

```text
docs/model-and-prompt-flow.md
docs/workflow.md
docs/shot-script-asset-extraction-standard.md
```

可引用本文档作为新标准。

## 验收标准

以《龙蛋领主》第 2 集 SH03 为例：

1. 分镜资产栏显示 `LOC04 废弃铁匠铺`，即使它没有参考图。
2. `LOC04` 卡片标记“无参考图”。
3. 若提示词包没有 `LOC04`，右侧提示“提示词包缺少分镜资产 LOC04”。
4. 用户生成 `LOC04` 参考图后，资产栏应更新为“有参考图”。
5. 重新生成提示词包后，提示词包应引用 `LOC04`。
6. 视频请求中，若 `LOC04` 有图，则进入 `image_urls`；若仍无图，则只保留在 prompt 文本中。
7. 用户删除 SH03 的 `LOC04`，只影响 SH03，不删除项目资产库中的 `LOC04`。
8. 删除或添加分镜资产后，旧提示词包和旧视频应提示需要更新。
9. SH03 的主场景是铁匠铺外/铁匠铺入口时，`LOC04` 的优先级应高于 `LOC01 三国边境大世界`，不能因为 `LOC01` 有参考图就替代 `LOC04`。
10. 只有当分镜明确是大世界远景、航拍、三国边境整体展示，或缺少更具体场景资产时，才应引用 `LOC01 三国边境大世界` 作为主场景参考。
11. 如果新生成提示词包时模型返回了 `shot.assetRefs` 之外的已知资产 ID，后端应过滤，不允许它污染本分镜资产关系。
12. 重新执行“提取资产”后，只要某个分镜的 `shot.assetRefs` 发生变化，该分镜旧提示词包和旧视频都应标记过期。

## 不在本次范围

1. 不修改资产提取 LLM 的大模型基础策略。
2. 不改变 Seedance API 请求字段结构。
3. 不改变 Runway Bridge 插件机制。
4. 不强制所有资产必须生成参考图。
5. 不自动把提示词包文本中的每个名词都变成资产。
