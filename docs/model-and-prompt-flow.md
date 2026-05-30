# 模型与提示词流程

## 模型分层

v1.0 已经把模型能力抽为工作台级配置，项目内只保存选择关系。

模型类型：

- LLM：负责剧本、分镜、资产提取、提示词包。
- Image：负责资产参考图和早期故事板图。
- Video：负责分镜视频片段生成。
- Video Profile：负责定义视频模型所需提示词结构和请求构造方式。

当前默认视频 profile：

```text
id: seedance-2.0
promptSchema: seedance-prompt-package-v1
requestBuilder: seedance
maxReferenceImages: 4
```

## LLM 调用点

### 1. 项目剧本生成

用途：

- 从项目名称、故事梗概和项目属性生成结构化项目剧本。

输出：

- 标题。
- logline。
- synopsis。
- scenes。
- 每场 action、narration、dialogue、visualNotes。

### 2. 分集剧本续写

用途：

- 创建新剧集时，参考项目剧本和上一集内容，生成当前分集剧情。

输出：

- 当前剧集标题/摘要。
- 当前剧集剧本。
- 可继续进入分镜制作的文本。

### 3. 分镜脚本生成

用途：

- 把当前分集剧本拆成多个适合视频生成的 15s 分镜。

输出：

- shot id。
- shot title。
- location。
- time/mood。
- action。
- camera。
- dialogue。
- sound。
- visual notes。

### 4. 资产提取

用途：

- 从项目剧本或分镜脚本中提取角色、场景、道具。
- 与已有项目资产库做合并。
- 为每个分镜选择重要参考资产。

稳定性规则：

- 不只按完全同名合并。
- 需要识别别名、身份称呼、角色关系和已有资产 aliases。
- 同一角色的“他、男主角、男大学生、角色名”应尽量归并到同一个资产。
- 分镜级参考资产要控制数量，优先保留影响一致性的核心资产。

### 5. Seedance 提示词包生成

用途：

- 将分镜脚本和资产引用转换成视频模型可用的提示词结构。

输出：

- 分镜提示词。
- 分镜音效。
- 分镜台词。
- 细分动作/镜头段落。
- 资产引用。
- Seedance prompt。

## 生图模型调用点

### 1. 资产参考图生成

用途：

- 为角色、场景、道具生成稳定参考图。

输入：

- 资产名称。
- 资产描述。
- 资产类型。
- 项目风格提示词。
- 项目风格参考图。

输出：

- 本地缓存图片。
- 资产图记录。
- 最近 5 张历史记录。

生成标准：

- 人物：三视图、清晰角色设定、服装和发型稳定。
- 场景：多角度、空间布局清晰、可作为视频参考。
- 道具：主体居中、轮廓清楚、避免背景抢戏。

### 2. 故事板图生成

状态：

- 作为早期遗留/备用能力保留。
- 当前主流程不依赖故事板图或首帧图。

## 视频模型调用点

### Seedance 2.0

当前接入：

- APIMart Seedance 2.0。
- 分辨率：480p。
- 异步生成。
- 返回 task_id 后轮询任务状态。

请求结构：

```json
{
  "model": "doubao-seedance-2.0",
  "prompt": "精简后的分镜视频提示词",
  "resolution": "480p",
  "size": "16:9 或 9:16 等",
  "duration": 5,
  "generate_audio": true,
  "image_urls": ["上传后的参考图 URL"]
}
```

注意：

- 工作台内部的提示词包不是原样整个 JSON 发给视频模型。
- 提交时会提取并合成精简 prompt。
- 本地资产图会先上传到 APIMart，得到可访问 URL 后再放入 `image_urls`。
- 当前工作台仍按最多 4 张分镜参考图管理，保证提示词和参考图选择稳定。

## 提示词包结构

提示词包是工作台内部管理格式，目标是让预览、导出、视频提交使用同一套内容。

建议逻辑字段：

- `shotId`：对应分镜。
- `title`：镜头标题。
- `seedancePrompt`：给视频模型的核心提示词。
- `sound`：分镜音效。
- `dialogue`：分镜台词。
- `segments`：细分镜头动作。
- `assetRefs`：引用的资产 ID。
- `references`：资产图片引用。
- `createdAt`：生成时间。
- `source`：adapter/mock/manual。

## 提示词与视频的一致性规则

- 提示词包重新生成后，已生成的视频可能不再对应最新提示词。
- 工作台应提示“提示词已更新，需要按新提示重新生成视频”。
- 视频记录应保留生成时使用的 prompt 和 reference images，方便排查质量问题。
- 导出的提示词包应与页面预览一致。

## 后续扩展新视频模型的原则

新增视频模型时，不应修改 Seedance 2.0 既有标准，而应新增：

- 新 video model config。
- 新 video profile。
- 新 prompt schema。
- 新 request builder。
- 新 normalize/status parser。

这样可以保证旧项目继续按 Seedance 2.0 标准运行，新项目或新镜头再切换到新模型标准。
