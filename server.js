const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CACHE_DIR = path.join(ROOT, "cache");
const IMAGE_DIR = path.join(CACHE_DIR, "images");
const VIDEO_DIR = path.join(CACHE_DIR, "videos");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PROJECTS_PATH = path.join(DATA_DIR, "projects.json");
const MODEL_CENTER_PATH = path.join(DATA_DIR, "models.json");
const PORT = Number(process.env.PORT || 8800);
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;
const MAX_SHOT_ASSET_REFS = 4;
const JOB_STALE_MS = 2 * 60 * 60 * 1000;
let stateWriteQueue = Promise.resolve();
const apimartUploadCache = new Map();

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const DEFAULT_CONFIG = {
  project: {
    title: "霓虹迷城第一集",
    logline: "一个新手快递员在雨夜误入会呼吸的霓虹城市，必须把一枚失控的记忆芯片送到塔顶。",
    genre: "都市奇幻",
    audience: "12-18 岁轻幻想用户",
    episodeDuration: "60 秒",
    videoLength: "60 秒",
    subtitles: "on",
    language: "zh-CN",
    dialogueLanguage: "zh-CN",
    visualStyle: "高对比霓虹、漫画分镜、电影感雨夜、角色表情清晰",
    aspectRatio: "9:16"
  },
  adapters: {
    llm: {
      provider: "mock",
      endpoint: "",
      model: "",
      apiKey: "",
      fallbackToMock: false,
      timeoutMs: 180000
    },
    image: {
      provider: "mock",
      endpoint: "",
      model: "",
      apiKey: "",
      fallbackToMock: false,
      timeoutMs: 300000
    },
    video: {
      provider: "mock",
      endpoint: "",
      model: "",
      apiKey: "",
      fallbackToMock: false,
      timeoutMs: 120000
    }
  },
  modelConfigs: {
    llm: [
      {
        id: "default-llm",
        type: "llm",
        name: "默认 LLM",
        provider: "mock",
        endpoint: "",
        model: "",
        apiKey: "",
        fallbackToMock: false,
        timeoutMs: 180000
      }
    ],
    image: [
      {
        id: "default-image",
        type: "image",
        name: "默认生图模型",
        provider: "mock",
        endpoint: "",
        model: "",
        apiKey: "",
        fallbackToMock: false,
        timeoutMs: 300000
      }
    ],
    video: [
      {
        id: "default-video",
        type: "video",
        name: "默认视频模型",
        provider: "mock",
        endpoint: "",
        model: "",
        apiKey: "",
        fallbackToMock: false,
        timeoutMs: 120000
      }
    ]
  },
  modelSelection: {
    scriptLlm: "default-llm",
    episodeScriptLlm: "default-llm",
    shotLlm: "default-llm",
    assetExtractLlm: "default-llm",
    promptPackageLlm: "default-llm",
    assetImageModel: "default-image",
    storyboardImageModel: "default-image",
    videoModel: "default-video",
    videoProfile: "seedance-2.0"
  },
  videoProfiles: [
    {
      id: "seedance-2.0",
      name: "Seedance 2.0",
      type: "video",
      promptSchema: "seedance-prompt-package-v1",
      requestBuilder: "seedance",
      maxReferenceImages: 4,
      description: "15s 分镜提示词 + 最多 4 张资产参考图。"
    }
  ]
};

const MODEL_TYPES = ["llm", "image", "video"];
const MODEL_DEFAULT_IDS = {
  llm: "default-llm",
  image: "default-image",
  video: "default-video"
};
const MODEL_SELECTION_TYPES = {
  scriptLlm: "llm",
  episodeScriptLlm: "llm",
  shotLlm: "llm",
  assetExtractLlm: "llm",
  promptPackageLlm: "llm",
  assetImageModel: "image",
  storyboardImageModel: "image",
  videoModel: "video"
};
const MODEL_SELECTION_DEFAULTS = {
  ...DEFAULT_CONFIG.modelSelection
};
const DEFAULT_VIDEO_PROFILE_ID = "seedance-2.0";
const APIMART_SEEDANCE_ENDPOINT = "https://api.apimart.ai/v1/videos/generations";
const APIMART_SEEDANCE_MODEL = "doubao-seedance-2.0";
const APIMART_SEEDANCE_RESOLUTION = "480p";
const APIMART_UPLOAD_TTL_MS = 70 * 60 * 60 * 1000;

function defaultVideoConfig() {
  return {
    id: "apimart-seedance-2.0",
    type: "video",
    name: "APIMart Seedance 2.0",
    provider: "apimart-seedance",
    endpoint: APIMART_SEEDANCE_ENDPOINT,
    model: APIMART_SEEDANCE_MODEL,
    apiKey: "",
    fallbackToMock: false,
    timeoutMs: 600000,
    resolution: APIMART_SEEDANCE_RESOLUTION
  };
}

const DEFAULT_STATE = {
  schemaVersion: 2,
  meta: {
    createdAt: "",
    updatedAt: ""
  },
  storyScript: null,
  cards: {
    characters: [],
    locations: [],
    props: []
  },
  assetImages: [],
  assetImageHistory: {},
  activeEpisodeId: null,
  episodes: [],
  jobs: [],
  events: []
};

const DEFAULT_PROJECTS = {
  activeProjectId: null,
  projects: []
};

async function main() {
  await ensureWorkspace();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, {
        ok: false,
        error: error.message || "Internal server error"
      });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`AI manga drama workbench running at http://127.0.0.1:${PORT}`);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      service: "ai-manga-drama-workbench",
      time: new Date().toISOString()
    });
  }

  if (pathname === "/api/state" && req.method === "GET") {
    const [config, state, projects] = await Promise.all([readConfig(), readState(), readProjects()]);
    return sendJson(res, 200, {
      ok: true,
      config: sanitizeConfig(config),
      state,
      projects: projectListForClient(projects),
      activeProjectId: projects.activeProjectId
    });
  }

  if (pathname === "/api/projects" && req.method === "GET") {
    const projects = await readProjects();
    return sendJson(res, 200, {
      ok: true,
      projects: projectListForClient(projects),
      activeProjectId: projects.activeProjectId
    });
  }

  if (pathname === "/api/projects" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await createProject(body));
  }

  if (pathname === "/api/projects/open" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await openProject(body.projectId || body.id));
  }

  if (pathname === "/api/projects/delete" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await deleteProject(body.projectId || body.id));
  }

  if (pathname === "/api/story-script" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await updateStoryScript(body));
  }

  if (pathname === "/api/episodes" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await createEpisode(body));
  }

  if (pathname === "/api/episodes/open" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await openEpisode(body.episodeId || body.id));
  }

  if (pathname === "/api/episodes/delete" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await deleteEpisode(body.episodeId || body.id));
  }

  if (pathname === "/api/episodes/script" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await updateEpisodeScript(body));
  }

  if (pathname === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    const current = await readConfig();
    const config = mergeConfig(current, body.config || body);
    await writeConfig(config);
    await syncActiveProject({ config });
    await appendEvent("config.saved", "项目配置已保存");
    return sendJson(res, 200, {
      ok: true,
      config: sanitizeConfig(config)
    });
  }

  if (pathname === "/api/upload/style-image" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await uploadStyleImage(body));
  }

  if (pathname === "/api/assets/manual" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await saveManualAsset(body));
  }

  if (pathname === "/api/assets/delete" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await deleteAsset(body.assetId || body.id));
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    const state = freshState();
    await writeState(state);
    await appendEvent("state.reset", "流水线状态已重置");
    return sendJson(res, 200, {
      ok: true,
      state
    });
  }

  if (pathname === "/api/generate/script" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateScript(payload));
  }

  if (pathname === "/api/generate/shots" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateShots(payload));
  }

  if (pathname === "/api/generate/cards" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateCards(payload));
  }

  if (pathname === "/api/generate/asset-images" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateAssetImages(payload));
  }

  if (pathname === "/api/generate/prompt-packages" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generatePromptPackages(payload));
  }

  if (pathname === "/api/generate/images" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateImages(payload));
  }

  if (pathname === "/api/generate/videos" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await generateVideos(payload));
  }

  if (pathname === "/api/videos/status" && req.method === "POST") {
    const payload = await readBody(req);
    return sendJson(res, 200, await refreshVideoTasks(payload));
  }

  if (pathname.startsWith("/cache/")) {
    return serveStatic(res, pathname, CACHE_DIR, "/cache/");
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return sendJson(res, 404, { ok: false, error: "API route not found" });
  }

  return serveStatic(res, pathname === "/" ? "/index.html" : pathname, PUBLIC_DIR, "/");
}

async function generateScript() {
  const existing = await getRunningJobSnapshot("generate", "script");
  if (existing) {
    return { ok: true, state: existing.state, job: existing.job, duplicate: true };
  }
  const start = await markJobRunning("generate", "script", "项目剧本生成中");
  if (start.duplicate) {
    return { ok: true, state: start.state, job: start.job, duplicate: true };
  }
  try {
    const response = await doGenerateScript();
    await markJobFinished("generate", "script", "succeeded", {
      label: "项目剧本已完成",
      result: { source: response.source || "" }
    });
    return { ...response, state: await readState() };
  } catch (error) {
    await markJobFinished("generate", "script", "failed", {
      label: "项目剧本生成失败",
      error: publicError(error)
    });
    throw error;
  }
}

async function doGenerateScript() {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const prompt = buildScriptPrompt(config);
  const result = await callLlmJson(resolveModelAdapter(config, "scriptLlm"), prompt, () => mockScript(config));
  const script = normalizeScript(result.data, config, result.source);
  script.adapterError = result.error || "";
  const sourceText = storyScriptText(script);
  const nextConfig = mergeConfig(config, {
    project: {
      title: config.project.title || script.title || "",
      logline: sourceText || config.project.logline || ""
    }
  });
  state.storyScript = script;
  state.cards = { characters: [], locations: [], props: [] };
  state.assetImages = [];
  for (const episode of state.episodes || []) {
    episode.shots = [];
    episode.promptPackages = [];
    episode.images = [];
    episode.videos = [];
  }
  touchState(state);
  addEvent(state, "script.generated", `${script.scenes.length} 场剧本已生成`, result.source, result.error);
  await writeConfig(nextConfig);
  await writeState(state);
  await syncActiveProject({ config: nextConfig, state });
  return { ok: true, config: sanitizeConfig(nextConfig), state, source: result.source, adapterError: result.error || "" };
}

async function generateShots(payload = {}) {
  const scopeId = "shots";
  const existing = await getRunningJobSnapshot("generate", scopeId);
  if (existing) {
    return { ok: true, state: existing.state, job: existing.job, duplicate: true };
  }
  const start = await markJobRunning("generate", scopeId, "15s 分镜生成中");
  if (start.duplicate) {
    return { ok: true, state: start.state, job: start.job, duplicate: true };
  }
  try {
    const response = await doGenerateShots(payload);
    await markJobFinished("generate", scopeId, "succeeded", {
      label: "15s 分镜已完成",
      result: { source: response.source || "" }
    });
    return { ...response, state: await readState() };
  } catch (error) {
    await markJobFinished("generate", scopeId, "failed", {
      label: "15s 分镜生成失败",
      error: publicError(error)
    });
    throw error;
  }
}

async function doGenerateShots(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episode = payload.episodeId
    ? state.episodes.find((item) => item.id === payload.episodeId)
    : requireActiveEpisode(state);
  if (!episode) {
    throw new Error("剧集不存在");
  }
  const script = episode.script || ensureStoryScriptFromConfig(state, config);
  if (!script) {
    throw new Error("请先准备分集剧本");
  }
  const prompt = buildShotsPrompt(config, script, episode);
  const result = await callLlmJson(resolveModelAdapter(config, "shotLlm"), prompt, () => mockShots(config, script));
  const shots = normalizeShots(result.data, script, config, result.source);
  for (const shot of shots) {
    shot.adapterError = result.error || "";
  }
  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    const latestEpisode = (nextState.episodes || []).find((item) => item.id === episode.id);
    if (!latestEpisode) {
      throw new Error("剧集不存在");
    }
    latestEpisode.shots = shots;
    latestEpisode.images = [];
    latestEpisode.videos = [];
    latestEpisode.promptPackages = [];
    touchEpisode(latestEpisode);
    touchState(nextState);
    addEvent(nextState, "shots.generated", `${latestEpisode.title} 已生成 ${latestEpisode.shots.length} 个 15s 分镜`, result.source, result.error);
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, source: result.source, adapterError: result.error || "" };
}

async function generateCards(payload = {}) {
  const scopeId = payload.scope === "shot" && Array.isArray(payload.shotIds) && payload.shotIds.length === 1
    ? `shot-assets:${payload.shotIds[0]}`
    : "cards";
  const existing = await getRunningJobSnapshot("generate", scopeId);
  if (existing) {
    return { ok: true, state: existing.state, job: existing.job, duplicate: true };
  }
  const start = await markJobRunning("generate", scopeId, scopeId.startsWith("shot-assets:") ? "分镜资产提取中" : "项目资产卡生成中");
  if (start.duplicate) {
    return { ok: true, state: start.state, job: start.job, duplicate: true };
  }
  try {
    const response = await doGenerateCards(payload);
    await markJobFinished("generate", scopeId, "succeeded", {
      label: scopeId.startsWith("shot-assets:") ? "分镜资产已提取" : "项目资产卡已完成",
      result: { source: response.source || "" }
    });
    return { ...response, state: await readState() };
  } catch (error) {
    await markJobFinished("generate", scopeId, "failed", {
      label: scopeId.startsWith("shot-assets:") ? "分镜资产提取失败" : "项目资产卡生成失败",
      error: publicError(error)
    });
    throw error;
  }
}

async function doGenerateCards(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const storyScript = ensureStoryScriptFromConfig(state, config);
  if (!storyScript) {
    throw new Error("请先生成项目故事剧本");
  }
  const shots = selectedShotsForAssetExtraction(state, payload);
  const prompt = buildCardsPrompt(config, storyScript, shots, state.cards, state.assetImages);
  const result = await callLlmJson(resolveModelAdapter(config, "assetExtractLlm"), prompt, () => mockCards(config, storyScript, shots));
  const generatedCards = normalizeCards(result.data, config, result.source);
  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    nextState.cards = mergeCards(nextState.cards, generatedCards);
    nextState.cards.adapterError = result.error || "";
    const linkedShotCount = attachAssetRefsToSelectedShots(nextState, payload, generatedCards, state.cards);
    for (const episode of nextState.episodes || []) {
      episode.promptPackages = hydratePromptPackageReferences(episode.promptPackages || [], nextState.cards, nextState.assetImages);
    }
    if (linkedShotCount) {
      for (const episode of nextState.episodes || []) touchEpisode(episode);
    }
    touchState(nextState);
    addEvent(nextState, "cards.generated", `${countCards(generatedCards)} 个资产已合并到项目资产库`, result.source, result.error);
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, source: result.source, adapterError: result.error || "" };
}

async function generateAssetImages(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  if (!countCards(state.cards)) {
    throw new Error("请先提取资产卡");
  }

  const requestedIds = new Set(Array.isArray(payload.assetIds) ? payload.assetIds : []);
  const batchJob = !requestedIds.size || requestedIds.size > 1;
  const runningBatch = batchJob ? findRunningJob(state, "generate", "asset-images") : null;
  if (runningBatch) {
    return { ok: true, state, outputs: [], job: runningBatch, duplicate: true };
  }
  if (requestedIds.size === 1) {
    const assetId = [...requestedIds][0];
    const running = findRunningJob(state, "asset-image", assetId);
    if (running) {
      return { ok: true, state, outputs: [], job: running, duplicate: true };
    }
  }
  const existingAssetIds = new Set((state.assetImages || []).filter((image) => image.url).map((image) => image.assetId));
  const assets = flattenCards(state.cards).filter((asset) => {
    if (requestedIds.size) {
      return requestedIds.has(asset.id) && (payload.force === true || payload.missingOnly !== true || !existingAssetIds.has(asset.id));
    }
    return payload.force === true || !existingAssetIds.has(asset.id);
  });
  if (!assets.length) {
    throw new Error(payload.missingOnly === true ? "资产参考图已齐，无需补齐" : "没有需要生成的资产参考图");
  }

  const start = await withStateWriteLock(async () => {
    const nextState = await readState();
    const running = requestedIds.size === 1
      ? findRunningJob(nextState, "asset-image", assets[0].id)
      : findRunningJob(nextState, "generate", "asset-images");
    if (running) {
      return { state: nextState, job: running, duplicate: true };
    }
    if (requestedIds.size === 1) {
      upsertJob(nextState, { type: "asset-image", scopeId: assets[0].id, label: `${assets[0].name} 资产图生成中`, status: "running" });
    } else {
      upsertJob(nextState, { type: "generate", scopeId: "asset-images", label: `正在生成 ${assets.length} 张资产图`, status: "running" });
      for (const asset of assets) {
        upsertJob(nextState, { type: "asset-image", scopeId: asset.id, label: `${asset.name} 资产图生成中`, status: "running" });
      }
    }
    touchState(nextState);
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return { state: nextState, duplicate: false };
  });
  if (start.duplicate) {
    return { ok: true, state: start.state, outputs: [], job: start.job, duplicate: true };
  }

  const imageAdapter = resolveModelAdapter(config, "assetImageModel");
  const outputs = await runConcurrent(assets, 2, async (asset) => {
    const prompt = buildAssetImagePrompt(config, asset);
    const style = activeProjectStyle(config.project);
    const referenceImages = await projectStyleReferenceImages(style);
    try {
      const result = await callImage(imageAdapter, prompt, assetReferenceAspect(asset.type), () => mockAssetImage(config, asset), { referenceImages });
      return {
        id: `ASSETIMG-${asset.id}`,
        assetId: asset.id,
        assetType: asset.type,
        name: asset.name,
        prompt,
        model: imageAdapter.model || "",
        styleReferenceImages: referenceImages.map(publicReferenceImageInfo),
        referenceStandard: assetReferenceStandard(asset.type),
        source: result.source,
        adapterError: result.error || "",
        url: result.data.url,
        file: result.data.file || null,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        id: `ASSETIMG-${asset.id}`,
        assetId: asset.id,
        assetType: asset.type,
        name: asset.name,
        prompt,
        model: imageAdapter.model || "",
        styleReferenceImages: referenceImages.map(publicReferenceImageInfo),
        referenceStandard: assetReferenceStandard(asset.type),
        source: "adapter-error",
        adapterError: publicError(error),
        url: "",
        file: null,
        createdAt: new Date().toISOString()
      };
    }
  });

  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    const successfulOutputs = outputs.filter((output) => output.url);
    if (successfulOutputs.length) {
      nextState.assetImages = mergeById(nextState.assetImages || [], successfulOutputs);
    }
    nextState.assetImageHistory = normalizeAssetImageHistory(nextState.assetImageHistory, nextState.assetImages);
    for (const output of outputs) {
      if (output.url) {
        nextState.assetImageHistory[output.assetId] = addAssetImageHistoryEntry(nextState.assetImageHistory[output.assetId] || [], output);
      }
      finishJob(nextState, "asset-image", output.assetId, output.url ? "succeeded" : "failed", {
        label: `${output.name} 资产图${output.url ? "已完成" : "失败"}`,
        error: output.adapterError || "",
        result: output.url ? { url: output.url } : null
      });
    }
    if (!requestedIds.size || assets.length > 1) {
      finishJob(nextState, "generate", "asset-images", outputs.some((item) => item.url) ? "succeeded" : "failed", {
        label: `${outputs.filter((item) => item.url).length}/${outputs.length} 张资产图已完成`,
        error: errorSummary(outputs)
      });
    }
    for (const episode of nextState.episodes || []) {
      episode.promptPackages = hydratePromptPackageReferences(episode.promptPackages || [], nextState.cards, nextState.assetImages);
    }
    touchState(nextState);
    addEvent(nextState, "assetImages.generated", `${outputs.length} 张资产参考图已生成`, sourceSummary(outputs), errorSummary(outputs));
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, outputs };
}

async function generatePromptPackages(payload = {}) {
  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const singleShotId = requestedIds.size === 1 ? [...requestedIds][0] : "";
  const type = singleShotId ? "prompt-package" : "generate";
  const scopeId = singleShotId || "prompt-packages";
  const existing = await getRunningJobSnapshot(type, scopeId);
  if (existing) {
    return { ok: true, state: existing.state, job: existing.job, duplicate: true };
  }
  const start = await markJobRunning(type, scopeId, singleShotId ? `${singleShotId} 提示词生成中` : "分镜提示词批量生成中");
  if (start.duplicate) {
    return { ok: true, state: start.state, job: start.job, duplicate: true };
  }
  try {
    const response = await doGeneratePromptPackages(payload);
    await markJobFinished(type, scopeId, "succeeded", {
      label: singleShotId ? `${singleShotId} 提示词已完成` : "分镜提示词批量完成",
      result: { source: response.source || "" }
    });
    return { ...response, state: await readState() };
  } catch (error) {
    await markJobFinished(type, scopeId, "failed", {
      label: singleShotId ? `${singleShotId} 提示词生成失败` : "分镜提示词批量失败",
      error: publicError(error)
    });
    throw error;
  }
}

