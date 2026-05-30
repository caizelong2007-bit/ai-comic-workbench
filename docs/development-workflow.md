# 开发流程标准

本文档定义 AI 漫剧工作台后续开发的 Git 分支、验收、合并和发布规则。

## 分支职责

### master

定位：

- 稳定发布分支。
- 只放已经验收、可运行、可发布的版本。

规则：

- 不直接在 `master` 上开发。
- 只有当 `dev` 稳定后，才合并到 `master`。
- 每次重要稳定版本合入 `master` 后，应打 tag。
- `master` 出现问题时，应优先从 `fix/*` 修复，再合并回 `dev` 和 `master`。

### dev

定位：

- 日常集成测试分支。
- 所有已验收的新功能和修复先进入 `dev`。

规则：

- 不直接在 `dev` 上写复杂功能。
- 每个新功能从 `dev` 创建 `feature/*` 分支。
- 每个修复从 `dev` 或 `master` 创建 `fix/*` 分支，视问题来源决定。
- 用户验收通过后，feature/fix 再合并到 `dev`。

### feature/*

定位：

- 单个新功能开发分支。

命名：

```text
feature/<功能名>
```

示例：

```text
feature/development-workflow-standard
feature/video-export-package
feature/project-import-export
```

规则：

- 每个新功能单独创建一个 feature 分支。
- feature 分支从 `dev` 创建。
- AI 在 feature 分支上实现和提交。
- 用户试用验收前，不合并到 `dev`。
- 验收通过后，合并到 `dev`。
- 合并后可删除远端和本地 feature 分支。

### fix/*

定位：

- 单个缺陷修复分支。

命名：

```text
fix/<问题名>
```

示例：

```text
fix/video-task-stuck-loading
fix/asset-upload-save
fix/prompt-package-stale-video
```

规则：

- 每个修复单独创建一个 fix 分支。
- 普通修复从 `dev` 创建。
- 线上/稳定版紧急修复可从 `master` 创建。
- 修复验收通过后，合并回来源分支。
- 如果从 `master` 修复，修复完成后也要同步回 `dev`。

## 标准开发流程

### 新功能流程

1. 用户提出新功能。
2. AI 从 `dev` 创建 `feature/<功能名>` 分支。
3. AI 在 feature 分支完成开发。
4. AI 自测并提交。
5. AI 推送 feature 分支到 GitHub。
6. 用户在本地或浏览器中试用验收。
7. 验收通过后，AI 将 feature 分支合并到 `dev`。
8. AI 推送 `dev`。
9. feature 分支可保留用于追溯，也可删除。

流程图：

```text
dev -> feature/<功能名> -> 用户验收 -> dev
```

### 修复流程

1. 用户提出问题。
2. AI 判断问题属于开发版还是稳定版。
3. 从 `dev` 或 `master` 创建 `fix/<问题名>`。
4. AI 修复并自测。
5. 用户验收。
6. 验收通过后合并回来源分支。
7. 如果修复进入 `master`，也同步回 `dev`。

流程图：

```text
dev -> fix/<问题名> -> 用户验收 -> dev
```

紧急稳定版修复：

```text
master -> fix/<问题名> -> 用户验收 -> master -> dev
```

### 发布流程

1. `dev` 累积多个已验收功能。
2. 用户确认当前 `dev` 稳定。
3. AI 将 `dev` 合并到 `master`。
4. AI 在 `master` 打版本 tag。
5. AI 推送 `master` 和 tag 到 GitHub。

流程图：

```text
feature/* -> dev -> master -> tag
fix/* -> dev/master -> tag
```

## AI 执行标准

### 通用开发守则

AI 每次开始开发前必须遵守以下规则：

1. 开始前先查看当前 Git 状态，确认当前分支和工作区是否干净。
2. 为本次任务创建独立分支，不直接在 `master` 或 `dev` 上开发。
3. 只修改和本任务相关的文件。
4. 修改前先说明本次会动哪些模块或文件。
5. 修改后运行项目现有测试；如果没有测试，则至少运行启动检查或语法检查。
6. 完成后输出改动摘要、测试结果和回滚方式。
7. 不删除现有功能，除非用户明确同意。
8. 不重构无关代码。

如果任务只是文档更新，也必须创建独立分支，并说明只会修改文档文件。

每次接到新功能时，AI 应执行：

```powershell
git checkout dev
git pull
git checkout -b feature/<功能名>
```

开发完成后：

```powershell
git status --short
git add <相关文件>
git commit -m "feat: <功能描述>"
git push -u origin feature/<功能名>
```

用户验收通过后：

```powershell
git checkout dev
git pull
git merge feature/<功能名>
git push origin dev
```

如果用户要求“验收后再合并”，AI 只能推送 feature/fix 分支，不能主动合并到 `dev`。

稳定发布时：

```powershell
git checkout master
git pull
git merge dev
git tag -a v<版本号> -m "<版本说明>"
git push origin master
git push origin v<版本号>
```

## 修改前说明标准

AI 在动手修改前，应明确说明：

- 当前所在分支。
- 本次创建的新分支名。
- 本次会修改的模块或文件。
- 本次不会修改的范围。
- 预计验证方式。

示例：

```text
当前从 dev 创建 feature/project-export。
本次只修改项目导出相关后端 API、前端导出按钮和文档。
不会修改模型调用、资产生成、视频生成链路。
完成后会运行 npm start 启动检查，并检查 Git diff。
```

## 修改后交付标准

AI 完成修改后，应输出：

- 改动摘要。
- 涉及文件。
- 测试或启动检查结果。
- 是否已提交。
- 所在分支。
- 回滚方式。

回滚方式示例：

```powershell
git checkout dev
git branch -D feature/<功能名>
```

如果分支已推送到远端，还应补充：

```powershell
git push origin --delete feature/<功能名>
```

如果变更已经合并到 `dev`，回滚应优先使用 `git revert <commit>`，避免改写公共历史。

## 提交信息规范

推荐格式：

```text
<type>: <summary>
```

常用 type：

- `feat`：新功能。
- `fix`：缺陷修复。
- `docs`：文档。
- `refactor`：重构，不改变功能。
- `chore`：配置、版本管理、杂项。
- `test`：测试。

示例：

```text
feat: add project import export
fix: refresh completed video tasks
docs: add development workflow standard
```

## 验收标准

新功能合并到 `dev` 前，需要满足：

- 用户确认功能方向正确。
- 关键流程可以跑通。
- 不破坏 v1.0 已稳定链路。
- 没有把密钥、本地项目数据、缓存或视频成品提交进 Git。
- 涉及模型调用时，要有 loading、失败反馈和避免重复请求的处理。

发布到 `master` 前，需要满足：

- `dev` 当前版本可启动。
- 主流程没有阻断问题。
- 用户确认可以作为稳定版本。
- 已更新必要文档。
- 已打版本 tag。

## 当前分支建议

当前仓库已有：

- `master`
- `dev`
- `feature-x`
- `fix-x`

后续真实开发建议使用更具体的分支名，例如：

- `feature/seedance-video-batch-export`
- `feature/project-backup-restore`
- `fix/asset-reference-missing`

`feature-x` 和 `fix-x` 可作为示例分支，也可以后续删除，避免和真实需求混淆。
