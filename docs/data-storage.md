# 数据与缓存管理

## 本地数据目录

运行时数据位于：

```text
data/
```

当前主要文件：

- `data/config.json`：当前项目配置和模型选择快照。
- `data/models.json`：工作台级模型中心配置。
- `data/projects.json`：所有项目、项目配置、项目状态。
- `data/state.json`：当前打开项目的状态快照。

这些文件包含本地项目数据，部分文件可能包含 API key，因此不纳入 Git。

## 项目数据结构

项目是最高层内容容器。

项目核心字段：

- `id`：项目 ID。
- `title`：项目名。
- `scriptText`：项目剧本/故事文本。
- `coverUrl`：项目封面。
- `config`：项目配置。
- `state`：项目内部生产状态。
- `createdAt` / `updatedAt`：创建和更新时间。

项目状态核心内容：

- `storyScript`：项目剧本结构化结果。
- `cards`：资产卡，包含角色、场景、道具。
- `assetImages`：当前生效的资产图。
- `assetImageHistory`：资产图历史记录。
- `episodes`：剧集列表。
- `jobs`：运行任务。
- `events`：运行记录。

## 剧集数据结构

剧集属于项目。

剧集核心字段：

- `id`：剧集 ID。
- `title`：剧集标题。
- `order`：剧集顺序。
- `synopsis`：摘要。
- `script`：分集剧本。
- `shots`：分镜脚本。
- `promptPackages`：提示词包。
- `images`：早期故事板图记录。
- `videos`：视频片段任务和结果。
- `createdAt` / `updatedAt`：创建和更新时间。

## 资产数据结构

资产分三类：

- `characters`
- `locations`
- `props`

资产通用字段：

- `id`：资产 ID，如 `CHAR01`、`LOC01`、`PROP01`。
- `name`：资产名称。
- `aliases`：别名和称呼。
- `prompt`：资产生成/描述提示词。
- `source`：manual、adapter、mock 等。

角色常见字段：

- `role`
- `appearance`
- `personality`

场景常见字段：

- `atmosphere`
- `layout`

道具常见字段：

- `function`
- `look`

## 资产图与历史

`assetImages` 保存当前生效图。

`assetImageHistory` 保存每个资产最近的图片记录，当前策略是缓存最近 5 张，方便在上传图和生成图之间切换。

资产图记录通常包含：

- `id`
- `assetId`
- `assetType`
- `name`
- `prompt`
- `url`
- `file`
- `source`
- `model`
- `styleReferenceImages`
- `referenceStandard`
- `adapterError`
- `createdAt`

## 任务和运行记录

`jobs` 用于表达正在运行或已经完成的动作。

常见任务类型：

- 剧本生成。
- 分镜生成。
- 资产提取。
- 资产图生成。
- 提示词包生成。
- 视频任务提交。
- 视频任务状态刷新。

`events` 用于记录历史事件，方便排查流程。

常见事件：

- project.created
- config.saved
- cards.generated
- assetImages.generated
- promptPackages.generated
- videos.generated
- videos.status

## 缓存目录

生成缓存位于：

```text
cache/
```

当前子目录：

- `cache/images/`：上传图、生图模型返回图、风格图等。
- `cache/videos/`：早期 mock 视频 HTML 或临时视频缓存。

注意：

- 缓存文件不进入 Git。
- 如果要把项目完整交给别人，需要单独设计项目导出包，把项目 JSON 和依赖图片一起打包。

## 敏感数据规则

这些内容不要提交：

- API key。
- 带 key 的模型配置。
- 本地真实项目数据。
- 生成视频 URL 中的临时访问参数。
- 大体积视频成品。

当前 `.gitignore` 已排除：

- `data/config.json`
- `data/models.json`
- `data/projects.json`
- `data/state.json`
- `cache/images/*`
- `cache/videos/*`
- `*.mp4`
- `*.log`

## 备份建议

日常开发建议：

- Git 管理代码和文档。
- 单独备份 `data/` 和 `cache/`，用于保留真实项目。
- 发布给别人试用时，提供空数据或示例数据，不提供个人密钥。
- 如果要迁移项目，应确保 `projects.json` 中引用的缓存图片也一起迁移。