async function doGeneratePromptPackages(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episode = payload.episodeId
    ? state.episodes.find((item) => item.id === payload.episodeId)
    : requireActiveEpisode(state);
  if (!episode) {
    throw new Error("剧集不存在");
  }
  if (!episode.shots.length) {
    throw new Error("请先生成 15s 分镜");
  }
  if (!countCards(state.cards)) {
    throw new Error("请先提取资产卡");
  }

  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const selectedShots = requestedIds.size ? episode.shots.filter((shot) => requestedIds.has(shot.id)) : episode.shots;
  const shots = selectedShots.map((shot) => ({ ...shot, durationSec: 15 }));
  const prompt = buildPromptPackagesPrompt(config, shots, state.cards, state.assetImages || [], episode);
  const result = await callLlmJson(resolveModelAdapter(config, "promptPackageLlm"), prompt, () => mockPromptPackages(config, shots, state.cards, state.assetImages || []));
  const outputs = normalizePromptPackages(result.data, shots, state.cards, state.assetImages || [], result.source, result.error || "", activeVideoProfile(config));

  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    const latestEpisode = (nextState.episodes || []).find((item) => item.id === episode.id);
    if (!latestEpisode) {
      throw new Error("剧集不存在");
    }
    const hydratedOutputs = hydratePromptPackageReferences(outputs, nextState.cards, nextState.assetImages || []);
    latestEpisode.promptPackages = mergeById(latestEpisode.promptPackages || [], hydratedOutputs);
    const updatedShotIds = new Set(hydratedOutputs.map((pack) => pack.shotId).filter(Boolean));
    latestEpisode.videos = (latestEpisode.videos || []).map((video) => updatedShotIds.has(video.shotId)
      ? {
        ...video,
        stale: true,
        staleReason: "prompt-updated",
        staleAt: new Date().toISOString()
      }
      : video);
    touchEpisode(latestEpisode);
    touchState(nextState);
    addEvent(nextState, "promptPackages.generated", `${latestEpisode.title} 已生成 ${outputs.length} 个 Seedance 分镜提示词包`, result.source, result.error);
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, source: result.source, adapterError: result.error || "" };
}

async function generateImages(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episode = requireActiveEpisode(state);
  if (!episode.shots.length) {
    throw new Error("请先生成分镜");
  }

  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const shots = requestedIds.size ? episode.shots.filter((shot) => requestedIds.has(shot.id)) : episode.shots;
  const outputs = [];

  for (const shot of shots) {
    const prompt = buildImagePrompt(config, shot, state.cards);
    const result = await callImage(resolveModelAdapter(config, "storyboardImageModel"), prompt, config.project.aspectRatio, () => mockImage(config, shot, state.cards));
    outputs.push({
      id: `IMG-${shot.id}`,
      shotId: shot.id,
      prompt,
      source: result.source,
      adapterError: result.error || "",
      url: result.data.url,
      file: result.data.file || null,
      createdAt: new Date().toISOString()
    });
  }

  episode.images = mergeById(episode.images || [], outputs);
  episode.videos = (episode.videos || []).filter((video) => episode.images.some((image) => image.shotId === video.shotId));
  touchEpisode(episode);
  touchState(state);
  addEvent(state, "images.generated", `${outputs.length} 张故事板图已生成`, sourceSummary(outputs), errorSummary(outputs));
  await writeState(state);
  return { ok: true, state, outputs };
}

async function generateVideos(payload = {}) {
  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const singleShotId = requestedIds.size === 1 ? [...requestedIds][0] : "";
  const scopeId = singleShotId || "video-clips";
  const existing = await getRunningJobSnapshot("video-clip", scopeId);
  if (existing) {
    return { ok: true, state: existing.state, job: existing.job, duplicate: true };
  }
  const start = await markJobRunning("video-clip", scopeId, singleShotId ? `${singleShotId} 视频片段提交中` : "Seedance 视频片段提交中");
  if (start.duplicate) {
    return { ok: true, state: start.state, job: start.job, duplicate: true };
  }
  try {
    const response = await doGenerateVideos(payload);
    await markJobFinished("video-clip", scopeId, response.outputs.some((item) => item.adapterError) && !response.outputs.some((item) => item.taskId || item.url) ? "failed" : "succeeded", {
      label: singleShotId ? `${singleShotId} 视频任务已提交` : `已提交 ${response.outputs.length} 个视频任务`,
      error: errorSummary(response.outputs),
      result: { count: response.outputs.length, source: sourceSummary(response.outputs) }
    });
    return { ...response, state: await readState() };
  } catch (error) {
    await markJobFinished("video-clip", scopeId, "failed", {
      label: singleShotId ? `${singleShotId} 视频片段提交失败` : "Seedance 视频片段提交失败",
      error: publicError(error)
    });
    throw error;
  }
}

async function doGenerateVideos(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episode = payload.episodeId
    ? (state.episodes || []).find((item) => item.id === payload.episodeId)
    : requireActiveEpisode(state);
  if (!episode) {
    throw new Error("剧集不存在");
  }
  if (!(episode.promptPackages || []).length) {
    throw new Error("请先在分镜制作中生成 Seedance 提示词包");
  }

  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const packages = requestedIds.size
    ? (episode.promptPackages || []).filter((pack) => requestedIds.has(pack.shotId) || requestedIds.has(pack.id))
    : (episode.promptPackages || []);
  if (!packages.length) {
    throw new Error("没有可提交的视频提示词包");
  }

  const adapter = resolveModelAdapter(config, "videoModel");
  const shotsById = new Map((episode.shots || []).map((shot) => [shot.id, shot]));
  const assets = flattenCards(state.cards);
  const hydratedPackages = hydratePromptPackageReferences(packages, state.cards, state.assetImages || []);
  const outputs = await runConcurrent(hydratedPackages, 1, async (pack) => {
    const shot = shotsById.get(pack.shotId) || {};
    const id = `VID-${pack.shotId || pack.id}`;
    const prompt = buildSeedanceVideoPrompt(config, pack, shot, assets, state.assetImages || []);
    try {
      const referenceImages = await prepareSeedanceReferenceImages(adapter, pack, assets, state.assetImages || []);
      const result = await callVideo(adapter, {
        prompt,
        shot,
        pack,
        config,
        referenceImages
      }, () => mockVideo(config, shot, referenceImages[0] || { url: "" }));
      return normalizeVideoOutput(id, pack, shot, prompt, adapter, result, referenceImages, config);
    } catch (error) {
      return {
        id,
        shotId: pack.shotId || shot.id || "",
        packageId: pack.id || "",
        prompt,
        requestPayload: sanitizeVideoRequestPayload(buildSeedanceVideoPayload(config, adapter, prompt, [], pack, shot)),
        referenceImages: [],
        source: "adapter-error",
        adapterError: publicError(error),
        status: "failed",
        taskId: "",
        url: "",
        file: null,
        kind: "video",
        model: adapter.model || "",
        resolution: adapter.resolution || APIMART_SEEDANCE_RESOLUTION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
  });

  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    const latestEpisode = (nextState.episodes || []).find((item) => item.id === episode.id);
    if (!latestEpisode) {
      throw new Error("剧集不存在");
    }
    latestEpisode.videos = mergeById(latestEpisode.videos || [], outputs);
    touchEpisode(latestEpisode);
    touchState(nextState);
    addEvent(nextState, "videos.submitted", `${latestEpisode.title} 已提交 ${outputs.length} 个 Seedance 2.0 视频任务`, sourceSummary(outputs), errorSummary(outputs));
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, outputs, source: sourceSummary(outputs), adapterError: errorSummary(outputs) };
}

async function refreshVideoTasks(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episodes = payload.episodeId
    ? (state.episodes || []).filter((item) => item.id === payload.episodeId)
    : (state.episodes || []);
  if (!episodes.length) {
    throw new Error(payload.episodeId ? "剧集不存在" : "请先创建剧集");
  }
  const requestedTaskIds = new Set(Array.isArray(payload.taskIds) ? payload.taskIds : []);
  const requestedVideoIds = new Set(Array.isArray(payload.videoIds) ? payload.videoIds : []);
  const pendingVideos = episodes.flatMap((episode) => (episode.videos || [])
    .filter((video) => {
      if (!video.taskId) return false;
      if (requestedTaskIds.size && !requestedTaskIds.has(video.taskId)) return false;
      if (requestedVideoIds.size && !requestedVideoIds.has(video.id)) return false;
      return !["completed", "failed", "cancelled"].includes(String(video.status || "").toLowerCase()) || payload.force === true;
    })
    .map((video) => ({ ...video, episodeId: episode.id })));
  if (!pendingVideos.length) {
    return { ok: true, state, outputs: [] };
  }
  const adapter = resolveModelAdapter(config, "videoModel");
  const outputs = await runConcurrent(pendingVideos, 2, async (video) => {
    try {
      const result = await fetchVideoTaskStatus(adapter, video.taskId);
      return mergeVideoTaskStatus(video, result);
    } catch (error) {
      return {
        ...video,
        status: video.status || "submitted",
        adapterError: publicError(error),
        updatedAt: new Date().toISOString()
      };
    }
  });

  const latestState = await withStateWriteLock(async () => {
    const nextState = await readState();
    const outputsByEpisode = new Map();
    for (const output of outputs) {
      const episodeId = output.episodeId || pendingVideos.find((video) => video.id === output.id)?.episodeId || "";
      if (!episodeId) continue;
      outputsByEpisode.set(episodeId, [...(outputsByEpisode.get(episodeId) || []), output]);
    }
    for (const [episodeId, episodeOutputs] of outputsByEpisode.entries()) {
      const latestEpisode = (nextState.episodes || []).find((item) => item.id === episodeId);
      if (!latestEpisode) continue;
      latestEpisode.videos = mergeById(latestEpisode.videos || [], episodeOutputs);
      touchEpisode(latestEpisode);
    }
    touchState(nextState);
    addEvent(nextState, "videos.status", `已刷新 ${outputs.length} 个 Seedance 视频任务状态`, "adapter", errorSummary(outputs));
    await writeState(nextState);
    await syncActiveProject({ state: nextState });
    return nextState;
  });
  return { ok: true, state: latestState, outputs };
}

async function callLlmJson(adapter, prompt, fallbackFactory) {
  if (canUseAdapter(adapter)) {
    try {
      const endpoint = resolveOpenAiCompatibleEndpoint(adapter.endpoint, "/chat/completions");
      const response = await postJson(endpoint, adapter.apiKey, {
        model: adapter.model,
        messages: [
          {
            role: "system",
            content: "你是一个本地 AI 漫剧工作台的结构化生成器。只输出 JSON，不要输出 Markdown。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.75,
        response_format: { type: "json_object" }
      }, adapter.timeoutMs);
      const content = response?.choices?.[0]?.message?.content || response?.output_text || response?.text;
      return {
        source: "adapter",
        data: parseJsonPayload(content || response)
      };
    } catch (error) {
      console.warn(`LLM adapter failed: ${error.message}`);
      if (!shouldFallbackToMock(adapter)) {
        throw new Error(`LLM adapter failed: ${publicError(error)}`);
      }
      return { source: "mock-fallback", error: publicError(error), data: fallbackFactory(error) };
    }
  }
  const skipReason = adapterSkipReason(adapter);
  if (skipReason && !shouldFallbackToMock(adapter)) {
    throw new Error(`LLM ${skipReason}`);
  }
  return { source: providerIsMock(adapter) ? "mock" : "mock-fallback", error: skipReason, data: fallbackFactory() };
}

async function callImage(adapter, prompt, aspectRatio, fallbackFactory, options = {}) {
  if (canUseAdapter(adapter)) {
    try {
      const endpoint = resolveAdapterEndpoint(adapter, "/images/generations");
      const payload = buildImagePayload(adapter, prompt, aspectRatio, options);
      let response;
      try {
        response = await postJson(endpoint, adapter.apiKey, payload, adapter.timeoutMs);
      } catch (error) {
        if (!hasReferenceImages(options) || !isLikelyUnsupportedReferenceImageError(error)) {
          throw error;
        }
        console.warn(`Image adapter rejected reference image fields; retrying with prompt only: ${error.message}`);
        response = await postJson(endpoint, adapter.apiKey, buildImagePayload(adapter, prompt, aspectRatio), adapter.timeoutMs);
      }
      throwIfAdapterError(response);
      const asset = extractImageAsset(response);
      if (asset.base64) {
        const file = await writeBase64Asset(IMAGE_DIR, `adapter-${Date.now()}.png`, asset.base64);
        return { source: "adapter", data: { url: cacheUrl(file), file } };
      }
      if (asset.url) {
        return { source: "adapter", data: { url: asset.url, file: null } };
      }
      throw new Error(`Image adapter response did not include a usable image asset. Shape: ${summarizeAdapterResponse(response)}`);
    } catch (error) {
      console.warn(`Image adapter failed: ${error.message}`);
      if (!shouldFallbackToMock(adapter)) {
        throw new Error(`Image adapter failed: ${publicError(error)}`);
      }
      return { source: "mock-fallback", error: publicError(error), data: await fallbackFactory(error) };
    }
  }
  const skipReason = adapterSkipReason(adapter);
  if (skipReason && !shouldFallbackToMock(adapter)) {
    throw new Error(`Image ${skipReason}`);
  }
  return { source: providerIsMock(adapter) ? "mock" : "mock-fallback", error: skipReason, data: await fallbackFactory() };
}

function buildImagePayload(adapter, prompt, aspectRatio, options = {}) {
  const payload = {
        model: adapter.model,
        prompt,
        n: 1,
        size: imageSizeForAspect(aspectRatio)
  };
  const refs = normalizeReferenceImages(options.referenceImages);
  if (refs.length) {
    payload.reference_images = refs.map((item) => item.url);
    payload.reference_image_urls = refs.map((item) => item.url);
    payload.image_urls = refs.map((item) => item.url);
    payload.images = refs.map((item) => ({
      url: item.url,
      image_url: item.url,
      type: item.kind || "reference",
      name: item.name || ""
    }));
  }
  return payload;
}

function normalizeReferenceImages(referenceImages = []) {
  return (Array.isArray(referenceImages) ? referenceImages : [])
    .map((item) => typeof item === "string" ? { url: item } : item)
    .filter((item) => item?.url)
    .slice(0, 4);
}

function hasReferenceImages(options = {}) {
  return normalizeReferenceImages(options.referenceImages).length > 0;
}

function isLikelyUnsupportedReferenceImageError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return [
    "reference_images",
    "reference_image_urls",
    "image_urls",
    "unknown parameter",
    "unsupported parameter",
    "unexpected field",
    "invalid field",
    "unrecognized",
    "not allowed"
  ].some((term) => text.includes(term));
}

async function callVideo(adapter, request, fallbackFactory) {
  if (canUseAdapter(adapter)) {
    try {
      if (adapter.provider === "apimart-seedance") {
        return callApimartSeedanceVideo(adapter, request);
      }
      const endpoint = adapter.endpoint.trim();
      const prompt = typeof request === "string" ? request : request.prompt || "";
      const firstImage = Array.isArray(request.referenceImages) ? request.referenceImages[0] : null;
      const response = await postJson(endpoint, adapter.apiKey, {
        model: adapter.model,
        prompt,
        image_url: firstImage?.url || "",
        duration: request.pack?.durationSec || request.shot?.durationSec || 5
      }, adapter.timeoutMs);
      throwIfAdapterError(response);
      const item = response?.data?.[0] || response?.videos?.[0] || response?.output?.[0] || response;
      const url = findVideoUrl(item);
      const taskId = item?.task_id || item?.taskId || item?.id || "";
      if (!url && !taskId) {
        throw new Error("Video adapter response did not include a video URL or task ID");
      }
      return { source: "adapter", data: { url, taskId, status: item?.status || (url ? "completed" : "submitted"), raw: summarizeAdapterResponse(response), file: null, kind: "video" } };
    } catch (error) {
      console.warn(`Video adapter failed: ${error.message}`);
      if (!shouldFallbackToMock(adapter)) {
        throw new Error(`Video adapter failed: ${publicError(error)}`);
      }
      return { source: "mock-fallback", error: publicError(error), data: await fallbackFactory(error) };
    }
  }
  const skipReason = adapterSkipReason(adapter);
  if (skipReason && !shouldFallbackToMock(adapter)) {
    throw new Error(`Video ${skipReason}`);
  }
  return { source: providerIsMock(adapter) ? "mock" : "mock-fallback", error: skipReason, data: await fallbackFactory() };
}

async function callApimartSeedanceVideo(adapter, request = {}) {
  const prompt = clampPromptLength(request.prompt || "", 3900);
  const payload = buildSeedanceVideoPayload(request.config || DEFAULT_CONFIG, adapter, prompt, request.referenceImages || [], request.pack || {}, request.shot || {});
  const endpoint = resolveApimartSeedanceEndpoint(adapter);
  const response = await postJson(endpoint, adapter.apiKey, payload, adapter.timeoutMs);
  throwIfAdapterError(response);
  const item = response?.data?.[0] || response?.data || response;
  const taskId = item?.task_id || item?.taskId || item?.id || "";
  if (!taskId) {
    throw new Error(`Seedance response did not include task_id. Shape: ${summarizeAdapterResponse(response)}`);
  }
  return {
    source: "adapter",
    data: {
      taskId,
      status: item?.status || "submitted",
      url: findVideoUrl(item),
      file: null,
      kind: "seedance-task",
      requestPayload: sanitizeVideoRequestPayload(payload),
      raw: summarizeAdapterResponse(response)
    }
  };
}

function resolveApimartSeedanceEndpoint(adapter = {}) {
  const endpoint = String(adapter.endpoint || "").trim();
  if (!endpoint || endpoint === "https://api.apimart.ai/v1") {
    return APIMART_SEEDANCE_ENDPOINT;
  }
  if (endpoint.endsWith("/v1")) {
    return `${endpoint}/videos/generations`;
  }
  return endpoint;
}

function resolveApimartTaskEndpoint(adapter = {}, taskId = "") {
  const endpoint = resolveApimartSeedanceEndpoint(adapter);
  const base = endpoint.replace(/\/videos\/generations\/?$/i, "").replace(/\/+$/, "");
  return `${base}/tasks/${encodeURIComponent(taskId)}?language=zh`;
}

function buildSeedanceVideoPayload(config = DEFAULT_CONFIG, adapter = {}, prompt = "", referenceImages = [], pack = {}, shot = {}) {
  const payload = {
    model: adapter.model || APIMART_SEEDANCE_MODEL,
    prompt: clampPromptLength(prompt, 3900),
    resolution: adapter.resolution || APIMART_SEEDANCE_RESOLUTION,
    size: seedanceSize(config.project?.aspectRatio),
    duration: seedanceDuration(pack.durationSec || shot.durationSec || 15),
    generate_audio: shouldGenerateSeedanceAudio(config, pack)
  };
  const publicUrls = normalizeSeedanceReferenceImages(referenceImages).map((item) => item.remoteUrl || item.url).filter(Boolean);
  if (publicUrls.length) {
    payload.image_urls = publicUrls.slice(0, Number(adapter.maxReferenceImages || 9));
  }
  return payload;
}

function seedanceSize(aspectRatio = "9:16") {
  const value = String(aspectRatio || "").trim();
  return ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(value) ? value : "9:16";
}

function seedanceDuration(value) {
  const duration = Math.round(Number(value) || 15);
  return Math.max(5, Math.min(15, duration));
}

function shouldGenerateSeedanceAudio(config = DEFAULT_CONFIG, pack = {}) {
  if (config.project?.subtitles === "off" && !(pack.dialogue || []).length && !pack.soundDesign) {
    return false;
  }
  return true;
}

function normalizeSeedanceReferenceImages(referenceImages = []) {
  return (Array.isArray(referenceImages) ? referenceImages : [])
    .map((image) => typeof image === "string" ? { url: image } : image)
    .filter((image) => image?.url || image?.remoteUrl)
    .slice(0, MAX_SHOT_ASSET_REFS);
}

function buildSeedanceVideoPrompt(config, pack = {}, shot = {}, assets = [], assetImages = []) {
  const refs = pack.assetRefs?.length ? pack.assetRefs : [...new Set((pack.subShots || []).flatMap((subShot) => subShot.assetRefs || []))];
  const references = assetReferencesForRefs(refs, assets, assetImages);
  const audio = pack.audio || [];
  const dialogue = pack.dialogue || [];
  const subShots = pack.subShots || [];
  const style = activeProjectStyle(config.project || {});
  const assetBlock = references.length ? `指定参考资产：\n${references.map((asset, index) => {
    const label = `${index + 1}. @${asset.id} ${asset.name || ""}`.trim();
    const type = asset.type ? `，${asset.type}` : "";
    const image = asset.imageUrl ? `，reference_image: ${asset.imageUrl}` : "";
    return `${label}${type}${image}`;
  }).join("\n")}` : "";
  return [
    pack.seedancePrompt || buildSeedancePromptFromPackage(pack, shot, assets, assetImages),
    style.prompt ? `项目统一风格：${style.prompt}` : "",
    assetBlock,
    pack.soundDesign ? `分镜音效：\n${pack.soundDesign}` : "",
    audio.length ? `音效时间轴：\n${audio.map((row) => `${row.timeRange || ""} ${row.content || ""}${row.assetRefs?.length ? ` 关联资产：${row.assetRefs.map((id) => `@${id}`).join(" ")}` : ""}`.trim()).join("\n")}` : "",
    dialogue.length ? `分镜台词：\n${dialogue.map((row) => `${row.timeRange || ""} ${row.speakerAssetId ? `@${row.speakerAssetId}` : ""}${row.voice ? ` ${row.voice}` : ""}: ${row.text || ""}`.trim()).join("\n")}` : "",
    subShots.length ? `分镜提示词：\n${subShots.map((subShot) => [
      subShot.timeRange ? `[${subShot.timeRange}]` : "",
      subShot.cameraLanguage || "",
      subShot.blocking || "",
      subShot.composition || "",
      subShot.action || "",
      subShot.assetRefs?.length ? `参考资产：${subShot.assetRefs.map((id) => `@${id}`).join(" ")}` : ""
    ].filter(Boolean).join("；")).join("\n")}` : "",
    "要求：严格保持项目风格、角色身份、场景布局、道具外观一致；不要新增未指定角色；不要生成字幕水印。"
  ].filter(Boolean).join("\n\n");
}

async function prepareSeedanceReferenceImages(adapter, pack = {}, assets = [], assetImages = []) {
  const refs = pack.assetRefs?.length ? pack.assetRefs : [...new Set((pack.subShots || []).flatMap((subShot) => subShot.assetRefs || []))];
  const references = assetReferencesForRefs(refs, assets, assetImages)
    .filter((asset) => asset.imageUrl)
    .slice(0, MAX_SHOT_ASSET_REFS);
  if (!references.length) {
    return [];
  }
  if (adapter.provider !== "apimart-seedance") {
    return references.map((asset) => ({ ...asset, url: asset.imageUrl, remoteUrl: asset.imageUrl, mode: "direct" }));
  }
  return runConcurrent(references, 2, async (asset) => {
    const remoteUrl = await ensureApimartImageUrl(adapter, asset.imageUrl, `${asset.id}-${asset.name || "asset"}`);
    return {
      ...asset,
      url: remoteUrl || asset.imageUrl,
      remoteUrl: remoteUrl || "",
      originalUrl: asset.imageUrl,
      mode: remoteUrl && remoteUrl !== asset.imageUrl ? "uploaded" : "direct"
    };
  });
}

async function ensureApimartImageUrl(adapter, imageUrl, name = "asset") {
  const value = String(imageUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("asset://")) {
    return value;
  }
  const localPath = localCachePathFromUrl(value);
  if (!localPath) {
    throw new Error(`Seedance reference image must be a public URL, asset:// URL, or local /cache image: ${value}`);
  }
  const cacheKey = `${adapter.modelConfigId || "default"}:${value}`;
  const cached = apimartUploadCache.get(cacheKey);
  if (cached && cached.url && Date.now() - cached.createdAt < APIMART_UPLOAD_TTL_MS) {
    return cached.url;
  }
  const uploadUrl = await uploadImageToApimart(adapter, localPath, name);
  apimartUploadCache.set(cacheKey, { url: uploadUrl, createdAt: Date.now() });
  return uploadUrl;
}

async function uploadImageToApimart(adapter, filePath, name = "asset") {
  const bytes = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase() || ".png";
  const filename = `${safeFileName(name)}${ext}`;
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeTypeForImagePath(filePath) });
  form.append("file", blob, filename);
  const endpoint = resolveApimartSeedanceEndpoint(adapter).replace(/\/videos\/generations\/?$/i, "/uploads/images");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${adapter.apiKey}`
    },
    body: form
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // APIMart should return JSON, keep text for error reporting if it does not.
  }
  if (!response.ok) {
    const message = typeof data === "string" ? data : data?.error?.message || JSON.stringify(data);
    throw new Error(`APIMart image upload failed HTTP ${response.status}: ${message}`);
  }
  const url = data?.url || data?.data?.url || findImageUrl(data);
  if (!url) {
    throw new Error(`APIMart image upload response did not include url. Shape: ${summarizeAdapterResponse(data)}`);
  }
  return url;
}

async function fetchVideoTaskStatus(adapter, taskId) {
  if (!taskId) {
    throw new Error("Missing task id");
  }
  if (!canUseAdapter(adapter)) {
    throw new Error(`Video ${adapterSkipReason(adapter) || "adapter unavailable"}`);
  }
  if (adapter.provider !== "apimart-seedance") {
    throw new Error("当前视频模型暂不支持自动刷新任务状态");
  }
  const endpoint = resolveApimartTaskEndpoint(adapter, taskId);
  const response = await getJson(endpoint, adapter.apiKey, adapter.timeoutMs);
  throwIfAdapterError(response);
  const data = response?.data || response;
  return normalizeVideoTaskStatus(data, response);
}

function normalizeVideoTaskStatus(data = {}, raw = {}) {
  const result = data.result || data.output || data;
  const status = String(data.status || "").toLowerCase() || "unknown";
  const url = findVideoUrl(result) || findVideoUrl(data);
  const thumbnailUrl = result.thumbnail_url || result.thumbnailUrl || data.thumbnail_url || "";
  const error = data.error?.message || data.error || data.fail_reason || "";
  return {
    taskId: data.id || data.task_id || "",
    status,
    progress: Number.isFinite(Number(data.progress)) ? Number(data.progress) : null,
    cost: Number.isFinite(Number(data.cost)) ? Number(data.cost) : null,
    url,
    thumbnailUrl,
    adapterError: typeof error === "string" ? error : JSON.stringify(error || ""),
    raw: summarizeAdapterResponse(raw)
  };
}

function mergeVideoTaskStatus(video = {}, task = {}) {
  return {
    ...video,
    taskId: task.taskId || video.taskId || "",
    status: task.status || video.status || "",
    progress: task.progress ?? video.progress ?? null,
    cost: task.cost ?? video.cost ?? null,
    thumbnailUrl: task.thumbnailUrl || video.thumbnailUrl || "",
    url: task.url || video.url || "",
    adapterError: task.adapterError || video.adapterError || "",
    rawStatus: task.raw || video.rawStatus || "",
    updatedAt: new Date().toISOString()
  };
}

function normalizeVideoOutput(id, pack = {}, shot = {}, prompt = "", adapter = {}, result = {}, referenceImages = [], config = DEFAULT_CONFIG) {
  const data = result.data || {};
  const now = new Date().toISOString();
  return {
    id,
    shotId: pack.shotId || shot.id || "",
    packageId: pack.id || "",
    prompt,
    requestPayload: sanitizeVideoRequestPayload(data.requestPayload || buildSeedanceVideoPayload(config, adapter, prompt, referenceImages, pack, shot)),
    referenceImages: referenceImages.map(publicVideoReferenceImage),
    source: result.source || "adapter",
    adapterError: result.error || "",
    status: data.status || (data.url ? "completed" : data.taskId ? "submitted" : ""),
    progress: data.url ? 100 : null,
    stale: false,
    staleReason: "",
    staleAt: "",
    taskId: data.taskId || "",
    url: data.url || "",
    file: data.file || null,
    kind: data.kind || "video",
    model: adapter.model || "",
    resolution: adapter.resolution || APIMART_SEEDANCE_RESOLUTION,
    createdAt: now,
    updatedAt: now
  };
}

function publicVideoReferenceImage(image = {}) {
  return {
    id: image.id || "",
    type: image.type || "",
    name: image.name || "",
    url: image.url || image.remoteUrl || "",
    originalUrl: image.originalUrl || image.imageUrl || "",
    mode: image.mode || ""
  };
}

function sanitizeVideoRequestPayload(payload = {}) {
  return {
    ...payload,
    prompt: clampPromptLength(payload.prompt || "", 3900),
    image_urls: Array.isArray(payload.image_urls) ? payload.image_urls : undefined
  };
}

function clampPromptLength(prompt = "", maxLength = 3900) {
  const text = String(prompt || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 24)}\n[内容因接口限制已截断]`;
}

