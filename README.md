# AI 漫剧工作台 MVP

零依赖 Node 本地服务 + 静态前端 + 本地 JSON/文件缓存。当前主链路面向 Seedance 一类视频模型，先跑到视频生成前：

1. 项目配置
2. 剧本生成
3. 15s 分镜生成
4. 角色 / 场景 / 道具资产卡提取
5. 资产参考图生成
6. Seedance 可用的 15s 分镜提示词包

主流程不再要求生成故事板图或首帧图。后续接入视频模型时，直接使用“分镜提示词包 + 对应资产参考图”作为输入。

## 启动

```powershell
node server.js
```

然后打开：

```text
http://127.0.0.1:8800
```

也可以指定端口：

```powershell
$env:PORT=8799; node server.js
```

## 本地目录

- `data/config.json`：项目配置和 adapter 配置
- `data/state.json`：流水线状态
- `cache/images/`：资产参考图缓存
- `cache/videos/`：保留目录，等待后续视频模型接入

## Adapter

LLM 和生图默认按 OpenAI-compatible JSON 接口尝试：

- LLM：`POST /chat/completions`
- Image：`POST /images/generations`

当前新增接口：

- `POST /api/generate/asset-images`：按资产卡生成角色 / 场景 / 道具参考图
- `POST /api/generate/prompt-packages`：生成包含分镜音效、分镜台词、细分镜头、资产引用和 `seedancePrompt` 的 15s 分镜提示词包

常用局部生成：

```json
POST /api/generate/asset-images
{ "assetIds": ["CHAR01"] }
```

```json
POST /api/generate/prompt-packages
{ "shotIds": ["SH01"] }
```

前端也提供了对应按钮：

- 分镜表：单个镜头生成提示词包
- 资产卡：单个角色 / 场景 / 道具生成参考图
- 提示词包：补齐当前镜头缺失的资产参考图，并可复制完整 JSON

如果 adapter 未配置、请求失败或返回格式不符合预期，并且开启 `fallbackToMock`，服务会回退到 mock 输出。
