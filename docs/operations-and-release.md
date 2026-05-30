# 运行与版本管理

## 本地运行

方式一：双击启动脚本。

```text
start-workbench.bat
```

方式二：命令行启动。

```powershell
npm start
```

默认访问地址：

```text
http://127.0.0.1:8800/
```

要求：

- Node.js 18 或更高版本。
- 无需安装 npm 依赖。

## 启动脚本行为

`start-workbench.bat` 会执行：

1. 切换到项目目录。
2. 检查 `127.0.0.1:8800` 是否已有服务。
3. 如果已有服务，直接打开浏览器。
4. 如果没有服务，检查 Node.js。
5. 运行 `npm start`。

## Git 基线

当前 MVP 基线：

```text
tag: v1.0
commit: 25320a8 chore: mark MVP v1.0 baseline
```

v1.0 用途：

- 作为当前可运行版本的回滚点。
- 作为后续功能开发的对比基线。
- 作为“视频生成已稳定跑通”的版本边界。

## 提交规则

建议提交粒度：

- `docs:` 文档更新。
- `feat:` 新功能。
- `fix:` 缺陷修复。
- `refactor:` 不改变行为的结构调整。
- `chore:` 构建、配置、版本管理。

建议每次提交前检查：

```powershell
git status --short
git diff --stat
```

涉及密钥或本地数据时，再检查：

```powershell
git status --ignored --short
```

## 不提交内容

不要提交：

- `data/*.json`
- `cache/images/*`
- `cache/videos/*`
- `*.mp4`
- `*.log`

原因：

- `data/config.json` 和 `data/models.json` 可能包含密钥。
- `data/projects.json` 和 `data/state.json` 是本地个人项目数据。
- 缓存和视频文件体积大，且可重新生成。

## 交付给别人试用

当前项目是本地单机工作台。给别人试用时，应提供：

- 源码。
- `package.json`。
- `start-workbench.bat`。
- 文档。
- 空的或示例模型配置说明。

不要提供：

- 个人 API key。
- 私人项目数据。
- 生成缓存和视频成品。

对方运行步骤：

1. 安装 Node.js 18+。
2. 解压/克隆项目。
3. 打开项目目录。
4. 双击 `start-workbench.bat` 或运行 `npm start`。
5. 在工作台模型中心配置自己的 LLM、生图和视频模型。

## v1.1 建议优先级

### P0：稳定性

- 增加 API smoke test。
- 增加提示词包和视频 payload 构造测试。
- 增加视频状态解析测试。
- 给模型调用失败补充更明确的错误反馈。

### P1：工程结构

- 拆分 `server.js`。
- 拆分 `public/app.js`。
- 抽出 model adapters。
- 抽出 prompt builders。
- 抽出 project/episode/asset services。

### P2：项目迁移

- 增加项目导出包。
- 增加项目导入。
- 统一处理 JSON 与缓存图片的相对路径。

### P3：成片能力

- 分镜片段排序。
- 单集成片拼接。
- 字幕文件生成。
- 最终视频导出。