function buildScriptPrompt(config) {
  const project = config.project;
  return JSON.stringify({
    task: "create_script",
    requirement: "生成 4 场以内、适合短视频漫剧的结构化剧本 JSON。",
    schema: {
      title: "string",
      logline: "string",
      synopsis: "string",
      scenes: [
        {
          id: "SC01",
          title: "string",
          location: "string",
          timeOfDay: "string",
          mood: "string",
          action: "string",
          narration: "string",
          dialogue: [{ speaker: "string", text: "string" }],
          visualNotes: "string"
        }
      ]
    },
    project
  });
}

function buildEpisodeScriptPrompt(config, state, episodeInfo = {}) {
  const projectScript = state.storyScript || scriptFromUserText(config.project.title || "未命名项目", config.project.logline || "", config);
  const previousEpisode = [...(state.episodes || [])]
    .filter((episode) => Number(episode.order || 0) < Number(episodeInfo.order || 1))
    .sort((a, b) => Number(b.order || 0) - Number(a.order || 0))[0] || null;
  const previousShots = (previousEpisode?.shots || []).map((shot) => ({
    id: shot.id,
    action: shot.action,
    dialogue: shot.dialogue,
    continuity: shot.continuity
  })).slice(-6);
  return JSON.stringify({
    task: "create_episode_script",
    requirement: "根据项目总剧本和上一集内容，续写当前单集剧本，并返回结构化 JSON。保持故事连贯、角色状态连续、结尾有钩子，适合后续拆成 15s 分镜。",
    rules: [
      "Return JSON only with shape { script: {...} }.",
      "Do not rewrite the whole project; write only the current episode.",
      "Use the inherited project video length as the target episode length.",
      "Continue from previousEpisode when present; otherwise start from the project opening.",
      "Keep existing asset names and character identities consistent."
    ],
    schema: {
      script: {
        title: "string",
        logline: "string",
        synopsis: "string",
        previousRecap: "string",
        episodeGoal: "string",
        endingHook: "string",
        continuityNotes: "string",
        scenes: [
          {
            id: "SC01",
            title: "string",
            location: "string",
            timeOfDay: "string",
            mood: "string",
            action: "string",
            narration: "string",
            dialogue: [{ speaker: "string", text: "string" }],
            visualNotes: "string"
          }
        ]
      }
    },
    project: {
      title: config.project.title,
      logline: config.project.logline,
      attributes: projectAttributes(config.project),
      storyScript: projectScript
    },
    episode: {
      title: episodeInfo.title || `第 ${episodeInfo.order || 1} 集`,
      order: episodeInfo.order || 1,
      targetLength: config.project.videoLength || config.project.episodeDuration || "",
      note: episodeInfo.note || ""
    },
    previousEpisode: previousEpisode ? {
      title: previousEpisode.title,
      order: previousEpisode.order,
      synopsis: previousEpisode.synopsis || previousEpisode.script?.synopsis || "",
      script: previousEpisode.script || null,
      recentShots: previousShots
    } : null,
    existingAssets: compactAssetCatalog(state.cards)
  });
}

async function generateEpisodeScriptContent(config, state, episodeInfo = {}) {
  const prompt = buildEpisodeScriptPrompt(config, state, episodeInfo);
  const result = await callLlmJson(resolveModelAdapter(config, "episodeScriptLlm"), prompt, () => mockEpisodeScript(config, state, episodeInfo));
  const script = normalizeScript(result.data?.script || result.data, {
    ...config,
    project: {
      ...config.project,
      title: episodeInfo.title || config.project.title,
      logline: episodeInfo.note || config.project.logline
    }
  }, result.source);
  script.title = episodeInfo.title || script.title;
  script.adapterError = result.error || "";
  return {
    script,
    source: result.source,
    adapterError: result.error || ""
  };
}

function compactAssetCatalog(cards = {}) {
  return {
    characters: (cards.characters || []).map((card) => ({
      id: card.id,
      name: card.name,
      aliases: card.aliases || [],
      role: card.role || "",
      appearance: card.appearance || "",
      personality: card.personality || ""
    })).slice(0, 16),
    locations: (cards.locations || []).map((card) => ({
      id: card.id,
      name: card.name,
      aliases: card.aliases || [],
      atmosphere: card.atmosphere || "",
      layout: card.layout || ""
    })).slice(0, 16),
    props: (cards.props || []).map((card) => ({
      id: card.id,
      name: card.name,
      aliases: card.aliases || [],
      function: card.function || "",
      look: card.look || ""
    })).slice(0, 16)
  };
}

function buildShotsPrompt(config, script, episode = {}) {
  return JSON.stringify({
    task: "create_15s_video_shots",
    rules: [
      "Return JSON only with shape { shots: [...] }.",
      "Each shot is one complete 15-second video segment.",
      "Do not create storyboard images or first-frame prompts here.",
      "Include camera, action, dialogue, continuity, and asset-relevant visual notes for later Seedance prompt packages."
    ],
    requirement: "把剧本拆成 6-10 个 15s 视频分镜，用于后续生成 Seedance 分镜提示词包。不要输出故事板图或首帧图提示词。输出 JSON: { shots: [...] }。",
    shotSchema: {
      id: "SH01",
      sceneId: "SC01",
      order: 1,
      durationSec: 15,
      shotType: "远景/中景/近景/特写",
      camera: "string",
      action: "string",
      dialogue: "string",
      assetNotes: "string",
      visualNotes: "string",
      continuity: "string"
    },
    visualStyle: config.project.visualStyle,
    aspectRatio: config.project.aspectRatio,
    projectAttributes: projectAttributes(config.project),
    episode: {
      id: episode.id || "",
      title: episode.title || "",
      order: episode.order || 1
    },
    script
  });
}

function buildCardsPrompt(config, script, shots, existingCards = {}, assetImages = []) {
  return JSON.stringify({
    task: "select_or_create_shot_assets",
    requirement: "从剧本和分镜选择最重要的视频参考资产，并补充真正缺失的角色卡、场景卡、关键道具卡。优先复用同一项目已有资产，不要为同一角色/场景/道具重复命名。输出 JSON。",
    hardRules: [
      `Each shot can use at most ${MAX_SHOT_ASSET_REFS} visual reference assets.`,
      "Always prefer existingAssets when semantically equivalent, even if the shot uses aliases such as 他、男主角、男大学生、主角名字、房间、卧室、电脑屏幕.",
      "Do not create assets for atmosphere, lighting, weather, emotion, camera movement, subtitle, sound, generic action, or minor temporary clutter.",
      "Only create a new asset when a visually persistent character, location, creature, or key prop is missing from existingAssets.",
      "Keep asset prompts identity-focused: describe stable face, body, outfit, object shape, material, location layout, and recognizable marks only.",
      "Do not bake the global video style, render engine, camera style, lighting style, resolution, aspect ratio, subtitles, or temporary scene mood into asset prompts.",
      "Use project.visualStyle only as context for consistency, not as text to copy into each asset prompt.",
      "selectedAssetRefs must use existing asset ids or ids from the new assets you output.",
      "Return JSON only. Do not return Markdown."
    ],
    priorityRules: [
      "Speaking or acting main character",
      "Main location of the shot",
      "Character or creature affecting the action",
      "Key prop touched, operated, or causing the plot event",
      "Asset with existing reference image",
      "Asset reused across multiple shots"
    ],
    nonAssetExamples: ["雨夜", "霓虹", "烟雾", "速度线", "紧张", "惊恐", "推镜", "字幕", "音效", "普通纸张杂物"],
    outputSchema: {
      selectedAssetRefs: [
        {
          shotId: "SH01",
          assets: [
            { assetId: "CHAR01", importance: 95, reason: "主角、对白说话者、画面中心", source: "existing" }
          ]
        }
      ],
      characters: [],
      locations: [],
      props: []
    },
    cardSchema: {
      characters: [{ id: "CHAR01", name: "string", aliases: ["string"], role: "string", appearance: "string", personality: "string", prompt: "string" }],
      locations: [{ id: "LOC01", name: "string", aliases: ["string"], atmosphere: "string", layout: "string", prompt: "string" }],
      props: [{ id: "PROP01", name: "string", aliases: ["string"], function: "string", look: "string", prompt: "string" }]
    },
    project: config.project,
    projectVisualStyle: projectAttributes(config.project),
    existingAssets: availableAssetCatalog(existingCards, assetImages),
    script,
    shots
  });
}

function buildPromptPackagesPrompt(config, shots, cards, assetImages, episode = {}) {
  return JSON.stringify({
    task: "generate_15s_shot_prompt_packages_for_seedance",
    outputRules: [
      "Return JSON only. Do not return Markdown.",
      "Output shape must be { promptPackages: [...] }.",
      "Each package represents one 15-second shot and must contain audio, dialogue, and 3-5 subShots.",
      "Each subShot must contain timeRange, cameraLanguage, blocking, composition, action, and assetRefs.",
      "Use only asset ids from availableAssets. Do not invent new asset ids.",
      "When availableAssets contains imageUrl, write the seedancePrompt so the video adapter can pair each asset id with its reference image.",
      "For a 15s shot, prefer time ranges: 0.0-3.0, 3.0-7.0, 7.0-10.0, 10.0-15.0.",
      "Keep continuity of character identity, prop positions, scene layout, human scale, and visual style.",
      "Do not create storyboard images or first-frame image prompts."
    ],
    packageSchema: {
      id: "PKG-SH01",
      shotId: "SH01",
      durationSec: 15,
      title: "string",
      soundDesign: "string",
      audio: [{ timeRange: "0.0-3.0", content: "string", assetRefs: ["PROP01"] }],
      dialogue: [{ timeRange: "0.6-2.2", speakerAssetId: "CHAR01", voice: "string", text: "string" }],
      assetRefs: ["CHAR01", "LOC01", "PROP01"],
      subShots: [
        {
          id: "SH01-01",
          timeRange: "0.0-3.0",
          cameraLanguage: "string",
          blocking: "string",
          composition: "string",
          action: "string",
          assetRefs: ["CHAR01", "LOC01", "PROP01"]
        }
      ],
      seedancePrompt: "string"
    },
    project: config.project,
    projectAttributes: projectAttributes(config.project),
    episode: {
      id: episode.id || "",
      title: episode.title || "",
      order: episode.order || 1
    },
    shots,
    availableAssets: availableAssetCatalog(cards, assetImages)
  });
}

function buildAssetImagePrompt(config, asset) {
  const projectStyle = activeProjectStyle(config.project);
  const standard = assetReferenceStandard(asset.type);
  const identity = asset.description || asset.prompt || asset.name;
  const styleDirectives = projectStyle.prompt ? projectStyle.prompt : "use the project's established visual style";
  const blockyStyleBoost = styleNeedsBlockyBoost(styleDirectives) ? [
    "Must be Minecraft-inspired realistic voxel/blocky style.",
    "Use square head, cuboid torso, cuboid arms and legs, blocky hair volumes, voxel-like facial planes, and PBR textured blocks.",
    "Do not generate a normal smooth realistic human, Pixar-like round cartoon, anime figure, Lego/minifigure toy, or soft doll anatomy."
  ].join(" ") : "";
  return [
    "TOP PRIORITY - PROJECT VISUAL STYLE. The asset reference sheet must follow this style before anything else.",
    `Apply this style directly to the asset subject: ${styleDirectives}.`,
    blockyStyleBoost,
    projectStyle.imageUrl ? `A project style reference image is provided in the request. Use it as the global visual standard for rendering style, lighting, material treatment, color palette, line/detail density, block/shape language, and overall finish. Do not copy the subject matter or composition from the style image.` : "",
    `Generate ${asset.name} as: ${styleDirectives}; ${blockyStyleBoost}; ${identity}.`,
    `Asset identity details: ${identity}.`,
    asset.prompt ? `Additional asset identity prompt: ${asset.prompt}.` : "",
    `Create one standardized production asset reference sheet for ${asset.type}: ${asset.name}.`,
    `Reference sheet standard: ${standard}.`,
    "Stability requirements: same identity across all panels, same face/hairstyle/outfit/materials/colors, same proportions and scale, no redesign between views.",
    "Use an orthographic or low-distortion reference-board layout, clear silhouettes, neutral readable lighting, consistent color palette, no watermark, no UI text, no random extra characters or props.",
    "All assets in this project must look like they belong to the same visual production. Match the project style strictly.",
    "Preserve the asset identity exactly; apply project style as rendering treatment only."
  ].filter(Boolean).join("\n");
}

function styleNeedsBlockyBoost(stylePrompt = "") {
  const text = String(stylePrompt || "").toLowerCase();
  return ["我的世界", "minecraft", "block", "voxel", "方块", "体素"].some((term) => text.includes(term));
}

function assetReferenceStandard(type) {
  const normalized = normalizeAssetType(type);
  if (normalized === "character") {
    return [
      "single clean character turnaround sheet",
      "three full-body views in one image: front view, side view, back view",
      "same character, same outfit, same hairstyle, same accessories in every view",
      "neutral standing A-pose or relaxed T-pose, feet visible, hands unobstructed",
      "optional small face close-up and key clothing/accessory callouts only if space allows",
      "plain light background, evenly spaced panels"
    ].join("; ");
  }
  if (normalized === "location") {
    return [
      "multi-angle environment reference sheet",
      "include establishing wide view, reverse angle, left/right angle, and one key-detail view",
      "keep the same floor plan, entrances, landmarks, furniture positions, lighting direction, and material palette across all views",
      "show clear spatial layout useful for video continuity",
      "no characters unless absolutely required for scale, no dramatic camera distortion",
      "plain reference-board composition with separated panels"
    ].join("; ");
  }
  return [
    "prop reference sheet",
    "include front view, side view, back view, top or 3/4 view, and one close-up detail panel",
    "same object, same materials, same colors, same wear marks and recognizable details in every panel",
    "centered product-like view, plain background, readable silhouette and scale",
    "no hands holding the object unless essential"
  ].join("; ");
}

function assetReferenceAspect(type) {
  const normalized = normalizeAssetType(type);
  if (normalized === "character" || normalized === "location") {
    return "16:9";
  }
  return "1:1";
}

function activeProjectStyle(project = {}) {
  const styles = Array.isArray(project.projectStyles) ? project.projectStyles : [];
  const active = styles.find((style) => style.id && style.id === project.activeStyleId)
    || styles.find((style) => style.prompt && style.prompt === project.visualStyle)
    || null;
  return {
    id: active?.id || project.activeStyleId || "",
    name: active?.name || "",
    imageUrl: active?.imageUrl || active?.referenceImage || "",
    prompt: active?.prompt || project.visualStyle || ""
  };
}

async function projectStyleReferenceImages(style = {}) {
  if (!style.imageUrl) return [];
  const dataUrl = await imageReferenceToDataUrl(style.imageUrl);
  return [{
    url: dataUrl || style.imageUrl,
    originalUrl: style.imageUrl,
    kind: "project-style",
    name: style.name || "project style",
    mode: dataUrl ? "data-url" : "url"
  }];
}

async function imageReferenceToDataUrl(imageUrl = "") {
  const value = String(imageUrl || "").trim();
  if (!value) return "";
  if (value.startsWith("data:image/")) return value;
  if (/^https?:\/\//i.test(value)) return "";
  const localPath = localCachePathFromUrl(value);
  if (!localPath) return "";
  try {
    const bytes = await fs.readFile(localPath);
    const mime = mimeTypeForImagePath(localPath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch (error) {
    console.warn(`Unable to read style reference image ${value}: ${error.message}`);
    return "";
  }
}

function localCachePathFromUrl(url = "") {
  const normalized = String(url || "").replace(/\\/g, "/");
  if (!normalized.startsWith("/cache/")) return "";
  const relative = normalized.slice("/cache/".length);
  const fullPath = path.resolve(CACHE_DIR, relative);
  const cacheRoot = path.resolve(CACHE_DIR);
  return fullPath.startsWith(cacheRoot) ? fullPath : "";
}

function mimeTypeForImagePath(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "image/png";
}

function publicReferenceImageInfo(image = {}) {
  return {
    url: image.originalUrl || image.url || "",
    kind: image.kind || "reference",
    name: image.name || "",
    mode: image.mode || (String(image.url || "").startsWith("data:image/") ? "data-url" : "url")
  };
}

function activeProjectSnapshot(projects = {}, state = {}) {
  const project = (projects.projects || []).find((item) => item.id === projects.activeProjectId) || {};
  return {
    ...project,
    state
  };
}

function collectProjectResourceUrls(project = {}) {
  const urls = new Set();
  collectResourceUrls(project.coverUrl, urls);
  collectResourceUrls(project.config?.project?.projectStyles, urls);
  collectResourceUrls(project.config?.project?.styleReferenceImage, urls);
  collectResourceUrls(project.state, urls);
  return urls;
}

function collectAllProjectResourceUrls(projects = {}) {
  const urls = new Set();
  for (const project of projects.projects || []) {
    for (const url of collectProjectResourceUrls(project)) {
      urls.add(url);
    }
  }
  return urls;
}

function collectResourceUrls(value, urls = new Set()) {
  if (!value) return urls;
  if (typeof value === "string") {
    if (value.startsWith("/cache/")) urls.add(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResourceUrls(item, urls);
    return urls;
  }
  if (typeof value === "object") {
    for (const key of ["url", "imageUrl", "coverUrl", "file", "thumbnailUrl", "originalUrl"]) {
      collectResourceUrls(value[key], urls);
    }
    for (const item of Object.values(value)) {
      if (item && typeof item === "object") collectResourceUrls(item, urls);
    }
  }
  return urls;
}

async function cleanupUnreferencedCacheFiles(candidateUrls = new Set(), projects = {}) {
  const remainingUrls = collectAllProjectResourceUrls(projects);
  const removed = [];
  for (const url of candidateUrls || []) {
    if (!String(url || "").startsWith("/cache/") || remainingUrls.has(url)) {
      continue;
    }
    const filePath = localCachePathFromUrl(url);
    if (!filePath || !isDeletableCachePath(filePath)) {
      continue;
    }
    try {
      await fs.unlink(filePath);
      removed.push(url);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`Unable to delete cache file ${url}: ${error.message}`);
      }
    }
  }
  return removed;
}

function isDeletableCachePath(filePath = "") {
  const fullPath = path.resolve(filePath);
  const imageRoot = path.resolve(IMAGE_DIR);
  const videoRoot = path.resolve(VIDEO_DIR);
  return fullPath.startsWith(`${imageRoot}${path.sep}`) || fullPath.startsWith(`${videoRoot}${path.sep}`);
}

function stripAssetFromPromptPackage(pack = {}, assetId = "") {
  let changed = false;
  const removeRefs = (refs) => {
    const input = Array.isArray(refs) ? refs : [];
    const output = input.filter((id) => id !== assetId);
    if (output.length !== input.length) changed = true;
    return output;
  };
  const next = {
    ...pack,
    assetRefs: removeRefs(pack.assetRefs),
    assetReferences: (pack.assetReferences || []).filter((asset) => {
      const keep = asset.id !== assetId;
      if (!keep) changed = true;
      return keep;
    }),
    audio: (pack.audio || []).map((row) => ({
      ...row,
      assetRefs: removeRefs(row.assetRefs)
    })),
    dialogue: (pack.dialogue || []).map((row) => {
      const speakerAssetId = row.speakerAssetId === assetId ? "" : row.speakerAssetId;
      if (speakerAssetId !== row.speakerAssetId) changed = true;
      return { ...row, speakerAssetId };
    }),
    subShots: (pack.subShots || []).map((subShot) => ({
      ...subShot,
      assetRefs: removeRefs(subShot.assetRefs)
    }))
  };
  return { pack: next, changed };
}

function videoUsesAsset(video = {}, assetId = "") {
  return (video.referenceImages || []).some((image) => image.id === assetId)
    || (video.requestPayload?.image_urls || []).some((url) => String(url || "").includes(assetId))
    || String(video.prompt || "").includes(assetId);
}

function projectAttributes(project = {}) {
  const style = activeProjectStyle(project);
  return {
    visualStyle: style.prompt || "",
    styleName: style.name || "",
    styleReferenceImage: style.imageUrl || "",
    aspectRatio: project.aspectRatio || "9:16",
    videoLength: project.videoLength || project.episodeDuration || "",
    subtitles: project.subtitles || "on",
    dialogueLanguage: project.dialogueLanguage || project.language || "zh-CN"
  };
}

function buildImagePrompt(config, shot, cards) {
  const characterPrompts = (cards.characters || []).map((card) => `${card.name}: ${card.appearance}`).join("; ");
  const locationPrompts = (cards.locations || []).map((card) => `${card.name}: ${card.atmosphere || card.layout}`).join("; ");
  return [
    `Create one manga drama storyboard frame, ${config.project.aspectRatio}.`,
    `Project: ${config.project.title}.`,
    `Visual style: ${config.project.visualStyle}.`,
    `Shot: ${shot.id}, ${shot.shotType}, ${shot.camera}.`,
    `Action: ${shot.action}.`,
    `Dialogue or caption: ${shot.dialogue || "no dialogue"}.`,
    `Characters: ${characterPrompts || "use script cast"}.`,
    `Locations: ${locationPrompts || "use script locations"}.`,
    "Clear composition, readable faces, production-ready storyboard, no watermarks."
  ].join("\n");
}

function buildVideoPrompt(config, shot, image, cards) {
  const propPrompts = (cards.props || []).map((card) => card.name).join(", ");
  return [
    `Animate storyboard image ${image.url} into a ${shot.durationSec || 4}s manga drama clip.`,
    `Aspect ratio ${config.project.aspectRatio}.`,
    `Camera: ${shot.camera}.`,
    `Action: ${shot.action}.`,
    `Continuity: ${shot.continuity || "preserve character and scene identity"}.`,
    `Important props: ${propPrompts || "none"}.`,
    "Subtle character motion, cinematic timing, no extra characters, no text overlays unless already present."
  ].join("\n");
}

function mockScript(config) {
  const project = config.project;
  return {
    title: project.title || "未命名漫剧",
    logline: project.logline,
    synopsis: `${project.logline} 故事以强钩子开场，在快速冲突中交代目标，并用反转结尾推动下一集。`,
    scenes: [
      {
        id: "SC01",
        title: "雨夜误投",
        location: "霓虹巷口",
        timeOfDay: "夜",
        mood: "紧张、潮湿、带一点荒诞",
        action: "快递员阿澈追着一只会发光的导航箭头冲进巷子，手里的包裹忽然开始低声倒数。",
        narration: "这座城市不会睡，它只是在等一个送错包裹的人。",
        dialogue: [
          { speaker: "阿澈", text: "我只是兼职，别让我拯救世界啊。" },
          { speaker: "芯片", text: "目的地改写：塔顶，倒计时六十秒。" }
        ],
        visualNotes: "路面积水倒映霓虹招牌，包裹缝隙里透出蓝白光。"
      },
      {
        id: "SC02",
        title: "记忆追兵",
        location: "旧电车天桥",
        timeOfDay: "夜",
        mood: "追逐、压迫",
        action: "无脸追兵从广告屏里钻出，阿澈踩上停运电车的车顶，城市地图在他脚下像电路一样点亮。",
        narration: "每一块屏幕都认识他，虽然他从没来过这里。",
        dialogue: [
          { speaker: "追兵", text: "归还记忆，归还身份。" },
          { speaker: "阿澈", text: "我连房租都没还完！" }
        ],
        visualNotes: "天桥横跨城市深谷，广告屏碎成像素雨。"
      },
      {
        id: "SC03",
        title: "塔顶开门",
        location: "中央信号塔",
        timeOfDay: "黎明前",
        mood: "悬疑、希望",
        action: "阿澈把芯片按进塔顶插槽，城市灯光同时熄灭，随即浮现出他童年遗失的画面。",
        narration: "他送到的不是货，是自己忘掉的第一天。",
        dialogue: [
          { speaker: "芯片", text: "收件人：阿澈。" },
          { speaker: "阿澈", text: "那我到底是谁？" }
        ],
        visualNotes: "塔顶逆光，黎明线切开云层，主角表情从恐惧转向震惊。"
      }
    ]
  };
}

function mockEpisodeScript(config, state, episodeInfo = {}) {
  const project = config.project;
  const previousEpisode = [...(state.episodes || [])]
    .filter((episode) => Number(episode.order || 0) < Number(episodeInfo.order || 1))
    .sort((a, b) => Number(b.order || 0) - Number(a.order || 0))[0] || null;
  const lead = state.cards?.characters?.[0]?.name || "主角";
  const support = state.cards?.characters?.[1]?.name || "伙伴";
  const location = state.cards?.locations?.[0]?.name || "核心场景";
  const previousHook = previousEpisode?.script?.endingHook || previousEpisode?.synopsis || project.logline || "上一集的冲突尚未解决";
  return {
    script: {
      title: episodeInfo.title || `第 ${episodeInfo.order || 1} 集`,
      logline: `${lead}延续上一集线索，在${location}发现新的阻碍。`,
      synopsis: `${previousHook}。本集${lead}和${support}继续追查关键线索，短暂取得突破，但结尾出现新的反转，为下一集留下钩子。`,
      previousRecap: previousEpisode ? `承接${previousEpisode.title}：${previousEpisode.synopsis || previousEpisode.script?.synopsis || ""}` : "从项目主线开篇进入第一集。",
      episodeGoal: episodeInfo.note || "推进主线冲突，强化角色目标，并制造下一集悬念。",
      endingHook: "关键线索指向一个更大的秘密，主角发现自己也被卷入其中。",
      continuityNotes: "延续项目已定义的角色、场景和视觉风格。",
      scenes: [
        {
          id: "SC01",
          title: "承接线索",
          location,
          timeOfDay: "日间",
          mood: "紧张、推进",
          action: `${lead}复盘上一集留下的线索，发现线索背后隐藏着新的入口。`,
          narration: "故事没有结束，只是换了一个更危险的方向。",
          dialogue: [
            { speaker: lead, text: "这不是巧合，是有人故意把我们引到这里。" },
            { speaker: support, text: "那我们就顺着它走下去。" }
          ],
          visualNotes: project.visualStyle || ""
        },
        {
          id: "SC02",
          title: "新的阻碍",
          location,
          timeOfDay: "日间",
          mood: "冲突、压迫",
          action: `${lead}尝试接近真相时遭遇阻拦，角色关系和目标被进一步明确。`,
          narration: "",
          dialogue: [
            { speaker: "阻拦者", text: "再往前一步，你会后悔。" },
            { speaker: lead, text: "我已经没有回头路了。" }
          ],
          visualNotes: project.visualStyle || ""
        },
        {
          id: "SC03",
          title: "结尾反转",
          location,
          timeOfDay: "黄昏",
          mood: "悬疑、反转",
          action: `${lead}拿到关键证据，却发现证据指向自己或身边人，下一集悬念被抛出。`,
          narration: "答案出现的一刻，新的问题也睁开了眼睛。",
          dialogue: [
            { speaker: support, text: "这个名字……为什么会是你？" },
            { speaker: lead, text: "我也想知道。" }
          ],
          visualNotes: project.visualStyle || ""
        }
      ]
    }
  };
}

function mockShots(config, script) {
  const templates = [
    ["远景", "雨幕中缓慢推进", "城市巷口像一张发光的迷宫地图展开"],
    ["近景", "手持晃动跟拍", "包裹裂缝亮起，倒计时映在主角眼睛里"],
    ["中景", "横向追拍", "主角冲上旧电车天桥，追兵从屏幕里探出"],
    ["特写", "快速推近", "追兵的手擦过包裹，记忆画面闪回一帧"],
    ["大全景", "升镜头", "信号塔刺破云层，整座城市短暂静音"],
    ["近景", "环绕半圈后定格", "芯片插入塔顶，主角看见自己的童年影像"]
  ];
  const scenes = script.scenes || [];
  return {
    shots: templates.map((template, index) => {
      const scene = scenes[Math.min(Math.floor(index / 2), Math.max(scenes.length - 1, 0))] || scenes[0] || {};
      return {
        id: `SH${String(index + 1).padStart(2, "0")}`,
        sceneId: scene.id || "SC01",
        order: index + 1,
        durationSec: 15,
        shotType: template[0],
        camera: template[1],
        action: template[2],
        dialogue: scene.dialogue?.[index % Math.max(scene.dialogue.length, 1)]?.text || scene.narration || "",
        assetNotes: `${config.project.visualStyle}，${template[0]}，${template[2]}，${scene.visualNotes || ""}`,
        visualNotes: `${template[1]}，${template[2]}，保持角色、场景和道具一致。`,
        continuity: `延续 ${scene.title || "上一场"} 的服装、光线和道具位置。`
      };
    })
  };
}

function mockCards(config, script) {
  const speakerNames = new Set();
  for (const scene of script.scenes || []) {
    for (const line of scene.dialogue || []) {
      if (line.speaker && !["旁白", "芯片"].includes(line.speaker)) {
        speakerNames.add(line.speaker);
      }
    }
  }
  const protagonist = [...speakerNames][0] || "阿澈";
  return {
    characters: [
      {
        id: "CHAR01",
        name: protagonist,
        role: "主角 / 新手快递员",
        appearance: "短黑发，黄色防水外套，斜挎快递包，眼神慌张但很倔。",
        personality: "嘴上逃避，关键时刻会冲向危险。",
        prompt: `${protagonist}, young courier, yellow rain jacket, cross-body delivery bag, expressive manga face, ${config.project.visualStyle}`
      },
      {
        id: "CHAR02",
        name: "记忆追兵",
        role: "压力来源 / 城市防火墙",
        appearance: "无脸人形，黑色长雨衣，面部是故障广告屏纹理。",
        personality: "机械、冷静、执着。",
        prompt: `faceless memory pursuer, black raincoat, glitch billboard face, manga antagonist, ${config.project.visualStyle}`
      }
    ],
    locations: (script.scenes || []).map((scene, index) => ({
      id: `LOC${String(index + 1).padStart(2, "0")}`,
      name: scene.location || `场景 ${index + 1}`,
      atmosphere: scene.mood || "戏剧化、电影感",
      layout: scene.visualNotes || scene.action || "保留清晰前景、中景、背景层次。",
      prompt: `${scene.location}, ${scene.timeOfDay}, ${scene.mood}, ${scene.visualNotes}, ${config.project.visualStyle}`
    })),
    props: [
      {
        id: "PROP01",
        name: "记忆芯片包裹",
        function: "触发倒计时和主角身份谜题",
        look: "小型银色包裹，边缘渗出蓝白光，表面有细密电路纹。",
        prompt: `small silver courier package, glowing blue-white memory chip, circuit seams, key prop, ${config.project.visualStyle}`
      }
    ]
  };
}

function mockPromptPackages(config, shots, cards, assetImages) {
  const assets = flattenCards(cards);
  const characters = assets.filter((asset) => asset.type === "character");
  const locations = assets.filter((asset) => asset.type === "location");
  const props = assets.filter((asset) => asset.type === "prop");
  return {
    promptPackages: shots.map((shot, index) => {
      const char = characters[index % Math.max(characters.length, 1)] || characters[0] || {};
      const loc = locations[index % Math.max(locations.length, 1)] || locations[0] || {};
      const prop = props[index % Math.max(props.length, 1)] || props[0] || {};
      const refs = [char.id, loc.id, prop.id].filter(Boolean);
      return {
        id: `PKG-${shot.id}`,
        shotId: shot.id,
        durationSec: 15,
        title: `${shot.id} Seedance prompt package`,
        soundDesign: "Layered room tone, key action sound effects, and short emotional accents synced to each sub-shot.",
        audio: [
          { timeRange: "0.0-3.0", content: `Establish ambience for ${loc.name || "the scene"} with subtle tension.`, assetRefs: [loc.id].filter(Boolean) },
          { timeRange: "3.0-7.0", content: `Emphasize action sound for ${prop.name || "key prop"}.`, assetRefs: [prop.id].filter(Boolean) }
        ],
        dialogue: shot.dialogue ? [
          { timeRange: "0.6-2.2", speakerAssetId: char.id || "", voice: "young, emotional, clear delivery", text: shot.dialogue }
        ] : [],
        subShots: [
          {
            id: `${shot.id}-01`,
            timeRange: "0.0-3.0",
            cameraLanguage: `Fade in, fast push-in, ${shot.camera || "controlled camera move"}.`,
            blocking: `${char.name || "main character"} starts in ${loc.name || "the scene"}, key props remain visible.`,
            composition: `Establish ${loc.name || "environment"} and keep asset identity consistent with references.`,
            action: shot.action,
            assetRefs: refs
          },
          {
            id: `${shot.id}-02`,
            timeRange: "3.0-7.0",
            cameraLanguage: "Cut to a closer angle with stable continuity.",
            blocking: "Keep character position and prop placement consistent.",
            composition: "Readable face, clear hands, foreground prop visible.",
            action: `${shot.action} Continue the action beat with stronger tension.`,
            assetRefs: refs
          },
          {
            id: `${shot.id}-03`,
            timeRange: "7.0-10.0",
            cameraLanguage: "Rapid push-in or match cut for the key turning point.",
            blocking: "Keep all referenced assets in plausible spatial relation.",
            composition: "Focus on the trigger prop or emotional reaction.",
            action: shot.continuity || shot.videoPrompt || shot.action,
            assetRefs: refs
          },
          {
            id: `${shot.id}-04`,
            timeRange: "10.0-15.0",
            cameraLanguage: "Slow push-in, rack focus, hold final impact.",
            blocking: "End pose clearly shows the result of the action.",
            composition: "Cinematic stillness, consistent style, no new characters.",
            action: `${shot.action} Resolve this 15-second shot and preserve continuity for the next shot.`,
            assetRefs: refs
          }
        ],
        seedancePrompt: buildSeedancePromptFromParts(shot, refs, assets, assetImages)
      };
    })
  };
}

async function mockImage(config, shot) {
  const fileName = `${safeFileName(shot.id)}.svg`;
  const fullPath = path.join(IMAGE_DIR, fileName);
  const svg = storyboardSvg(config, shot);
  await fs.writeFile(fullPath, svg, "utf8");
  return {
    url: `/cache/images/${fileName}`,
    file: path.relative(ROOT, fullPath)
  };
}

async function mockAssetImage(config, asset) {
  return mockImage(config, {
    id: asset.id,
    shotType: asset.type,
    camera: "standard reference sheet",
    action: `${asset.name}: ${asset.description || asset.prompt || ""}. ${assetReferenceStandard(asset.type)}`,
    dialogue: ""
  });
}

async function mockVideo(config, shot, image) {
  const fileName = `${safeFileName(shot.id)}.html`;
  const fullPath = path.join(VIDEO_DIR, fileName);
  const html = clipHtml(config, shot, image);
  await fs.writeFile(fullPath, html, "utf8");
  return {
    url: `/cache/videos/${fileName}`,
    file: path.relative(ROOT, fullPath),
    kind: "mock-animatic"
  };
}

function storyboardSvg(config, shot) {
  const portrait = config.project.aspectRatio !== "16:9";
  const width = portrait ? 900 : 1280;
  const height = portrait ? 1600 : 720;
  const hue = hashNumber(`${shot.id}-${shot.action}`) % 360;
  const accent = `hsl(${hue}, 72%, 52%)`;
  const shadow = `hsl(${(hue + 170) % 360}, 48%, 24%)`;
  const bg = `hsl(${(hue + 220) % 360}, 32%, 12%)`;
  const titleLines = wrapSvgText(`${shot.id} ${shot.shotType} / ${shot.camera}`, 24);
  const actionLines = wrapSvgText(shot.action || "", 19);
  const dialogueLines = wrapSvgText(shot.dialogue || "", 18);
  const skylineY = Math.round(height * 0.52);
  const characterX = Math.round(width * 0.52);
  const characterY = Math.round(height * 0.58);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(shot.id)} storyboard">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="58%" stop-color="${shadow}"/>
      <stop offset="100%" stop-color="#101317"/>
    </linearGradient>
    <linearGradient id="street" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.18)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.02)"/>
    </linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="12" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g opacity="0.38">
    <path d="M0 ${skylineY} C ${width * 0.2} ${skylineY - 90}, ${width * 0.36} ${skylineY + 44}, ${width * 0.56} ${skylineY - 48} S ${width * 0.86} ${skylineY + 24}, ${width} ${skylineY - 74}" fill="none" stroke="${accent}" stroke-width="6"/>
    <path d="M0 ${height * 0.76} L${width} ${height * 0.63} L${width} ${height} L0 ${height} Z" fill="#05070a" opacity="0.68"/>
  </g>
  <g opacity="0.74">
    ${buildingRects(width, skylineY, hue)}
  </g>
  <g filter="url(#softGlow)">
    <circle cx="${width * 0.24}" cy="${height * 0.22}" r="${Math.round(width * 0.08)}" fill="${accent}" opacity="0.24"/>
    <rect x="${width * 0.12}" y="${height * 0.1}" width="${width * 0.24}" height="${height * 0.05}" rx="10" fill="${accent}" opacity="0.74"/>
    <rect x="${width * 0.66}" y="${height * 0.18}" width="${width * 0.22}" height="${height * 0.04}" rx="8" fill="#f6d45d" opacity="0.72"/>
  </g>
  <g transform="translate(${characterX} ${characterY})">
    <path d="M-92 238 C-78 92 -58 18 0 18 C58 18 78 92 92 238 Z" fill="#f4c84b"/>
    <path d="M-54 18 C-38 -54 40 -54 54 18 C44 52 -42 52 -54 18 Z" fill="#16191f"/>
    <circle cx="0" cy="-18" r="58" fill="#f3d6bd"/>
    <path d="M-34 -18 Q0 12 34 -18" stroke="#22262d" stroke-width="8" fill="none"/>
    <rect x="-112" y="88" width="224" height="74" rx="18" fill="#1e252f" opacity="0.84"/>
    <rect x="-62" y="105" width="124" height="40" rx="10" fill="${accent}" opacity="0.9"/>
  </g>
  <g>
    <rect x="${width * 0.07}" y="${height * 0.68}" width="${width * 0.86}" height="${height * 0.22}" rx="22" fill="#06080c" opacity="0.78"/>
    <text x="${width * 0.1}" y="${height * 0.72}" fill="#f7fbff" font-size="${portrait ? 34 : 28}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-weight="700">
      ${titleLines.map((line, index) => `<tspan x="${width * 0.1}" dy="${index ? 42 : 0}">${escapeXml(line)}</tspan>`).join("")}
    </text>
    <text x="${width * 0.1}" y="${height * 0.79}" fill="#d7e3ea" font-size="${portrait ? 30 : 23}" font-family="Arial, 'Microsoft YaHei', sans-serif">
      ${actionLines.slice(0, 3).map((line, index) => `<tspan x="${width * 0.1}" dy="${index ? 38 : 0}">${escapeXml(line)}</tspan>`).join("")}
    </text>
    <text x="${width * 0.1}" y="${height * 0.875}" fill="#f6d45d" font-size="${portrait ? 28 : 22}" font-family="Arial, 'Microsoft YaHei', sans-serif">
      ${dialogueLines.slice(0, 2).map((line, index) => `<tspan x="${width * 0.1}" dy="${index ? 34 : 0}">${escapeXml(line)}</tspan>`).join("")}
    </text>
  </g>
</svg>`;
}

function buildingRects(width, skylineY, hue) {
  const blocks = [];
  for (let index = 0; index < 9; index += 1) {
    const blockWidth = width * (0.07 + (index % 3) * 0.018);
    const x = index * width * 0.115 - width * 0.03;
    const h = 130 + (hashNumber(`${index}-${hue}`) % 180);
    const y = skylineY - h;
    const color = `hsl(${(hue + index * 28) % 360}, ${34 + (index % 4) * 8}%, ${16 + (index % 5) * 4}%)`;
    blocks.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${blockWidth.toFixed(1)}" height="${h}" fill="${color}"/>`);
    for (let w = 0; w < 4; w += 1) {
      blocks.push(`<rect x="${(x + 16 + w * 28).toFixed(1)}" y="${(y + 22 + (w % 2) * 32).toFixed(1)}" width="12" height="30" fill="#f6d45d" opacity="${w % 2 ? 0.42 : 0.72}"/>`);
    }
  }
  return blocks.join("\n    ");
}

function clipHtml(config, shot, image) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(shot.id)} mock animatic</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #080b10; overflow: hidden; font-family: Arial, "Microsoft YaHei", sans-serif; }
    .stage { position: fixed; inset: 0; display: grid; place-items: center; background: #080b10; }
    img { width: 100%; height: 100%; object-fit: cover; animation: drift 4s ease-in-out infinite alternate; transform-origin: 52% 48%; }
    .caption { position: fixed; left: 4%; right: 4%; bottom: 4%; padding: 12px 14px; color: white; background: rgba(0, 0, 0, .62); border: 1px solid rgba(255,255,255,.18); border-radius: 8px; font-size: clamp(13px, 2vw, 18px); line-height: 1.45; }
    .tag { color: #f6d45d; font-weight: 700; margin-right: 8px; }
    @keyframes drift {
      from { transform: scale(1.02) translate3d(-1.4%, 0, 0); filter: saturate(1); }
      to { transform: scale(1.12) translate3d(1.5%, -1.2%, 0); filter: saturate(1.15); }
    }
  </style>
</head>
<body>
  <main class="stage">
    <img src="${escapeHtml(image.url)}" alt="${escapeHtml(shot.id)} storyboard">
  </main>
  <div class="caption"><span class="tag">${escapeHtml(shot.id)}</span>${escapeHtml(shot.videoPrompt || shot.action || "")}</div>
</body>
</html>`;
}

function normalizeScript(data, config, source) {
  const script = data?.script || data;
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  return {
    id: `SCRIPT-${Date.now()}`,
    title: stringOr(script?.title, config.project.title),
    logline: stringOr(script?.logline, config.project.logline),
    synopsis: stringOr(script?.synopsis, config.project.logline),
    previousRecap: stringOr(script?.previousRecap, script?.previous_recap || ""),
    episodeGoal: stringOr(script?.episodeGoal, script?.episode_goal || ""),
    endingHook: stringOr(script?.endingHook, script?.ending_hook || ""),
    continuityNotes: stringOr(script?.continuityNotes, script?.continuity_notes || ""),
    source,
    createdAt: new Date().toISOString(),
    scenes: scenes.slice(0, 6).map((scene, index) => ({
      id: stringOr(scene.id, `SC${String(index + 1).padStart(2, "0")}`),
      title: stringOr(scene.title, `场次 ${index + 1}`),
      location: stringOr(scene.location, "待定场景"),
      timeOfDay: stringOr(scene.timeOfDay, scene.time || "未指定"),
      mood: stringOr(scene.mood, "戏剧化"),
      action: stringOr(scene.action, scene.description || ""),
      narration: stringOr(scene.narration, ""),
      dialogue: Array.isArray(scene.dialogue) ? scene.dialogue.map((line) => ({
        speaker: stringOr(line.speaker, "角色"),
        text: stringOr(line.text, "")
      })) : [],
      visualNotes: stringOr(scene.visualNotes, scene.visual_notes || "")
    }))
  };
}

function normalizeShots(data, script, config, source) {
  const inputShots = Array.isArray(data?.shots) ? data.shots : Array.isArray(data) ? data : [];
  return inputShots.slice(0, 12).map((shot, index) => {
    const scene = (script.scenes || []).find((item) => item.id === shot.sceneId) || script.scenes?.[Math.min(index, script.scenes.length - 1)] || {};
    return {
      id: stringOr(shot.id, `SH${String(index + 1).padStart(2, "0")}`),
      sceneId: stringOr(shot.sceneId, scene.id || "SC01"),
      order: Number(shot.order || index + 1),
      durationSec: 15,
      shotType: stringOr(shot.shotType, shot.size || "中景"),
      camera: stringOr(shot.camera, "轻微推进"),
      action: stringOr(shot.action, scene.action || ""),
      dialogue: stringOr(shot.dialogue, scene.dialogue?.[0]?.text || scene.narration || ""),
      assetNotes: stringOr(shot.assetNotes, shot.asset_notes || ""),
      assetRefs: Array.isArray(shot.assetRefs) ? shot.assetRefs : Array.isArray(shot.asset_refs) ? shot.asset_refs : [],
      visualNotes: stringOr(shot.visualNotes, shot.visual_notes || ""),
      imagePrompt: stringOr(shot.imagePrompt, `${config.project.visualStyle}，${shot.action || scene.action || ""}`),
      videoPrompt: stringOr(shot.videoPrompt, `${shot.camera || "轻微推进"}，${shot.action || scene.action || ""}`),
      continuity: stringOr(shot.continuity, `延续 ${scene.title || "上一场"}。`),
      source
    };
  });
}

function normalizeCards(data, config, source) {
  const cards = data?.cards || data || {};
  const characters = Array.isArray(cards.characters) ? cards.characters : [];
  const locations = Array.isArray(cards.locations) ? cards.locations : [];
  const props = Array.isArray(cards.props) ? cards.props : [];
  return {
    characters: characters.slice(0, 12).map((card, index) => ({
      id: stringOr(card.id, `CHAR${String(index + 1).padStart(2, "0")}`),
      name: stringOr(card.name, `角色 ${index + 1}`),
      aliases: normalizeAliases(card.aliases || card.alias || card.nicknames),
      role: stringOr(card.role, ""),
      appearance: stringOr(card.appearance, ""),
      personality: stringOr(card.personality, ""),
      prompt: stringOr(card.prompt, `${card.name || ""}, ${config.project.visualStyle}`),
      source
    })),
    locations: locations.slice(0, 12).map((card, index) => ({
      id: stringOr(card.id, `LOC${String(index + 1).padStart(2, "0")}`),
      name: stringOr(card.name, `场景 ${index + 1}`),
      aliases: normalizeAliases(card.aliases || card.alias || card.nicknames),
      atmosphere: stringOr(card.atmosphere, ""),
      layout: stringOr(card.layout, ""),
      prompt: stringOr(card.prompt, `${card.name || ""}, ${config.project.visualStyle}`),
      source
    })),
    props: props.slice(0, 12).map((card, index) => ({
      id: stringOr(card.id, `PROP${String(index + 1).padStart(2, "0")}`),
      name: stringOr(card.name, `道具 ${index + 1}`),
      aliases: normalizeAliases(card.aliases || card.alias || card.nicknames),
      function: stringOr(card.function, card.purpose || ""),
      look: stringOr(card.look, card.appearance || ""),
      prompt: stringOr(card.prompt, `${card.name || ""}, ${config.project.visualStyle}`),
      source
    })),
    selectedAssetRefs: normalizeSelectedAssetRefs(data?.selectedAssetRefs || data?.selected_asset_refs || cards.selectedAssetRefs || cards.selected_asset_refs)
  };
}

function mergeCards(existing = {}, incoming = {}) {
  const merged = {
    characters: mergeCardList(existing.characters || [], incoming.characters || [], "character"),
    locations: mergeCardList(existing.locations || [], incoming.locations || [], "location"),
    props: mergeCardList(existing.props || [], incoming.props || [], "prop")
  };
  if (existing.adapterError || incoming.adapterError) {
    merged.adapterError = incoming.adapterError || existing.adapterError;
  }
  return merged;
}

function mergeCardList(existing, incoming, type) {
  const byId = new Map((existing || []).map((item) => [item.id, item]));
  const byTerm = new Map();
  for (const item of existing || []) {
    for (const term of assetIdentityTerms(item)) {
      if (!byTerm.has(term)) byTerm.set(term, item);
    }
  }
  for (const item of incoming || []) {
    const same = byId.get(item.id) || findSameAssetByTerms(item, byTerm);
    if (same) {
      const merged = {
        ...same,
        ...item,
        id: same.id,
        name: same.name || item.name,
        aliases: mergeAliases(same.aliases, item.aliases, item.name),
        prompt: same.prompt || item.prompt,
        source: same.source || item.source
      };
      byId.set(same.id, merged);
      for (const term of assetIdentityTerms(merged)) byTerm.set(term, merged);
      continue;
    }
    const next = { ...item, id: uniqueAssetId(item.id, byId, type) };
    byId.set(next.id, next);
    for (const term of assetIdentityTerms(next)) {
      if (!byTerm.has(term)) byTerm.set(term, next);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
}

function findSameAssetByTerms(asset, termMap) {
  for (const term of assetIdentityTerms(asset)) {
    const same = termMap.get(term);
    if (same) return same;
  }
  return null;
}

function normalizeAliases(value) {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[，,、/|]/) : [];
  return [...new Set(input.map((item) => stringOr(item, "").trim()).filter(Boolean))].slice(0, 12);
}

function mergeAliases(...groups) {
  return normalizeAliases(groups.flatMap((group) => Array.isArray(group) ? group : group ? [group] : []));
}

function assetIdentityTerms(asset = {}) {
  return [asset.id, asset.name, ...(asset.aliases || [])]
    .map(normalizeAssetName)
    .filter((term) => term && !ambiguousAssetTerms().has(term));
}

function ambiguousAssetTerms() {
  return new Set(["他", "她", "它", "ta", "主角", "男主", "男主角", "女主", "女主角", "角色", "场景", "道具"]);
}

function uniqueAssetId(id, existingMap, type) {
  const prefix = { character: "CHAR", location: "LOC", prop: "PROP" }[type] || "PROP";
  if (id && !existingMap.has(id)) return id;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${prefix}${String(index).padStart(2, "0")}`;
    if (!existingMap.has(candidate)) return candidate;
  }
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeAssetName(name) {
  return String(name || "").trim().toLowerCase();
}

function selectedShotsForAssetExtraction(state = {}, payload = {}) {
  if (payload.scope !== "shot" && !Array.isArray(payload.shotIds)) {
    return allEpisodeShots(state);
  }
  const episodeId = payload.episodeId || state.activeEpisodeId;
  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  if (!episodeId && !requestedIds.size) {
    return allEpisodeShots(state);
  }
  const episodes = episodeId
    ? (state.episodes || []).filter((episode) => episode.id === episodeId)
    : (state.episodes || []);
  return episodes.flatMap((episode) => (episode.shots || [])
    .filter((shot) => !requestedIds.size || requestedIds.has(shot.id))
    .map((shot) => ({ ...shot, episodeId: episode.id, episodeTitle: episode.title })));
}

function normalizeSelectedAssetRefs(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => ({
    shotId: stringOr(row.shotId, row.shot_id || ""),
    assets: normalizeSelectedAssetRows(row.assets || row.assetRefs || row.asset_refs || row.selectedAssets || row.selected_assets)
  })).filter((row) => row.shotId && row.assets.length);
}

function normalizeSelectedAssetRows(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row, index) => {
    if (typeof row === "string") {
      return { assetId: row, importance: 80 - index, reason: "", source: "" };
    }
    return {
      assetId: stringOr(row.assetId, row.asset_id || row.id || ""),
      importance: Number(row.importance || row.score || 80 - index),
      reason: stringOr(row.reason, ""),
      source: stringOr(row.source, "")
    };
  }).filter((row) => row.assetId);
}

function attachAssetRefsToSelectedShots(state = {}, payload = {}, generatedCards = {}, previousCards = {}) {
  if (payload.scope !== "shot" && !Array.isArray(payload.shotIds)) {
    return 0;
  }
  const episodeId = payload.episodeId || state.activeEpisodeId;
  const requestedIds = new Set(Array.isArray(payload.shotIds) ? payload.shotIds : []);
  const selectedByShot = selectedAssetRefsByShot(generatedCards, state.cards);
  const generatedRefs = assetRefsFromGeneratedCards(generatedCards, state.cards);
  const imageByAssetId = new Map((state.assetImages || []).map((image) => [image.assetId, image.url]));
  const previousAssetIds = new Set(flattenCards(previousCards).map((asset) => asset.id));
  let count = 0;
  for (const episode of state.episodes || []) {
    if (episodeId && episode.id !== episodeId) continue;
    for (const shot of episode.shots || []) {
      if (requestedIds.size && !requestedIds.has(shot.id)) continue;
      shot.assetRefs = rankShotAssetRefs(shot, state.cards, {
        preferredRefs: selectedByShot.get(shot.id) || generatedRefs,
        previousAssetIds,
        imageByAssetId
      });
      count += 1;
    }
  }
  return count;
}

function selectedAssetRefsByShot(generatedCards = {}, mergedCards = {}) {
  const map = new Map();
  const assets = flattenCards(mergedCards);
  const validIds = new Set(assets.map((asset) => asset.id));
  for (const row of generatedCards.selectedAssetRefs || []) {
    const refs = [];
    for (const item of row.assets || []) {
      const asset = resolveAssetSelection(item.assetId, assets);
      if (asset?.id && validIds.has(asset.id)) refs.push({ id: asset.id, importance: item.importance || 80 });
    }
    if (refs.length) map.set(row.shotId, refs);
  }
  return map;
}

function assetRefsFromGeneratedCards(generatedCards = {}, mergedCards = {}) {
  const refs = [];
  const assets = flattenCards(mergedCards);
  for (const generated of flattenCards(generatedCards)) {
    const matched = resolveAssetSelection(generated.id, assets) || findSameAssetInList(generated, assets);
    if (matched?.id) refs.push({ id: matched.id, importance: 70 });
  }
  return refs;
}

function resolveAssetSelection(value, assets) {
  const normalized = normalizeAssetName(value);
  if (!normalized) return null;
  return assets.find((asset) => asset.id === value || assetIdentityTerms(asset).includes(normalized)) || null;
}

function findSameAssetInList(asset = {}, assets = []) {
  const terms = new Set(assetIdentityTerms(asset));
  return assets.find((candidate) => assetIdentityTerms(candidate).some((term) => terms.has(term))) || null;
}

function rankShotAssetRefs(shot = {}, cards = {}, options = {}) {
  const assets = flattenCards(cards);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const scores = new Map();
  for (const ref of options.preferredRefs || []) addAssetScore(scores, ref.id || ref, Number(ref.importance || 80), "model selected");
  const text = shotAssetText(shot);
  for (const asset of assets) {
    const score = scoreAssetForShot(asset, text, options);
    if (score > 0) addAssetScore(scores, asset.id, score, "local match");
  }
  return [...scores.values()]
    .filter((item) => byId.has(item.id))
    .sort((a, b) => b.score - a.score || assetTypeRank(byId.get(a.id)?.type) - assetTypeRank(byId.get(b.id)?.type))
    .slice(0, MAX_SHOT_ASSET_REFS)
    .map((item) => item.id);
}

function addAssetScore(scores, ref, score) {
  const id = typeof ref === "string" ? ref : ref?.id;
  if (!id) return;
  const existing = scores.get(id) || { id, score: 0 };
  existing.score = Math.max(existing.score, Number(score) || 0);
  scores.set(id, existing);
}

function scoreAssetForShot(asset, text, options = {}) {
  let score = 0;
  const terms = assetIdentityTerms(asset);
  const directMatch = terms.some((term) => text.includes(term));
  const semanticMatch = assetKeyPhrases(asset).some((term) => text.includes(term));
  if (directMatch) score += 45;
  if (semanticMatch) score += 18;
  if (directMatch || semanticMatch) {
    if (asset.type === "character") score += 12;
    if (asset.type === "location") score += 10;
    if (asset.type === "prop") score += 8;
    if (options.imageByAssetId?.get(asset.id)) score += 8;
    if (options.previousAssetIds?.has(asset.id)) score += 6;
  }
  if (minorOrAtmosphereAsset(asset)) score -= 20;
  return score;
}

function assetKeyPhrases(asset = {}) {
  const terms = new Set();
  const text = [asset.description, asset.prompt].filter(Boolean).join(" ");
  for (const phrase of String(text).split(/[，。；、,.|/]/)) {
    const normalized = normalizeAssetName(phrase);
    if (normalized.length >= 3 && normalized.length <= 18 && !genericAssetPhrase(normalized)) {
      terms.add(normalized);
    }
  }
  return [...terms];
}

function genericAssetPhrase(text) {
  return ["高对比", "电影感", "漫画", "雨夜", "霓虹", "9:16", "竖屏", "清晰", "特写", "风格"].some((term) => text.includes(term));
}

function shotAssetText(shot = {}) {
  return normalizeAssetName([
    shot.id,
    shot.sceneId,
    shot.shotType,
    shot.camera,
    shot.action,
    shot.dialogue,
    shot.assetNotes,
    shot.visualNotes,
    shot.continuity
  ].filter(Boolean).join(" "));
}

function assetTypeRank(type) {
  return { character: 1, location: 2, prop: 3 }[type] || 4;
}

function minorOrAtmosphereAsset(asset = {}) {
  const text = normalizeAssetName([asset.name, asset.description, asset.prompt].filter(Boolean).join(" "));
  return ["雨", "霓虹", "烟雾", "光效", "速度线", "纸张", "杂物", "字幕", "音效"].some((term) => text.includes(term));
}

function normalizePromptPackages(data, shots, cards, assetImages, source, adapterError, videoProfile = DEFAULT_CONFIG.videoProfiles[0]) {
  const packages = Array.isArray(data?.promptPackages) ? data.promptPackages : Array.isArray(data?.packages) ? data.packages : Array.isArray(data) ? data : [];
  const assets = flattenCards(cards);
  const validAssetIds = new Set(assets.map((asset) => asset.id));
  return packages.map((item, index) => {
    const shot = shots.find((candidate) => candidate.id === item.shotId) || shots[index] || {};
    const subShots = Array.isArray(item.subShots) ? item.subShots : Array.isArray(item.sub_shots) ? item.sub_shots : [];
    const normalized = {
      id: stringOr(item.id, `PKG-${shot.id || `SH${String(index + 1).padStart(2, "0")}`}`),
      shotId: stringOr(item.shotId, shot.id || `SH${String(index + 1).padStart(2, "0")}`),
      targetProfile: stringOr(item.targetProfile, videoProfile?.id || DEFAULT_VIDEO_PROFILE_ID),
      videoProfile: {
        id: videoProfile?.id || DEFAULT_VIDEO_PROFILE_ID,
        name: videoProfile?.name || "Seedance 2.0"
      },
      schemaVersion: stringOr(item.schemaVersion, videoProfile?.promptSchema || "seedance-prompt-package-v1"),
      durationSec: Number(item.durationSec || item.duration || 15),
      title: stringOr(item.title, `${shot.id || ""} prompt package`),
      soundDesign: stringOr(item.soundDesign, item.sound_design || ""),
      audio: normalizeTimedRows(item.audio, validAssetIds),
      dialogue: normalizeDialogueRows(item.dialogue, validAssetIds),
      subShots: subShots.map((subShot, subIndex) => ({
        id: stringOr(subShot.id, `${shot.id || "SH"}-${String(subIndex + 1).padStart(2, "0")}`),
        timeRange: stringOr(subShot.timeRange, subShot.time_range || defaultSubShotRange(subIndex)),
        cameraLanguage: stringOr(subShot.cameraLanguage, subShot.camera || subShot.camera_language || ""),
        blocking: stringOr(subShot.blocking, subShot.position || ""),
        composition: stringOr(subShot.composition, subShot.framing || ""),
        action: stringOr(subShot.action, ""),
        assetRefs: filterAssetRefs(subShot.assetRefs || subShot.asset_refs || [], validAssetIds)
      })),
      seedancePrompt: stringOr(item.seedancePrompt, item.seedance_prompt || ""),
      assetRefs: filterAssetRefs(item.assetRefs || item.asset_refs || [], validAssetIds),
      source,
      adapterError: adapterError || "",
      createdAt: new Date().toISOString()
    };
    if (!normalized.assetRefs.length) {
      normalized.assetRefs = [...new Set(normalized.subShots.flatMap((subShot) => subShot.assetRefs))];
    }
    normalized.assetReferences = assetReferencesForRefs(normalized.assetRefs, assets, assetImages);
    if (!normalized.seedancePrompt) {
      normalized.seedancePrompt = buildSeedancePromptFromPackage(normalized, shot, assets, assetImages);
    }
    return normalized;
  });
}

function normalizeAssetType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["character", "characters", "role", "角色"].includes(normalized)) return "character";
  if (["location", "locations", "scene", "场景"].includes(normalized)) return "location";
  if (["prop", "props", "道具"].includes(normalized)) return "prop";
  return "prop";
}

function assetListKey(type) {
  return {
    character: "characters",
    location: "locations",
    prop: "props"
  }[type] || "props";
}

function manualAssetCard({ id, type, name, prompt, description, source }) {
  const base = {
    id,
    name,
    aliases: normalizeAliases(name),
    prompt,
    source: source || "manual"
  };
  if (type === "character") {
    return {
      ...base,
      role: description,
      appearance: description,
      personality: ""
    };
  }
  if (type === "location") {
    return {
      ...base,
      atmosphere: description,
      layout: description
    };
  }
  return {
    ...base,
    function: description,
    look: description
  };
}

function findAssetById(cards = {}, id) {
  if (!id) return null;
  return flattenCards(cards).find((asset) => asset.id === id) || null;
}

function nextManualAssetId(cards = {}, type = "prop") {
  const prefix = { character: "CHAR", location: "LOC", prop: "PROP" }[type] || "PROP";
  const used = new Set(flattenCards(cards).map((asset) => asset.id));
  for (let index = 1; index < 1000; index += 1) {
    const id = `${prefix}${String(index).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeTimedRows(rows, validAssetIds) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    timeRange: stringOr(row.timeRange, row.time_range || defaultSubShotRange(index)),
    content: stringOr(row.content, row.text || ""),
    assetRefs: filterAssetRefs(row.assetRefs || row.asset_refs || [], validAssetIds)
  }));
}

function normalizeDialogueRows(rows, validAssetIds) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    timeRange: stringOr(row.timeRange, row.time_range || defaultSubShotRange(index)),
    speakerAssetId: validAssetIds.has(row.speakerAssetId) ? row.speakerAssetId : validAssetIds.has(row.speaker_asset_id) ? row.speaker_asset_id : "",
    voice: stringOr(row.voice, ""),
    text: stringOr(row.text, row.dialogue || "")
  }));
}

function filterAssetRefs(refs, validAssetIds) {
  const input = Array.isArray(refs) ? refs : typeof refs === "string" ? [refs] : [];
  return [...new Set(input.map((ref) => String(ref).trim()).filter((ref) => validAssetIds.has(ref)))];
}

function defaultSubShotRange(index) {
  return ["0.0-3.0", "3.0-7.0", "7.0-10.0", "10.0-15.0"][index] || `${index * 3}.0-${(index + 1) * 3}.0`;
}

function countCards(cards = {}) {
  return (cards.characters?.length || 0) + (cards.locations?.length || 0) + (cards.props?.length || 0);
}

function flattenCards(cards = {}) {
  return [
    ...(cards.characters || []).map((card) => ({
      id: card.id,
      type: "character",
      name: card.name,
      aliases: normalizeAliases(card.aliases),
      description: [card.role, card.appearance, card.personality].filter(Boolean).join(" "),
      prompt: card.prompt || ""
    })),
    ...(cards.locations || []).map((card) => ({
      id: card.id,
      type: "location",
      name: card.name,
      aliases: normalizeAliases(card.aliases),
      description: [card.atmosphere, card.layout].filter(Boolean).join(" "),
      prompt: card.prompt || ""
    })),
    ...(cards.props || []).map((card) => ({
      id: card.id,
      type: "prop",
      name: card.name,
      aliases: normalizeAliases(card.aliases),
      description: [card.function, card.look].filter(Boolean).join(" "),
      prompt: card.prompt || ""
    }))
  ].filter((asset) => asset.id);
}

function availableAssetCatalog(cards, assetImages) {
  const imageByAssetId = new Map((assetImages || []).map((image) => [image.assetId, image.url]));
  return flattenCards(cards).map((asset) => ({
    id: asset.id,
    type: asset.type,
    name: asset.name,
    aliases: asset.aliases || [],
    description: asset.description,
    prompt: asset.prompt,
    imageUrl: imageByAssetId.get(asset.id) || ""
  }));
}

function assetReferencesForRefs(refs, assets, assetImages) {
  const imageByAssetId = new Map((assetImages || []).map((image) => [image.assetId, image.url]));
  return (refs || []).map((id) => {
    const asset = assets.find((item) => item.id === id) || { id };
    return {
      id,
      type: asset.type || "",
      name: asset.name || "",
      imageUrl: imageByAssetId.get(id) || ""
    };
  });
}

function hydratePromptPackageReferences(packages, cards, assetImages) {
  const assets = flattenCards(cards);
  return (packages || []).map((pack) => {
    const refs = pack.assetRefs?.length
      ? pack.assetRefs
      : [...new Set((pack.subShots || []).flatMap((subShot) => subShot.assetRefs || []))];
    return {
      ...pack,
      assetRefs: refs,
    assetReferences: assetReferencesForRefs(refs, assets, assetImages)
    };
  });
}

function activeVideoProfile(config = {}) {
  const profileId = config.modelSelection?.videoProfile || DEFAULT_VIDEO_PROFILE_ID;
  const profiles = Array.isArray(config.videoProfiles) ? config.videoProfiles : DEFAULT_CONFIG.videoProfiles;
  return profiles.find((profile) => profile.id === profileId) || profiles.find((profile) => profile.id === DEFAULT_VIDEO_PROFILE_ID) || DEFAULT_CONFIG.videoProfiles[0];
}

function buildSeedancePromptFromParts(shot, assetRefs, assets, assetImages) {
  const assetText = assetRefs.map((id) => {
    const asset = assets.find((item) => item.id === id);
    const image = (assetImages || []).find((item) => item.assetId === id);
    return `${id}${asset?.name ? ` ${asset.name}` : ""}${image?.url ? ` image:${image.url}` : ""}`;
  }).join("; ");
  return [
    `15s video shot ${shot.id || ""}.`,
    `Action: ${shot.action || ""}`,
    `Camera: ${shot.camera || ""}`,
    `Visual notes: ${shot.visualNotes || shot.assetNotes || ""}`,
    `Continuity: ${shot.continuity || ""}`,
    `Asset references: ${assetText || "use selected project assets"}.`,
    "Keep character identity, scene layout, prop positions, realistic scale, and previous-shot continuity. No new characters."
  ].join("\n");
}

function buildSeedancePromptFromPackage(pack, shot, assets, assetImages) {
  const refs = pack.assetRefs?.length ? pack.assetRefs : [...new Set((pack.subShots || []).flatMap((subShot) => subShot.assetRefs || []))];
  return [
    buildSeedancePromptFromParts(shot, refs, assets, assetImages),
    `Sound: ${pack.soundDesign || ""}`,
    (pack.dialogue || []).length ? `Dialogue: ${(pack.dialogue || []).map((row) => `${row.timeRange} ${row.speakerAssetId || ""}: ${row.text || ""}`).join(" / ")}` : "",
    ...(pack.subShots || []).map((subShot) => `${subShot.timeRange}: ${subShot.cameraLanguage}; ${subShot.blocking}; ${subShot.composition}; ${subShot.action}`)
  ].filter(Boolean).join("\n");
}

async function postJson(endpoint, apiKey, payload, timeoutMs = 60000) {
  const controller = new AbortController();
  const requestTimeoutMs = Number(timeoutMs) || 60000;
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Some custom adapters return plain text.
    }
    if (!response.ok) {
      const message = typeof data === "string" ? data : data?.error?.message || JSON.stringify(data);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(endpoint, apiKey, timeoutMs = 60000) {
  const controller = new AbortController();
  const requestTimeoutMs = Number(timeoutMs) || 60000;
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "authorization": `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Some adapters return plain text.
    }
    if (!response.ok) {
      const message = typeof data === "string" ? data : data?.error?.message || JSON.stringify(data);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonPayload(payload) {
  if (payload && typeof payload === "object") {
    return payload;
  }
  const text = String(payload || "").trim();
  if (!text) {
    throw new Error("Empty JSON payload");
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Unable to parse adapter JSON response");
  }
}

function throwIfAdapterError(response) {
  const error = response?.error || response?.errors?.[0];
  if (!error) {
    return;
  }
  if (typeof error === "string") {
    throw new Error(error);
  }
  throw new Error(error.message || error.msg || error.type || JSON.stringify(error).slice(0, 500));
}

function extractImageAsset(response) {
  const candidates = [
    response?.data?.[0],
    response?.images?.[0],
    response?.output?.[0],
    response?.result,
    response
  ].filter(Boolean);

  for (const candidate of candidates) {
    const base64 = findImageBase64(candidate);
    if (base64) {
      return { base64 };
    }
    const url = findImageUrl(candidate);
    if (url) {
      return { url };
    }
  }
  return {};
}

function findImageUrl(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (seen.has(value)) {
    return "";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item, seen);
      if (found) {
        return found;
      }
    }
    return "";
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      const normalizedKey = key.toLowerCase();
      const looksLikeUrlKey = normalizedKey.includes("url") || normalizedKey.includes("uri");
      const looksLikeImageUrl = /^https?:\/\//i.test(item) || item.startsWith("/cache/") || item.startsWith("data:image/");
      if (looksLikeUrlKey && looksLikeImageUrl) {
        return item;
      }
    } else if (item && typeof item === "object") {
      const found = findImageUrl(item, seen);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

function findVideoUrl(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (seen.has(value)) {
    return "";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) {
        return item;
      }
      const found = findVideoUrl(item, seen);
      if (found) {
        return found;
      }
    }
    return "";
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      const normalizedKey = key.toLowerCase();
      const looksLikeUrlKey = normalizedKey.includes("url") || normalizedKey.includes("uri");
      const looksLikeVideoUrl = /^https?:\/\//i.test(item) && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(item);
      if (looksLikeUrlKey && (looksLikeVideoUrl || normalizedKey.includes("video"))) {
        return item;
      }
    } else if (item && typeof item === "object") {
      const found = findVideoUrl(item, seen);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

function findImageBase64(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (seen.has(value)) {
    return "";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageBase64(item, seen);
      if (found) {
        return found;
      }
    }
    return "";
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      const normalizedKey = key.toLowerCase();
      if (item.startsWith("data:image/")) {
        return item.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      }
      const likelyBase64Key = ["b64_json", "b64", "base64", "image_base64"].includes(normalizedKey) || normalizedKey.includes("base64");
      if (likelyBase64Key && item.length > 500) {
        return item;
      }
    } else if (item && typeof item === "object") {
      const found = findImageBase64(item, seen);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

function summarizeAdapterResponse(response) {
  return JSON.stringify(summarizeValue(response)).slice(0, 900);
}

function summarizeValue(value, depth = 0) {
  if (depth > 4) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2).map((item) => summarizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = summarizeValue(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") {
    if (value.length > 180) {
      return `<string length=${value.length} prefix=${JSON.stringify(value.slice(0, 40))}>`;
    }
    return value;
  }
  return value;
}

function resolveOpenAiCompatibleEndpoint(endpoint, suffix) {
  const trimmed = (endpoint || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Adapter endpoint is empty");
  }
  if (trimmed.endsWith(suffix)) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}${suffix}`;
  }
  return trimmed;
}

function resolveAdapterEndpoint(adapter, suffix) {
  if (adapter.provider === "openai-compatible") {
    return resolveOpenAiCompatibleEndpoint(adapter.endpoint, suffix);
  }
  return (adapter.endpoint || "").trim();
}

function imageSizeForAspect(aspectRatio) {
  if (aspectRatio === "16:9") {
    return "1792x1024";
  }
  if (aspectRatio === "1:1") {
    return "1024x1024";
  }
  return "1024x1792";
}

function canUseAdapter(adapter = {}) {
  return adapter.provider && adapter.provider !== "mock" && adapter.endpoint && adapter.apiKey && adapter.model;
}

function providerIsMock(adapter = {}) {
  return !adapter.provider || adapter.provider === "mock";
}

function shouldFallbackToMock(adapter = {}) {
  return providerIsMock(adapter) || adapter.fallbackToMock === true;
}

async function ensureWorkspace() {
  await Promise.all([
    fs.mkdir(PUBLIC_DIR, { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(IMAGE_DIR, { recursive: true }),
    fs.mkdir(VIDEO_DIR, { recursive: true })
  ]);
  await ensureJsonFile(CONFIG_PATH, DEFAULT_CONFIG);
  await ensureJsonFile(MODEL_CENTER_PATH, defaultModelCenter());
  await ensureJsonFile(STATE_PATH, DEFAULT_STATE);
  await ensureJsonFile(PROJECTS_PATH, DEFAULT_PROJECTS);
  await ensureModelCenterFromConfig();
  await ensureDefaultProject();
}

async function ensureJsonFile(filePath, fallback) {
  try {
    await fs.access(filePath);
  } catch {
    await writeJson(filePath, fallback);
  }
}

async function readConfig() {
  return hydrateConfigWithPlatformModels(await readJson(CONFIG_PATH, DEFAULT_CONFIG));
}

async function writeConfig(config) {
  const merged = mergeConfig(DEFAULT_CONFIG, config);
  await Promise.all([
    writeJson(CONFIG_PATH, merged),
    writeModelCenterFromConfig(merged)
  ]);
}

async function readState() {
  return normalizeState(await readJson(STATE_PATH, freshState()));
}

async function writeState(state) {
  await writeJson(STATE_PATH, state);
}

async function readProjects() {
  const data = { ...structuredClone(DEFAULT_PROJECTS), ...(await readJson(PROJECTS_PATH, DEFAULT_PROJECTS)) };
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.projects = data.projects.map(normalizeProject);
  return data;
}

async function writeProjects(projects) {
  await writeJson(PROJECTS_PATH, projects);
}

async function createProject(payload = {}) {
  const now = new Date().toISOString();
  const currentConfig = await readConfig();
  const title = stringOr(payload.title, "未命名项目");
  const logline = stringOr(payload.scriptText || payload.logline, "");
  const config = newProjectConfig(currentConfig, title, logline);
  const storedConfig = projectConfigForStorage(config);
  const state = freshState();
  state.meta.createdAt = now;
  state.meta.updatedAt = now;
  if (logline) {
    state.storyScript = scriptFromUserText(title, logline, config);
  }
  addEvent(state, "project.created", "项目已创建", "local");

  const projects = await readProjects();
  const project = {
    id: crypto.randomUUID(),
    title,
    scriptText: logline,
    coverUrl: "",
    createdAt: now,
    updatedAt: now,
    config: storedConfig,
    state
  };
  projects.projects = [project, ...projects.projects.filter((item) => item.id !== project.id)];
  projects.activeProjectId = project.id;
  await writeProjects(projects);
  await writeConfig(config);
  await writeState(state);

  return {
    ok: true,
    project: projectForClient(project),
    projects: projectListForClient(projects),
    activeProjectId: project.id,
    config: sanitizeConfig(config),
    state
  };
}

async function openProject(projectId) {
  if (!projectId) {
    throw new Error("缺少项目 ID");
  }
  const projects = await readProjects();
  const project = projects.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error("项目不存在");
  }
  project.updatedAt = new Date().toISOString();
  projects.activeProjectId = project.id;
  projects.projects = sortProjects(projects.projects);
  await writeProjects(projects);
  const platformConfig = await readConfig();
  const config = configForProject(platformConfig, project.config || DEFAULT_CONFIG);
  const state = normalizeState(project.state || freshState());
  await writeConfig(config);
  await writeState(state);
  project.config = projectConfigForStorage(config);
  await writeProjects(projects);

  return {
    ok: true,
    project: projectForClient(project),
    projects: projectListForClient(projects),
    activeProjectId: project.id,
    config: sanitizeConfig(config),
    state
  };
}

async function deleteProject(projectId) {
  if (!projectId) {
    throw new Error("Missing project id");
  }
  const projects = await readProjects();
  const project = projects.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const wasActiveProject = projects.activeProjectId === projectId;
  const deletedResources = collectProjectResourceUrls(project);
  projects.projects = projects.projects.filter((item) => item.id !== projectId);
  const nextProject = wasActiveProject
    ? sortProjects(projects.projects)[0] || null
    : projects.projects.find((item) => item.id === projects.activeProjectId) || sortProjects(projects.projects)[0] || null;
  projects.projects = sortProjects(projects.projects);
  projects.activeProjectId = nextProject?.id || null;
  const removedFiles = await cleanupUnreferencedCacheFiles(deletedResources, projects);

  if (nextProject) {
    const platformConfig = await readConfig();
    const config = configForProject(platformConfig, nextProject.config || DEFAULT_CONFIG);
    const nextState = normalizeState(nextProject.state || freshState());
    await writeConfig(config);
    await writeState(nextState);
    nextProject.config = projectConfigForStorage(config);
    nextProject.coverUrl = inferProjectCover(nextState);
    await writeProjects(projects);
    return {
      ok: true,
      deletedProjectId: projectId,
      removedFiles,
      project: projectForClient(nextProject),
      projects: projectListForClient(projects),
      activeProjectId: nextProject.id,
      config: sanitizeConfig(config),
      state: nextState
    };
  }

  const config = await readConfig();
  const nextState = freshState();
  await writeState(nextState);
  await writeProjects(projects);
  return {
    ok: true,
    deletedProjectId: projectId,
    removedFiles,
    projects: [],
    activeProjectId: null,
    config: sanitizeConfig(config),
    state: nextState
  };
}

async function updateStoryScript(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const title = stringOr(payload.title, config.project.title || "未命名项目");
  const scriptText = stringOr(payload.scriptText || payload.logline, config.project.logline || "");
  const existingScriptText = storyScriptText(state.storyScript);
  const keepExistingScript = Boolean(state.storyScript)
    && normalizeTextForCompare(scriptText) === normalizeTextForCompare(existingScriptText || config.project.logline || "");
  const nextConfig = mergeConfig(config, {
    project: {
      title,
      logline: scriptText
    }
  });
  if (keepExistingScript) {
    state.storyScript = {
      ...state.storyScript,
      title: state.storyScript.title || title,
      synopsis: state.storyScript.synopsis || scriptText,
      logline: state.storyScript.logline || scriptText.slice(0, 220)
    };
  } else {
    state.storyScript = scriptText ? scriptFromUserText(title, scriptText, nextConfig) : null;
    state.cards = { characters: [], locations: [], props: [] };
    state.assetImages = [];
    for (const episode of state.episodes || []) {
      if (!episode.script) {
        episode.synopsis = "";
        episode.shots = [];
        episode.images = [];
        episode.videos = [];
      }
      episode.promptPackages = [];
    }
  }
  touchState(state);
  addEvent(state, "storyScript.saved", "项目剧本已保存", "local");
  await writeConfig(nextConfig);
  await writeState(state);
  await syncActiveProject({ config: nextConfig, state });
  const projects = await readProjects();
  return {
    ok: true,
    config: sanitizeConfig(nextConfig),
    state,
    projects: projectListForClient(projects),
    activeProjectId: projects.activeProjectId
  };
}

async function createEpisode(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const nextOrder = (state.episodes || []).reduce((max, episode) => Math.max(max, Number(episode.order || 0)), 0) + 1;
  const title = stringOr(payload.title, `第 ${nextOrder} 集`);
  const scriptText = stringOr(payload.scriptText || payload.synopsis, "");
  const generateMode = stringOr(payload.generateMode || payload.mode, scriptText ? "manual" : "blank");
  const note = stringOr(payload.note || payload.episodeGoal, "");
  let script = scriptText ? scriptFromUserText(title, scriptText, config) : null;
  let source = script ? "manual" : "local";
  let adapterError = "";
  if (generateMode === "llm") {
    const result = await generateEpisodeScriptContent(config, state, {
      title,
      order: nextOrder,
      note
    });
    script = result.script;
    source = result.source;
    adapterError = result.adapterError || "";
  }
  const episode = createEpisodeRecord({
    title,
    order: nextOrder,
    script,
    synopsis: script?.synopsis || scriptText
  });
  state.episodes = [...(state.episodes || []), episode];
  state.activeEpisodeId = episode.id;
  touchState(state);
  addEvent(state, "episode.created", `${episode.title} 已创建${script ? "并写入剧本" : ""}`, source, adapterError);
  await writeState(state);
  await syncActiveProject({ state });
  return { ok: true, state, episode, source, adapterError };
}

async function openEpisode(episodeId) {
  if (!episodeId) {
    throw new Error("缺少剧集 ID");
  }
  const state = await readState();
  const episode = state.episodes.find((item) => item.id === episodeId);
  if (!episode) {
    throw new Error("剧集不存在");
  }
  state.activeEpisodeId = episode.id;
  touchState(state);
  await writeState(state);
  await syncActiveProject({ state });
  return { ok: true, state, episode };
}

async function deleteEpisode(episodeId) {
  if (!episodeId) {
    throw new Error("Missing episode id");
  }
  const state = await readState();
  const episode = (state.episodes || []).find((item) => item.id === episodeId);
  if (!episode) {
    throw new Error("Episode not found");
  }
  const projects = await readProjects();
  const beforeResources = collectProjectResourceUrls(activeProjectSnapshot(projects, state));
  state.episodes = (state.episodes || []).filter((item) => item.id !== episodeId);
  if (state.activeEpisodeId === episodeId) {
    state.activeEpisodeId = state.episodes[0]?.id || null;
  }
  touchState(state);
  addEvent(state, "episode.deleted", `${episode.title || episode.id} deleted`, "local");
  await writeState(state);
  await syncActiveProject({ state });
  const nextProjects = await readProjects();
  const removedFiles = await cleanupUnreferencedCacheFiles(beforeResources, nextProjects);
  const latestProjects = await readProjects();
  return {
    ok: true,
    deletedEpisodeId: episodeId,
    removedFiles,
    state,
    projects: projectListForClient(latestProjects),
    activeProjectId: latestProjects.activeProjectId
  };
}

async function updateEpisodeScript(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const episodeId = payload.episodeId || state.activeEpisodeId;
  const episode = state.episodes.find((item) => item.id === episodeId);
  if (!episode) {
    throw new Error("剧集不存在");
  }
  const title = stringOr(payload.title, episode.title || `第 ${episode.order || 1} 集`);
  const scriptText = stringOr(payload.scriptText || payload.synopsis, "");
  episode.title = title;
  episode.synopsis = scriptText;
  episode.script = scriptText ? scriptFromUserText(title, scriptText, config) : null;
  episode.shots = [];
  episode.promptPackages = [];
  episode.images = [];
  episode.videos = [];
  touchEpisode(episode);
  touchState(state);
  addEvent(state, "episode.script.saved", `${episode.title} 剧本已保存`, "local");
  await writeState(state);
  await syncActiveProject({ state });
  return { ok: true, state, episode };
}

async function uploadStyleImage(payload = {}) {
  const dataUrl = stringOr(payload.dataUrl || payload.image, "");
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("请上传有效图片");
  }
  const ext = imageExtension(match[1]);
  const name = stringOr(payload.name, "style").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "-").slice(0, 48) || "style";
  const file = await writeBase64Asset(IMAGE_DIR, `style-${name}-${Date.now()}.${ext}`, match[2]);
  return { ok: true, url: cacheUrl(file), file };
}

async function saveManualAsset(payload = {}) {
  const [config, state] = await Promise.all([readConfig(), readState()]);
  const type = normalizeAssetType(payload.type);
  const listKey = assetListKey(type);
  const name = stringOr(payload.name, "").trim();
  if (!name) {
    throw new Error("请填写资产名称");
  }
  const prompt = stringOr(payload.prompt, "");
  const description = stringOr(payload.description, "");
  const existing = findAssetById(state.cards, payload.id);
  const id = stringOr(payload.id, "") || nextManualAssetId(state.cards, type);
  let imageUrl = stringOr(payload.imageUrl, "");
  let file = null;
  if (imageUrl.startsWith("data:image/")) {
    const uploaded = await saveDataUrlImage(imageUrl, `asset-${id}`);
    imageUrl = uploaded.url;
    file = uploaded.file;
  }

  const card = manualAssetCard({
    id,
    type,
    name,
    prompt,
    description,
    source: existing?.source || "manual"
  });
  state.cards[listKey] = [
    ...(state.cards[listKey] || []).filter((item) => item.id !== id),
    card
  ];
  if (imageUrl) {
    const imageRecord = {
      id: `ASSETIMG-${id}`,
      assetId: id,
      assetType: type,
      name,
      prompt,
      source: "manual",
      adapterError: "",
      url: imageUrl,
      file,
      createdAt: new Date().toISOString()
    };
    state.assetImages = mergeById(state.assetImages || [], [imageRecord]);
    state.assetImageHistory = normalizeAssetImageHistory(state.assetImageHistory, state.assetImages);
    state.assetImageHistory[id] = addAssetImageHistoryEntry(state.assetImageHistory[id] || [], imageRecord);
  }
  for (const episode of state.episodes || []) {
    episode.promptPackages = hydratePromptPackageReferences(episode.promptPackages || [], state.cards, state.assetImages);
  }
  touchState(state);
  addEvent(state, "asset.manual.saved", `${name} 已保存`, "manual");
  await writeState(state);
  await syncActiveProject({ state });
  return { ok: true, state, asset: card };
}

async function deleteAsset(assetId) {
  if (!assetId) {
    throw new Error("Missing asset id");
  }
  const state = await readState();
  const asset = findAssetById(state.cards, assetId);
  if (!asset) {
    throw new Error("Asset not found");
  }
  const projects = await readProjects();
  const beforeResources = collectProjectResourceUrls(activeProjectSnapshot(projects, state));
  const type = normalizeAssetType(asset.type);
  const listKey = assetListKey(type);
  state.cards[listKey] = (state.cards[listKey] || []).filter((item) => item.id !== assetId);
  state.assetImages = (state.assetImages || []).filter((image) => image.assetId !== assetId);
  if (state.assetImageHistory) {
    delete state.assetImageHistory[assetId];
  }
  for (const episode of state.episodes || []) {
    let touched = false;
    episode.shots = (episode.shots || []).map((shot) => {
      const refs = (shot.assetRefs || []).filter((id) => id !== assetId);
      if (refs.length !== (shot.assetRefs || []).length) touched = true;
      return { ...shot, assetRefs: refs };
    });
    episode.promptPackages = (episode.promptPackages || []).map((pack) => {
      const filtered = stripAssetFromPromptPackage(pack, assetId);
      if (filtered.changed) touched = true;
      return filtered.pack;
    });
    episode.videos = (episode.videos || []).map((video) => {
      const usesAsset = videoUsesAsset(video, assetId);
      if (usesAsset) touched = true;
      return usesAsset
        ? { ...video, stale: true, staleReason: "asset-deleted", staleAt: new Date().toISOString() }
        : video;
    });
    if (touched) touchEpisode(episode);
  }
  touchState(state);
  addEvent(state, "asset.deleted", `${asset.name || asset.id} deleted`, "local");
  await writeState(state);
  await syncActiveProject({ state });
  const nextProjects = await readProjects();
  const removedFiles = await cleanupUnreferencedCacheFiles(beforeResources, nextProjects);
  const latestProjects = await readProjects();
  return {
    ok: true,
    deletedAssetId: assetId,
    removedFiles,
    state,
    projects: projectListForClient(latestProjects),
    activeProjectId: latestProjects.activeProjectId
  };
}

async function saveDataUrlImage(dataUrl, name = "asset") {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("请上传有效图片");
  }
  const ext = imageExtension(match[1]);
  const safeName = stringOr(name, "asset").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "-").slice(0, 48) || "asset";
  const file = await writeBase64Asset(IMAGE_DIR, `${safeName}-${Date.now()}.${ext}`, match[2]);
  return { url: cacheUrl(file), file };
}

function imageExtension(mime) {
  return {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  }[String(mime || "").toLowerCase()] || "png";
}

async function syncActiveProject({ config, state } = {}) {
  const projects = await readProjects();
  if (!projects.activeProjectId) {
    return;
  }
  const project = projects.projects.find((item) => item.id === projects.activeProjectId);
  if (!project) {
    return;
  }
  if (config) {
    project.config = projectConfigForStorage(mergeConfig(project.config || DEFAULT_CONFIG, config));
    project.title = project.config.project.title || project.title;
    project.scriptText = project.config.project.logline || project.scriptText || "";
  }
  if (state) {
    project.state = normalizeState(state);
  }
  project.coverUrl = inferProjectCover(project.state);
  project.updatedAt = new Date().toISOString();
  projects.projects = sortProjects(projects.projects);
  await writeProjects(projects);
}

async function ensureDefaultProject() {
  const projects = await readProjects();
  if (projects.projects.length) {
    return;
  }
  const [config, state] = await Promise.all([readConfig(), readState()]);
  if (!state.storyScript && !config.project?.title) {
    return;
  }
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    title: config.project?.title || "未命名项目",
    scriptText: config.project?.logline || state.storyScript?.synopsis || "",
    coverUrl: inferProjectCover(state),
    createdAt: state.meta?.createdAt || now,
    updatedAt: state.meta?.updatedAt || now,
    config: projectConfigForStorage(config),
    state
  };
  projects.projects = [project];
  projects.activeProjectId = project.id;
  await writeProjects(projects);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

async function writeJson(filePath, data) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new Error("请求内容过大，请上传 15MB 以内的图片");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be JSON");
  }
}

async function serveStatic(res, requestPath, baseDir, mountPath) {
  const cleanPath = requestPath.slice(mountPath.length).replace(/^\/+/, "") || "index.html";
  const fullPath = path.resolve(baseDir, cleanPath);
  const basePath = path.resolve(baseDir);
  if (fullPath !== basePath && !fullPath.startsWith(`${basePath}${path.sep}`)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden" });
  }
  try {
    const stat = await fs.stat(fullPath);
    const filePath = stat.isDirectory() ? path.join(fullPath, "index.html") : fullPath;
    const ext = path.extname(filePath).toLowerCase();
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": STATIC_TYPES[ext] || "application/octet-stream",
      "cache-control": requestPath.startsWith("/cache/") ? "no-cache" : "no-store"
    });
    res.end(body);
  } catch {
    if (baseDir === PUBLIC_DIR) {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      const body = await fs.readFile(indexPath);
      res.writeHead(200, {
        "content-type": STATIC_TYPES[".html"],
        "cache-control": "no-store"
      });
      return res.end(body);
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data, null, 2));
}

function mergeConfig(current, next = {}) {
  const merged = structuredClone(current || DEFAULT_CONFIG);
  merged.project = { ...DEFAULT_CONFIG.project, ...(current?.project || {}), ...(next.project || {}) };
  if (merged.project.videoLength == null) {
    merged.project.videoLength = merged.project.episodeDuration || DEFAULT_CONFIG.project.videoLength;
  }
  if (merged.project.episodeDuration == null) {
    merged.project.episodeDuration = merged.project.videoLength || DEFAULT_CONFIG.project.episodeDuration;
  }
  if (merged.project.dialogueLanguage == null) {
    merged.project.dialogueLanguage = merged.project.language || DEFAULT_CONFIG.project.dialogueLanguage;
  }
  if (merged.project.language == null) {
    merged.project.language = merged.project.dialogueLanguage || DEFAULT_CONFIG.project.language;
  }
  if (merged.project.subtitles == null) {
    merged.project.subtitles = DEFAULT_CONFIG.project.subtitles;
  }
  merged.modelConfigs = normalizeModelConfigs(current, next);
  merged.videoProfiles = normalizeVideoProfiles(current, next);
  merged.modelSelection = normalizeModelSelection(current, next, merged.modelConfigs, merged.videoProfiles);
  merged.adapters = syncLegacyAdaptersFromSelection(merged);
  return merged;
}

function newProjectConfig(currentConfig, title, logline) {
  const config = mergeConfig(currentConfig || DEFAULT_CONFIG, {
    adapters: currentConfig.adapters || {},
    modelConfigs: currentConfig.modelConfigs || {},
    modelSelection: currentConfig.modelSelection || {},
    videoProfiles: currentConfig.videoProfiles || DEFAULT_CONFIG.videoProfiles
  });
  config.project = {
    title,
    logline,
    genre: "",
    audience: "",
    episodeDuration: "",
    videoLength: "",
    subtitles: "",
    language: "",
    dialogueLanguage: "",
    visualStyle: "",
    aspectRatio: ""
  };
  return config;
}

function sanitizeConfig(config) {
  const safe = structuredClone(mergeConfig(DEFAULT_CONFIG, config));
  maskAdapters(safe.adapters);
  maskModelConfigs(safe.modelConfigs);
  return safe;
}

function defaultModelCenter() {
  return {
    modelConfigs: structuredClone(DEFAULT_CONFIG.modelConfigs),
    videoProfiles: structuredClone(DEFAULT_CONFIG.videoProfiles),
    updatedAt: new Date().toISOString()
  };
}

async function readModelCenter() {
  const raw = await readJson(MODEL_CENTER_PATH, defaultModelCenter());
  return {
    ...defaultModelCenter(),
    ...raw,
    modelConfigs: normalizeModelConfigs({ modelConfigs: raw.modelConfigs || DEFAULT_CONFIG.modelConfigs }, {}),
    videoProfiles: normalizeVideoProfiles({ videoProfiles: raw.videoProfiles || DEFAULT_CONFIG.videoProfiles }, {})
  };
}

async function writeModelCenterFromConfig(config) {
  const center = {
    modelConfigs: normalizeModelConfigs({ modelConfigs: config.modelConfigs || {}, adapters: config.adapters || {} }, {}),
    videoProfiles: normalizeVideoProfiles({ videoProfiles: config.videoProfiles || DEFAULT_CONFIG.videoProfiles }, {}),
    updatedAt: new Date().toISOString()
  };
  await writeJson(MODEL_CENTER_PATH, center);
}

async function ensureModelCenterFromConfig() {
  const [rawConfig, modelCenter] = await Promise.all([
    readJson(CONFIG_PATH, DEFAULT_CONFIG),
    readModelCenter()
  ]);
  const hasCustomCenter = MODEL_TYPES.some((type) => {
    const list = modelCenter.modelConfigs?.[type] || [];
    return list.some((model) => model.provider !== "mock" || model.endpoint || model.model || model.apiKey);
  });
  if (hasCustomCenter) {
    return;
  }
  const legacyHasModels = MODEL_TYPES.some((type) => {
    const adapter = rawConfig.adapters?.[type] || {};
    return adapter.provider !== "mock" || adapter.endpoint || adapter.model || adapter.apiKey;
  });
  if (legacyHasModels) {
    await writeModelCenterFromConfig(mergeConfig(DEFAULT_CONFIG, rawConfig));
  }
}

async function hydrateConfigWithPlatformModels(rawConfig = DEFAULT_CONFIG) {
  const modelCenter = await readModelCenter();
  return mergeConfig({
    ...DEFAULT_CONFIG,
    modelConfigs: modelCenter.modelConfigs,
    videoProfiles: modelCenter.videoProfiles
  }, rawConfig);
}

function normalizeModelConfigs(current = {}, next = {}) {
  const output = {};
  for (const type of MODEL_TYPES) {
    const byId = new Map();
    const ingest = (models = [], sourceAdapters = {}) => {
      for (const model of Array.isArray(models) ? models : []) {
        const normalized = normalizeModelConfig(type, model, sourceAdapters?.[type]);
        byId.set(normalized.id, normalized);
      }
    };
    ingest(DEFAULT_CONFIG.modelConfigs[type]);
    ingest(current.modelConfigs?.[type], current.adapters);
    if (!hasMeaningfulModelConfig(byId.get(MODEL_DEFAULT_IDS[type])) && current.adapters?.[type]) {
      byId.set(MODEL_DEFAULT_IDS[type], modelConfigFromAdapter(type, current.adapters[type], MODEL_DEFAULT_IDS[type]));
    }
    ingest(next.modelConfigs?.[type], current.adapters);
    if (next.adapters?.[type]) {
      const existingDefault = byId.get(MODEL_DEFAULT_IDS[type]) || DEFAULT_CONFIG.modelConfigs[type][0];
      const nextDefault = normalizeModelConfig(type, {
        ...existingDefault,
        ...next.adapters[type],
        id: MODEL_DEFAULT_IDS[type],
        name: existingDefault.name || defaultModelName(type)
      }, current.adapters?.[type]);
      byId.set(MODEL_DEFAULT_IDS[type], nextDefault);
    }
    if (type === "video" && ![...byId.values()].some((model) => model.provider === "apimart-seedance")) {
      byId.set("apimart-seedance-2.0", normalizeModelConfig("video", defaultVideoConfig()));
    }
    output[type] = [...byId.values()].map((model) => {
      const fallback = DEFAULT_CONFIG.adapters[type];
      return {
        ...model,
        timeoutMs: Number(model.timeoutMs || fallback.timeoutMs)
      };
    });
  }
  return output;
}

function normalizeModelConfig(type, model = {}, currentAdapter = {}) {
  const fallback = DEFAULT_CONFIG.adapters[type];
  const id = stringOr(model.id, MODEL_DEFAULT_IDS[type]);
  const apiKey = isMaskedApiKey(model.apiKey) ? stringOr(currentAdapter.apiKey, "") : stringOr(model.apiKey, currentAdapter.apiKey || "");
  const provider = normalizeModelProvider(type, stringOr(model.provider, fallback.provider));
  const endpoint = type === "video" && provider === "apimart-seedance"
    ? stringOr(model.endpoint, APIMART_SEEDANCE_ENDPOINT)
    : stringOr(model.endpoint, fallback.endpoint);
  const modelName = type === "video" && provider === "apimart-seedance"
    ? stringOr(model.model, APIMART_SEEDANCE_MODEL)
    : stringOr(model.model, fallback.model);
  return {
    id,
    type,
    name: stringOr(model.name, defaultModelName(type)),
    provider,
    endpoint,
    model: modelName,
    apiKey,
    fallbackToMock: model.fallbackToMock === true,
    timeoutMs: Number(model.timeoutMs || fallback.timeoutMs),
    ...(type === "video" ? { resolution: stringOr(model.resolution, provider === "apimart-seedance" ? APIMART_SEEDANCE_RESOLUTION : fallback.resolution || "") } : {})
  };
}

function normalizeModelProvider(type, provider = "") {
  const value = String(provider || "").trim();
  if (type === "video" && ["seedance", "seedance-2.0", "doubao-seedance-2.0", "apimart"].includes(value)) {
    return "apimart-seedance";
  }
  return value;
}

function modelConfigFromAdapter(type, adapter = {}, id = MODEL_DEFAULT_IDS[type]) {
  return normalizeModelConfig(type, {
    id,
    type,
    name: defaultModelName(type),
    ...adapter
  });
}

function hasMeaningfulModelConfig(model = {}) {
  return Boolean(model && (model.provider !== "mock" || model.endpoint || model.model || model.apiKey));
}

function defaultModelName(type) {
  return {
    llm: "默认 LLM",
    image: "默认生图模型",
    video: "默认视频模型"
  }[type] || "默认模型";
}

function normalizeVideoProfiles(current = {}, next = {}) {
  const byId = new Map();
  const ingest = (profiles = []) => {
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      const id = stringOr(profile.id, DEFAULT_VIDEO_PROFILE_ID);
      byId.set(id, {
        id,
        name: stringOr(profile.name, id),
        type: stringOr(profile.type, "video"),
        promptSchema: stringOr(profile.promptSchema, "seedance-prompt-package-v1"),
        requestBuilder: stringOr(profile.requestBuilder, id === DEFAULT_VIDEO_PROFILE_ID ? "seedance" : "custom"),
        maxReferenceImages: Number(profile.maxReferenceImages || MAX_SHOT_ASSET_REFS),
        description: stringOr(profile.description, "")
      });
    }
  };
  ingest(DEFAULT_CONFIG.videoProfiles);
  ingest(current.videoProfiles);
  ingest(next.videoProfiles);
  return [...byId.values()];
}

function normalizeModelSelection(current = {}, next = {}, modelConfigs = DEFAULT_CONFIG.modelConfigs, videoProfiles = DEFAULT_CONFIG.videoProfiles) {
  const selection = {
    ...MODEL_SELECTION_DEFAULTS,
    ...(current.modelSelection || {}),
    ...(next.modelSelection || {})
  };
  for (const [key, type] of Object.entries(MODEL_SELECTION_TYPES)) {
    const fallbackId = MODEL_DEFAULT_IDS[type];
    const list = modelConfigs[type] || [];
    if (!list.some((model) => model.id === selection[key])) {
      selection[key] = list[0]?.id || fallbackId;
    }
  }
  if (!videoProfiles.some((profile) => profile.id === selection.videoProfile)) {
    selection.videoProfile = videoProfiles[0]?.id || DEFAULT_VIDEO_PROFILE_ID;
  }
  return selection;
}

function syncLegacyAdaptersFromSelection(config = {}) {
  return {
    llm: resolveModelAdapterFromModels(config, "scriptLlm"),
    image: resolveModelAdapterFromModels(config, "assetImageModel"),
    video: resolveModelAdapterFromModels(config, "videoModel")
  };
}

function resolveModelAdapter(config = {}, selectionKeyOrType = "llm") {
  return resolveModelAdapterFromModels(config, selectionKeyOrType);
}

function resolveModelAdapterFromModels(config = {}, selectionKeyOrType = "llm") {
  const type = MODEL_SELECTION_TYPES[selectionKeyOrType] || (MODEL_TYPES.includes(selectionKeyOrType) ? selectionKeyOrType : "llm");
  const selectedId = MODEL_SELECTION_TYPES[selectionKeyOrType]
    ? config.modelSelection?.[selectionKeyOrType]
    : MODEL_DEFAULT_IDS[type];
  const models = config.modelConfigs?.[type] || [];
  const model = models.find((item) => item.id === selectedId)
    || models.find((item) => item.id === MODEL_DEFAULT_IDS[type])
    || modelConfigFromAdapter(type, config.adapters?.[type] || DEFAULT_CONFIG.adapters[type]);
  const { id, name, type: _type, ...adapter } = model;
  return {
    ...DEFAULT_CONFIG.adapters[type],
    ...adapter,
    modelConfigId: id,
    modelConfigName: name
  };
}

function maskAdapters(adapters = {}) {
  for (const key of MODEL_TYPES) {
    const adapter = adapters[key] || {};
    adapter.hasApiKey = Boolean(adapter.apiKey);
    adapter.apiKey = adapter.apiKey ? "********" : "";
    adapters[key] = adapter;
  }
}

function maskModelConfigs(modelConfigs = {}) {
  for (const type of MODEL_TYPES) {
    modelConfigs[type] = (modelConfigs[type] || []).map((model) => ({
      ...model,
      hasApiKey: Boolean(model.apiKey),
      apiKey: model.apiKey ? "********" : ""
    }));
  }
}

function isMaskedApiKey(value) {
  return typeof value === "string" && /^\*+$/.test(value.trim()) && value.trim().length >= 4;
}

function scriptFromUserText(title, text, config) {
  const now = new Date().toISOString();
  return {
    id: `SCRIPT-${Date.now()}`,
    title,
    logline: text.slice(0, 220),
    synopsis: text,
    source: "user",
    createdAt: now,
    scenes: [
      {
        id: "SC01",
        title: "整部短剧剧本",
        location: "待拆分",
        timeOfDay: "",
        mood: "",
        action: text,
        narration: "",
        dialogue: [],
        visualNotes: config.project.visualStyle || ""
      }
    ],
    adapterError: ""
  };
}

function storyScriptText(script = null) {
  if (!script) return "";
  return [
    script.synopsis || "",
    ...(script.scenes || []).map((scene) => [
      scene.title || "",
      scene.location || "",
      scene.action || "",
      scene.narration || "",
      ...(scene.dialogue || []).map((line) => `${line.speaker || ""}：${line.text || ""}`),
      scene.visualNotes || ""
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n\n").trim();
}

function normalizeTextForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function projectListForClient(projectsData) {
  return sortProjects(projectsData.projects || []).map(projectForClient);
}

function projectForClient(project) {
  const state = normalizeState(project.state || {});
  const episodes = state.episodes || [];
  const activeEpisode = getActiveEpisode(state) || episodes[0] || {};
  return {
    id: project.id,
    title: project.title || project.config?.project?.title || "未命名项目",
    scriptText: project.scriptText || project.config?.project?.logline || "",
    coverUrl: inferProjectCover(state) || project.coverUrl || "",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    activeEpisodeId: state.activeEpisodeId || activeEpisode.id || null,
    stats: {
      scenes: state.storyScript?.scenes?.length || 0,
      episodes: episodes.length,
      shots: episodes.reduce((total, episode) => total + (episode.shots?.length || 0), 0),
      assets: countCards(state.cards || {}),
      promptPackages: episodes.reduce((total, episode) => total + (episode.promptPackages?.length || 0), 0)
    }
  };
}

function sortProjects(projects) {
  return [...(projects || [])].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function inferProjectCover(state = {}) {
  const characters = state.cards?.characters || [];
  const lead = characters[0];
  if (!lead) {
    return "";
  }
  const image = (state.assetImages || []).find((item) => item.assetId === lead.id && item.url) || (state.assetImages || []).find((item) => item.assetType === "character" && item.url);
  return image?.url || "";
}

function freshState() {
  const now = new Date().toISOString();
  const state = structuredClone(DEFAULT_STATE);
  state.meta.createdAt = now;
  state.meta.updatedAt = now;
  return state;
}

function normalizeProject(project = {}) {
  const config = projectConfigForStorage(configForProject(DEFAULT_CONFIG, project.config || DEFAULT_CONFIG));
  const state = normalizeState(project.state || freshState());
  return {
    ...project,
    title: project.title || config.project.title || "未命名项目",
    scriptText: project.scriptText || config.project.logline || state.storyScript?.synopsis || "",
    coverUrl: project.coverUrl || inferProjectCover(state),
    createdAt: project.createdAt || state.meta?.createdAt || new Date().toISOString(),
    updatedAt: project.updatedAt || state.meta?.updatedAt || project.createdAt || new Date().toISOString(),
    config,
    state
  };
}

function projectConfigForStorage(config = {}) {
  const merged = mergeConfig(DEFAULT_CONFIG, config);
  return {
    project: structuredClone(merged.project),
    modelSelection: structuredClone(merged.modelSelection)
  };
}

function configForProject(platformConfig = DEFAULT_CONFIG, storedProjectConfig = {}) {
  const projectConfig = storedProjectConfig.project ? storedProjectConfig : { project: storedProjectConfig };
  return mergeConfig(platformConfig, {
    project: projectConfig.project || {},
    modelSelection: projectConfig.modelSelection || {}
  });
}

function normalizeState(raw = {}) {
  const now = new Date().toISOString();
  const state = {
    ...structuredClone(DEFAULT_STATE),
    ...raw,
    meta: {
      createdAt: raw.meta?.createdAt || now,
      updatedAt: raw.meta?.updatedAt || raw.meta?.createdAt || now
    }
  };
  state.schemaVersion = 2;
  state.storyScript = state.storyScript || raw.script || null;
  state.cards = {
    characters: Array.isArray(raw.cards?.characters) ? raw.cards.characters : [],
    locations: Array.isArray(raw.cards?.locations) ? raw.cards.locations : [],
    props: Array.isArray(raw.cards?.props) ? raw.cards.props : []
  };
  if (raw.cards?.adapterError) {
    state.cards.adapterError = raw.cards.adapterError;
  }
  state.assetImages = Array.isArray(raw.assetImages) ? raw.assetImages : [];
  state.assetImageHistory = normalizeAssetImageHistory(raw.assetImageHistory, state.assetImages);
  const rawEpisodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  state.episodes = rawEpisodes.map((episode, index) => normalizeEpisode(episode, index + 1, state.storyScript));

  const hadLegacyEpisodeData = Boolean(raw.script || (Array.isArray(raw.shots) && raw.shots.length) || (Array.isArray(raw.promptPackages) && raw.promptPackages.length) || (Array.isArray(raw.images) && raw.images.length) || (Array.isArray(raw.videos) && raw.videos.length));
  if (!state.episodes.length && hadLegacyEpisodeData) {
    state.episodes = [
      normalizeEpisode({
        id: "EP01",
        title: "第 1 集",
        order: 1,
        script: raw.script || state.storyScript,
        shots: raw.shots,
        promptPackages: raw.promptPackages,
        images: raw.images,
        videos: raw.videos
      }, 1, state.storyScript)
    ];
  }

  state.activeEpisodeId = state.episodes.some((episode) => episode.id === raw.activeEpisodeId)
    ? raw.activeEpisodeId
    : state.episodes[0]?.id || null;
  state.events = Array.isArray(raw.events) ? raw.events : [];
  state.jobs = normalizeJobs(raw.jobs);
  for (const episode of state.episodes) {
    episode.promptPackages = hydratePromptPackageReferences(episode.promptPackages || [], state.cards, state.assetImages);
  }
  delete state.script;
  delete state.shots;
  delete state.promptPackages;
  delete state.images;
  delete state.videos;
  return state;
}

function normalizeEpisode(raw = {}, fallbackOrder = 1, fallbackScript = null) {
  const now = new Date().toISOString();
  const order = Number(raw.order || fallbackOrder || 1);
  const hasOwnScript = Object.prototype.hasOwnProperty.call(raw, "script");
  return {
    id: stringOr(raw.id, `EP${String(order).padStart(2, "0")}`),
    title: stringOr(raw.title, `第 ${order} 集`),
    order,
    synopsis: stringOr(raw.synopsis, raw.script?.synopsis || fallbackScript?.synopsis || ""),
    script: hasOwnScript ? raw.script : fallbackScript || null,
    shots: Array.isArray(raw.shots) ? raw.shots.map((shot) => ({
      ...shot,
      durationSec: 15,
      assetRefs: Array.isArray(shot.assetRefs) ? shot.assetRefs : Array.isArray(shot.asset_refs) ? shot.asset_refs : []
    })) : [],
    promptPackages: Array.isArray(raw.promptPackages) ? raw.promptPackages : [],
    images: Array.isArray(raw.images) ? raw.images : [],
    videos: Array.isArray(raw.videos) ? raw.videos : [],
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now
  };
}

function createEpisodeRecord({ title, order, script, synopsis } = {}) {
  const now = new Date().toISOString();
  const episodeOrder = Number(order || 1);
  return normalizeEpisode({
    id: `EP${String(episodeOrder).padStart(2, "0")}-${crypto.randomUUID().slice(0, 8)}`,
    title: title || `第 ${episodeOrder} 集`,
    order: episodeOrder,
    synopsis: synopsis || script?.synopsis || "",
    script,
    createdAt: now,
    updatedAt: now
  }, episodeOrder, script || null);
}

function getActiveEpisode(state = {}) {
  return (state.episodes || []).find((episode) => episode.id === state.activeEpisodeId) || null;
}

function requireActiveEpisode(state = {}) {
  const episode = getActiveEpisode(state);
  if (!episode) {
    throw new Error("请先创建剧集");
  }
  return episode;
}

function ensureStoryScriptFromConfig(state, config) {
  if (state.storyScript) {
    return state.storyScript;
  }
  const text = config.project?.logline || "";
  if (!text) {
    return null;
  }
  state.storyScript = scriptFromUserText(config.project.title || "未命名项目", text, config);
  return state.storyScript;
}

function allEpisodeShots(state = {}) {
  return (state.episodes || []).flatMap((episode) => (episode.shots || []).map((shot) => ({
    ...shot,
    episodeId: episode.id,
    episodeTitle: episode.title
  })));
}

function touchEpisode(episode) {
  episode.updatedAt = new Date().toISOString();
}

function touchState(state) {
  state.meta = state.meta || {};
  state.meta.updatedAt = new Date().toISOString();
}

function addEvent(state, type, message, source = "", detail = "") {
  state.events = [
    {
      id: crypto.randomUUID(),
      type,
      message,
      source,
      detail,
      time: new Date().toISOString()
    },
    ...(state.events || [])
  ].slice(0, 30);
}

function normalizeJobs(jobs = []) {
  const now = Date.now();
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.id && job?.key)
    .map((job) => {
      if (!["queued", "running"].includes(job.status)) {
        return job;
      }
      const updatedAt = Date.parse(job.updatedAt || job.createdAt || "");
      if (!Number.isFinite(updatedAt) || now - updatedAt <= JOB_STALE_MS) {
        return job;
      }
      return {
        ...job,
        status: "failed",
        label: job.label || "任务已超时",
        error: job.error || "任务超过 2 小时未返回，可能是服务已重启或上游请求中断。",
        updatedAt: new Date().toISOString()
      };
    })
    .slice(0, 80);
}

function jobKey(type, scopeId = "global") {
  return `${type}:${scopeId || "global"}`;
}

function findRunningJob(state = {}, type, scopeId = "global") {
  const key = jobKey(type, scopeId);
  return (state.jobs || []).find((job) => job.key === key && ["queued", "running"].includes(job.status)) || null;
}

async function getRunningJobSnapshot(type, scopeId = "global") {
  const state = await readState();
  const job = findRunningJob(state, type, scopeId);
  return job ? { state, job } : null;
}

async function markJobRunning(type, scopeId = "global", label = "") {
  return withStateWriteLock(async () => {
    const state = await readState();
    const running = findRunningJob(state, type, scopeId);
    if (running) {
      return { state, job: running, duplicate: true };
    }
    const job = upsertJob(state, { type, scopeId, label, status: "running" });
    touchState(state);
    await writeState(state);
    await syncActiveProject({ state });
    return { state, job, duplicate: false };
  });
}

async function markJobFinished(type, scopeId = "global", status = "succeeded", patch = {}) {
  return withStateWriteLock(async () => {
    const state = await readState();
    const job = finishJob(state, type, scopeId, status, patch);
    touchState(state);
    await writeState(state);
    await syncActiveProject({ state });
    return { state, job };
  });
}

function upsertJob(state, { type, scopeId = "global", label = "", status = "running", detail = "", result = null, error = "" }) {
  const now = new Date().toISOString();
  const key = jobKey(type, scopeId);
  const jobs = (state.jobs || []).filter((job) => job.key !== key);
  const existing = (state.jobs || []).find((job) => job.key === key);
  const job = {
    id: existing?.id || crypto.randomUUID(),
    key,
    type,
    scopeId,
    label,
    status,
    detail,
    error,
    result,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  state.jobs = [job, ...jobs].slice(0, 80);
  return job;
}

function finishJob(state, type, scopeId, status, patch = {}) {
  return upsertJob(state, {
    type,
    scopeId,
    label: patch.label || "",
    status,
    detail: patch.detail || "",
    error: patch.error || "",
    result: patch.result || null
  });
}

function normalizeAssetImageHistory(history = {}, assetImages = []) {
  const normalized = {};
  if (history && typeof history === "object" && !Array.isArray(history)) {
    for (const [assetId, rows] of Object.entries(history)) {
      normalized[assetId] = normalizeAssetHistoryRows(rows);
    }
  }
  for (const image of assetImages || []) {
    if (!image?.assetId || !image.url) continue;
    normalized[image.assetId] = addAssetImageHistoryEntry(normalized[image.assetId] || [], image);
  }
  return normalized;
}

function normalizeAssetHistoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.url)
    .map((row) => ({
      id: row.id || crypto.randomUUID(),
      url: row.url,
      file: row.file || null,
      source: row.source || "unknown",
      assetId: row.assetId || "",
      assetType: row.assetType || "",
      name: row.name || "",
      prompt: row.prompt || "",
      model: row.model || "",
      styleReferenceImages: row.styleReferenceImages || [],
      referenceStandard: row.referenceStandard || "",
      adapterError: row.adapterError || "",
      createdAt: row.createdAt || new Date().toISOString()
    }))
    .slice(0, 5);
}

function addAssetImageHistoryEntry(rows = [], image = {}) {
  if (!image?.url) return normalizeAssetHistoryRows(rows);
  const entry = {
    id: image.id || crypto.randomUUID(),
    url: image.url,
    file: image.file || null,
    source: image.source || "unknown",
    assetId: image.assetId || "",
    assetType: image.assetType || "",
    name: image.name || "",
    prompt: image.prompt || "",
    model: image.model || "",
    styleReferenceImages: image.styleReferenceImages || [],
    referenceStandard: image.referenceStandard || "",
    adapterError: image.adapterError || "",
    createdAt: image.createdAt || new Date().toISOString()
  };
  return [entry, ...(rows || []).filter((row) => row.url !== entry.url)].slice(0, 5);
}

async function appendEvent(type, message, source = "", detail = "") {
  const state = await readState();
  addEvent(state, type, message, source, detail);
  touchState(state);
  await writeState(state);
}

function mergeById(previous, next) {
  const map = new Map((previous || []).map((item) => [item.id, item]));
  for (const item of next) {
    map.set(item.id, item);
  }
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
}

async function withStateWriteLock(task) {
  const run = stateWriteQueue.then(task, task);
  stateWriteQueue = run.catch(() => {});
  return run;
}

async function runConcurrent(items, limit, worker) {
  const input = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, input.length || 1));
  const results = new Array(input.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(input[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runNext));
  return results;
}

function sourceSummary(items) {
  return [...new Set(items.map((item) => item.source))].join(", ");
}

function errorSummary(items) {
  return [...new Set(items.map((item) => item.adapterError).filter(Boolean))].join(" | ");
}

function publicError(error) {
  const raw = describeError(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ********")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-********")
    .slice(0, 500);
}

function describeError(error) {
  const parts = [];
    if (error?.message) {
      parts.push(error.message);
    } else if (error) {
      parts.push(String(error));
  } else {
    parts.push("Adapter request failed");
  }
  if (error?.name === "AbortError" || parts.some((part) => /aborted|AbortError/i.test(part))) {
    parts.push("请求超时，建议在模型设置中调高 timeoutMs，或缩短剧本/分镜输入后重试。");
  }

  const cause = error?.cause;
  if (cause?.code) {
    parts.push(`${cause.code}${cause.address ? ` ${cause.address}` : ""}${cause.port ? `:${cause.port}` : ""}`);
  }
  if (Array.isArray(cause?.errors) && cause.errors.length) {
    const details = cause.errors
      .slice(0, 3)
      .map((item) => `${item.code || item.name || "error"}${item.address ? ` ${item.address}` : ""}${item.port ? `:${item.port}` : ""}`)
      .join("; ");
    parts.push(details);
  }
  if (parts.some((part) => /\bEACCES\b/.test(part))) {
    parts.push("Node network access is blocked in the current runtime. Start the service from a normal local terminal or enable network access for node.");
  }
  return parts.filter(Boolean).join(" | ");
}

function adapterSkipReason(adapter = {}) {
  if (!adapter.provider || adapter.provider === "mock") {
    return "";
  }
  const missing = [];
  if (!adapter.endpoint) {
    missing.push("endpoint");
  }
  if (!adapter.model) {
    missing.push("model");
  }
  if (!adapter.apiKey) {
    missing.push("apiKey");
  }
  return missing.length ? `adapter missing ${missing.join(", ")}` : "";
}

async function writeBase64Asset(dir, fileName, b64) {
  const fullPath = path.join(dir, safeFileName(fileName));
  await fs.writeFile(fullPath, Buffer.from(b64, "base64"));
  return path.relative(ROOT, fullPath);
}

function cacheUrl(relativePath) {
  return `/${relativePath.replace(/\\/g, "/")}`;
}

function safeFileName(value) {
  return String(value || "asset")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

function hashNumber(text) {
  const hash = crypto.createHash("sha1").update(String(text)).digest();
  return hash.readUInt32BE(0);
}

function wrapSvgText(text, maxChars) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return [""];
  }
  const chunks = [];
  let current = "";
  for (const char of value) {
    const next = `${current}${char}`;
    if ([...next].length > maxChars && current) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function stringOr(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return String(fallback || "");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(value) {
  return escapeXml(value).replace(/'/g, "&#39;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
