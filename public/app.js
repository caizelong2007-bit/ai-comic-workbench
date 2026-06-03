const api = {
  async get(path) {
    const response = await fetch(path);
    return parseResponse(response);
  },
  async post(path, body = {}) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return parseResponse(response);
  }
};

const viewMeta = {
  "project-settings": ["Project Settings", "项目设置", "项目剧本、项目属性和项目资产会作为所有剧集的统一基础。"],
  "episode-script": ["Episode Script", "分集剧本", "为当前剧集单独设置剧情，再进入 15s 分镜制作。"],
  "shot-making": ["Shot Making", "分镜制作", "把当前剧集剧本拆成多个 15s 视频分镜。"],
  "shot-editing": ["Shot Editing", "分镜剪辑", "视频片段生成后在这里做片段预览、排序和剪辑。"],
  "final-output": ["Output", "输出单集成片", "视频模型接入后在这里生成片段并合成单集成片。"]
};

const defaultStyleImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 160'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%23f4edff'/%3E%3Cstop offset='1' stop-color='%23dff6f2'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='120' height='160' rx='12' fill='url(%23g)'/%3E%3Ccircle cx='36' cy='42' r='18' fill='%238f64df' opacity='.28'/%3E%3Cpath d='M24 118 54 78l18 24 12-15 20 31z' fill='%230f8b8d' opacity='.35'/%3E%3C/svg%3E";
const maxUploadImageBytes = 15 * 1024 * 1024;
const maxPromptReferenceAssets = 6;

const els = {};
let current = {
  config: null,
  state: null,
  projects: [],
  activeProjectId: null,
  mode: "home",
  studioMode: "settings",
  activeView: "project-settings",
  activeSettingsTab: "project-script-block",
  activeAssetTab: "character",
  shotAssetTabs: {},
  assetHistoryRows: []
};
let busy = false;
const jobs = new Map();
const seenServerJobErrors = new Set();
let serverJobPollTimer = null;
let serverJobPollInFlight = false;
let videoTaskPollTimer = null;
let videoTaskPollInFlight = false;
let pendingDelete = null;
let promptEditor = null;
let shotEditor = null;

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  setActiveView("project-settings");
  loadState();
});

function bindElements() {
  for (const id of [
    "serviceStatus",
    "runAllBtn",
    "openModelCenterBtn",
    "openEventsBtn",
    "backProjectsBtn",
    "refreshBtn",
    "projectHome",
    "studioShell",
    "projectGrid",
    "projectSearchInput",
    "createProjectModal",
    "createProjectForm",
    "closeCreateProjectBtn",
    "createEpisodeModal",
    "createEpisodeForm",
    "closeCreateEpisodeBtn",
    "cancelCreateEpisodeBtn",
    "episodeCreateNote",
    "episodeCreateHint",
    "createEpisodeSubmitBtn",
    "confirmDeleteModal",
    "closeConfirmDeleteBtn",
    "cancelConfirmDeleteBtn",
    "confirmDeleteBtn",
    "confirmDeleteTitle",
    "confirmDeleteBody",
    "modelCenterModal",
    "closeModelCenterBtn",
    "styleModal",
    "styleForm",
    "closeStyleModalBtn",
    "cancelStyleBtn",
    "styleImageFileName",
    "assetModal",
    "assetForm",
    "closeAssetModalBtn",
    "cancelAssetBtn",
    "assetModalTitle",
    "assetIdInput",
    "assetTypeInput",
    "assetNameInput",
    "assetPromptInput",
    "assetImageInput",
    "assetImageFileInput",
    "assetImageHelp",
    "assetPreviewPanel",
    "assetImageHistory",
    "promptDetailModal",
    "closePromptDetailModalBtn",
    "promptDetailBody",
    "promptDetailCopyBtn",
    "promptDetailExportBtn",
    "promptDetailUseBtn",
    "shotEditorModal",
    "shotEditorForm",
    "closeShotEditorBtn",
    "cancelShotEditorBtn",
    "saveShotEditorBtn",
    "shotEditorTitle",
    "shotEditorMeta",
    "eventsModal",
    "closeEventsModalBtn",
    "eventsRefreshBtn",
    "sidebarProjectTitle",
    "sidebarProjectMeta",
    "addEpisodeBtn",
    "episodeList",
    "activeEpisodeName",
    "saveStoryBtn",
    "saveConfigBtn",
    "saveEpisodeScriptBtn",
    "saveEpisodeBriefBtn",
    "structureEpisodeScriptBtn",
    "toAttrsBtn",
    "toAssetsBtn",
    "finishProjectSetupBtn",
    "configForm",
    "styleCards",
    "styleIdInput",
    "styleNameInput",
    "styleImageInput",
    "styleImageFileInput",
    "stylePromptInput",
    "addStyleBtn",
    "projectScriptInput",
    "episodeScriptInput",
    "episodeScriptStatus",
    "currentEpisodeTitle",
    "inheritedAttrs",
    "genScriptBtn",
    "genShotsBtn",
    "genCardsBtn",
    "genImagesBtn",
    "genVideosBtn",
    "genVideoClipsBtn",
    "refreshVideoTasksBtn",
    "exportPromptPackagesBtn",
    "scriptOutput",
    "episodeScriptOutput",
    "shotsOutput",
    "cardsOutput",
    "videosOutput",
    "eventLog",
    "resetBtn",
    "toast",
    "viewEyebrow",
    "viewTitle",
    "viewSummary",
    "progressStrip",
    "outputSummary",
    "projectSetupNav",
    "episodeListNav",
    "episodeFlowNav"
  ]) {
    els[id] = document.getElementById(id);
  }
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", loadState);
  els.openModelCenterBtn.addEventListener("click", openModelCenterModal);
  els.openEventsBtn.addEventListener("click", openEventsModal);
  els.closeEventsModalBtn.addEventListener("click", closeEventsModal);
  els.eventsRefreshBtn.addEventListener("click", loadState);
  els.eventsModal.addEventListener("click", (event) => {
    if (event.target === els.eventsModal) closeEventsModal();
  });
  els.backProjectsBtn.addEventListener("click", showProjectHome);
  els.projectSearchInput.addEventListener("input", renderProjects);
  els.closeCreateProjectBtn.addEventListener("click", closeCreateProjectModal);
  els.createProjectModal.addEventListener("click", (event) => {
    if (event.target === els.createProjectModal) closeCreateProjectModal();
  });
  els.createProjectForm.addEventListener("submit", createProjectFromForm);
  els.closeCreateEpisodeBtn.addEventListener("click", closeCreateEpisodeModal);
  els.cancelCreateEpisodeBtn.addEventListener("click", closeCreateEpisodeModal);
  els.createEpisodeModal.addEventListener("click", (event) => {
    if (event.target === els.createEpisodeModal) closeCreateEpisodeModal();
  });
  els.createEpisodeForm.addEventListener("submit", createEpisodeFromForm);
  els.closeConfirmDeleteBtn.addEventListener("click", closeConfirmDeleteModal);
  els.cancelConfirmDeleteBtn.addEventListener("click", closeConfirmDeleteModal);
  els.confirmDeleteBtn.addEventListener("click", confirmPendingDelete);
  els.confirmDeleteModal.addEventListener("click", (event) => {
    if (event.target === els.confirmDeleteModal) closeConfirmDeleteModal();
  });
  els.closeModelCenterBtn.addEventListener("click", closeModelCenterModal);
  els.modelCenterModal.addEventListener("click", (event) => {
    if (event.target === els.modelCenterModal) closeModelCenterModal();
  });
  document.querySelectorAll("[data-open-model-center]").forEach((button) => {
    button.addEventListener("click", openModelCenterModal);
  });
  els.closeStyleModalBtn.addEventListener("click", closeStyleModal);
  els.cancelStyleBtn.addEventListener("click", closeStyleModal);
  els.styleModal.addEventListener("click", (event) => {
    if (event.target === els.styleModal) closeStyleModal();
  });
  els.styleForm.addEventListener("submit", addProjectStyle);
  els.closeAssetModalBtn.addEventListener("click", closeAssetModal);
  els.cancelAssetBtn.addEventListener("click", closeAssetModal);
  els.assetModal.addEventListener("click", (event) => {
    if (event.target === els.assetModal) closeAssetModal();
    const historyButton = event.target.closest("[data-select-asset-history]");
    if (historyButton) {
      const row = current.assetHistoryRows?.[Number(historyButton.dataset.selectAssetHistory)];
      selectAssetHistoryImage(row?.url || "");
    }
  });
  els.closePromptDetailModalBtn.addEventListener("click", closePromptDetailModal);
  els.promptDetailModal.addEventListener("click", (event) => {
    if (event.target === els.promptDetailModal) closePromptDetailModal();
    const subshotTab = event.target.closest("[data-subshot-tab]");
    if (subshotTab) {
      setPromptSubshotTab(subshotTab.dataset.subshotTab);
      return;
    }
    const previewToggle = event.target.closest("[data-toggle-request-preview]");
    if (previewToggle) {
      togglePromptRequestPreview();
      return;
    }
  });
  els.promptDetailBody.addEventListener("input", handlePromptEditorInput);
  els.promptDetailBody.addEventListener("focusin", handlePromptEditorFocusIn);
  els.promptDetailBody.addEventListener("focusout", handlePromptEditorFocusOut);
  els.promptDetailCopyBtn.addEventListener("click", () => copyPromptPackage(els.promptDetailCopyBtn.dataset.copyPrompt));
  els.promptDetailExportBtn.addEventListener("click", () => exportPromptPackage(els.promptDetailExportBtn.dataset.exportPrompt));
  els.promptDetailUseBtn.addEventListener("click", savePromptPackageEdits);
  els.closeShotEditorBtn.addEventListener("click", closeShotEditorModal);
  els.cancelShotEditorBtn.addEventListener("click", closeShotEditorModal);
  els.shotEditorModal.addEventListener("click", (event) => {
    if (event.target === els.shotEditorModal) closeShotEditorModal();
  });
  els.shotEditorForm.addEventListener("submit", saveShotEditorEdits);
  els.assetForm.addEventListener("submit", saveManualAsset);
  els.assetImageFileInput.addEventListener("change", loadAssetImageFile);
  els.saveStoryBtn.addEventListener("click", saveStoryScript);
  els.saveConfigBtn.addEventListener("click", saveConfig);
  document.querySelectorAll("[data-save-model-settings]").forEach((button) => {
    button.addEventListener("click", () => saveConfig({ message: "模型配置已保存" }));
  });
  document.querySelectorAll("[data-open-model-settings]").forEach((button) => {
    button.addEventListener("click", openModelSettings);
  });
  if (els.saveEpisodeScriptBtn) els.saveEpisodeScriptBtn.addEventListener("click", saveEpisodeScript);
  els.saveEpisodeBriefBtn.addEventListener("click", saveEpisodeBrief);
  els.structureEpisodeScriptBtn.addEventListener("click", structureEpisodeScript);
  els.toAttrsBtn.addEventListener("click", goToProjectAttrs);
  els.toAssetsBtn.addEventListener("click", goToProjectAssets);
  els.finishProjectSetupBtn.addEventListener("click", finishProjectSetup);
  els.projectScriptInput.addEventListener("input", updateAvailability);
  els.configForm.addEventListener("input", updateAvailability);
  els.configForm.addEventListener("change", updateAvailability);
  els.styleImageFileInput.addEventListener("change", loadStyleImageFile);
  els.styleCards.addEventListener("click", handleStyleCardsClick);
  document.querySelectorAll("[data-project-option]").forEach((button) => {
    button.addEventListener("click", () => setProjectOption(button.dataset.projectOption, button.dataset.value));
  });
  els.addEpisodeBtn.addEventListener("click", openCreateEpisodeModal);
  els.genScriptBtn.addEventListener("click", () => runStage("script"));
  els.genShotsBtn.addEventListener("click", () => runStage("shots"));
  els.genCardsBtn.addEventListener("click", () => runStage("cards"));
  els.genImagesBtn.addEventListener("click", () => runStage("images"));
  els.genVideosBtn.addEventListener("click", () => runStage("videos"));
  els.genVideoClipsBtn.addEventListener("click", () => runVideoClipsForCurrentEpisode());
  els.refreshVideoTasksBtn.addEventListener("click", () => refreshVideoTasks());
  els.exportPromptPackagesBtn.addEventListener("click", exportEpisodePromptPackages);
  els.runAllBtn.addEventListener("click", runAll);
  els.resetBtn.addEventListener("click", resetPipeline);

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.view));
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab));
  });
  document.querySelectorAll("[data-asset-tab]").forEach((button) => {
    button.addEventListener("click", () => setAssetTab(button.dataset.assetTab));
  });

  els.episodeList.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-episode]");
    if (deleteButton) {
      event.stopPropagation();
      openDeleteEpisodeConfirm(deleteButton.dataset.deleteEpisode);
      return;
    }
    const episodeButton = event.target.closest("[data-open-episode]");
    if (episodeButton) openEpisode(episodeButton.dataset.openEpisode);
  });

  els.shotsOutput.addEventListener("click", (event) => {
    const editShotButton = event.target.closest("[data-edit-shot]");
    if (editShotButton) {
      openShotEditorModal(editShotButton.dataset.editShot);
      return;
    }
    const viewPromptButton = event.target.closest("[data-view-prompt]");
    if (viewPromptButton) {
      openPromptDetailModal(viewPromptButton.dataset.viewPrompt);
      return;
    }
    const exportPromptButton = event.target.closest("[data-export-prompt]");
    if (exportPromptButton) {
      exportPromptPackage(exportPromptButton.dataset.exportPrompt);
      return;
    }
    const promptButton = event.target.closest("[data-generate-prompt]");
    if (promptButton) {
      runPromptPackage(promptButton.dataset.generatePrompt);
      return;
    }
    const packageAssetsButton = event.target.closest("[data-generate-package-assets]");
    if (packageAssetsButton) {
      runExtractShotAssets(packageAssetsButton.dataset.generatePackageAssets);
      return;
    }
    const generateClipButton = event.target.closest("[data-generate-video-clip]");
    if (generateClipButton) {
      runVideoClip(generateClipButton.dataset.generateVideoClip);
      return;
    }
    const refreshTaskButton = event.target.closest("[data-refresh-video-task]");
    if (refreshTaskButton) {
      refreshVideoTasks();
      return;
    }
    const shotAssetTab = event.target.closest("[data-shot-asset-tab]");
    if (shotAssetTab) {
      setShotAssetTab(shotAssetTab.dataset.shotId, shotAssetTab.dataset.shotAssetTab);
      return;
    }
    const shotAsset = event.target.closest("[data-shot-asset]");
    if (shotAsset) openAssetModal({ id: shotAsset.dataset.shotAsset });
  });
  els.cardsOutput.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-asset]");
    if (addButton) {
      openAssetModal({ type: addButton.dataset.addAsset });
      return;
    }
    const assetButton = event.target.closest("[data-generate-asset]");
    if (assetButton) {
      event.stopPropagation();
      runAssetImage(assetButton.dataset.generateAsset);
      return;
    }
    const deleteButton = event.target.closest("[data-delete-asset]");
    if (deleteButton) {
      event.stopPropagation();
      openDeleteAssetConfirm(deleteButton.dataset.deleteAsset);
      return;
    }
    const editButton = event.target.closest("[data-edit-asset]");
    if (editButton) {
      openAssetModal({ id: editButton.dataset.editAsset });
      return;
    }
  });
  els.videosOutput.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      setActiveView(viewButton.dataset.view);
      return;
    }
    const generateClipButton = event.target.closest("[data-generate-video-clip]");
    if (generateClipButton) {
      if (generateClipButton.dataset.generateVideoClip === "all") {
        runVideoClipsForCurrentEpisode();
      } else {
        runVideoClip(generateClipButton.dataset.generateVideoClip);
      }
      return;
    }
    const refreshTaskButton = event.target.closest("[data-refresh-video-task]");
    if (refreshTaskButton) {
      refreshVideoTasks();
      return;
    }
    const copyButton = event.target.closest("[data-copy-prompt]");
    if (copyButton) {
      copyPromptPackage(copyButton.dataset.copyPrompt);
      return;
    }
    const exportButton = event.target.closest("[data-export-prompt]");
    if (exportButton) {
      exportPromptPackage(exportButton.dataset.exportPrompt);
      return;
    }
    const assetButton = event.target.closest("[data-generate-asset]");
    if (assetButton) {
      runAssetImage(assetButton.dataset.generateAsset);
      return;
    }
    const packageAssetsButton = event.target.closest("[data-generate-package-assets]");
    if (packageAssetsButton) runPackageAssetImages(packageAssetsButton.dataset.generatePackageAssets);
  });

  els.projectGrid.addEventListener("click", (event) => {
    const createButton = event.target.closest("[data-create-project]");
    if (createButton) {
      openCreateProjectModal();
      return;
    }
    const settingsButton = event.target.closest("[data-project-settings]");
    if (settingsButton) {
      event.stopPropagation();
      openProject(settingsButton.dataset.projectSettings, { mode: "settings", tab: "project-script-block" });
      return;
    }
    const deleteButton = event.target.closest("[data-delete-project]");
    if (deleteButton) {
      event.stopPropagation();
      openDeleteProjectConfirm(deleteButton.dataset.deleteProject);
      return;
    }
    const projectCard = event.target.closest("[data-open-project]");
    if (projectCard) openProject(projectCard.dataset.openProject, { mode: "episodes" });
  });
}

function setActiveView(view) {
  current.activeView = view;
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === view);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  document.querySelectorAll(".episode-top-step").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  const [eyebrow, title, summary] = viewMeta[view] || viewMeta["project-settings"];
  els.viewEyebrow.textContent = eyebrow;
  els.viewTitle.textContent = title;
  els.viewSummary.textContent = summary;
}

function setSettingsTab(tabId) {
  current.activeSettingsTab = tabId;
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.settingsTab === tabId);
  });
  document.querySelectorAll(".settings-block").forEach((block) => {
    block.classList.toggle("is-active", block.id === tabId);
  });
}

function setAssetTab(type) {
  current.activeAssetTab = normalizeAssetType(type);
  document.querySelectorAll("[data-asset-tab]").forEach((button) => {
    button.classList.toggle("is-active", normalizeAssetType(button.dataset.assetTab) === current.activeAssetTab);
  });
  renderCards(current.state?.cards || {});
}

function setShotAssetTab(shotId, type = "all") {
  if (!shotId) return;
  current.shotAssetTabs = current.shotAssetTabs || {};
  current.shotAssetTabs[shotId] = normalizeShotAssetTab(type);
  render();
}

async function parseResponse(response) {
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`接口返回非 JSON 内容：HTTP ${response.status}`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function loadState() {
  await withBusy("state:refresh", async () => {
    const data = await api.get("/api/state");
    applyServerData(data);
    render();
    if (current.mode === "studio") {
      showStudio();
    } else {
      showProjectHome();
    }
    setServiceStatus("本地服务已连接", true);
  }, "刷新失败");
}

function applyServerData(data) {
  if (data.config) current.config = data.config;
  if (data.state) current.state = normalizeClientState(data.state);
  if (data.projects) current.projects = data.projects;
  if (data.activeProjectId) current.activeProjectId = data.activeProjectId;
  if (current.config) fillConfig(current.config);
  syncServerJobs(current.state?.jobs || []);
  syncSingleServerJob(data.job);
  scheduleVideoTaskPolling();
}

function syncServerJobs(serverJobs = [], options = {}) {
  const activeServerKeys = new Set();
  for (const job of Array.isArray(serverJobs) ? serverJobs : []) {
    if (!job?.key) continue;
    const key = clientJobKeyFromServer(job);
    activeServerKeys.add(key);
    if (["queued", "running"].includes(job.status)) {
      jobs.set(key, {
        status: "running",
        label: job.label || "处理中",
        updatedAt: Date.parse(job.updatedAt || job.createdAt || "") || Date.now(),
        server: true
      });
      continue;
    }
    if (job.status === "failed") {
      const previous = jobs.get(key);
      const errorKey = `${job.id || key}:${job.updatedAt || ""}:${job.error || ""}`;
      if (previous?.status !== "error" || previous.serverError !== job.error) {
        jobs.set(key, {
          status: "error",
          label: job.label || "生成失败",
          updatedAt: Date.parse(job.updatedAt || job.createdAt || "") || Date.now(),
          server: true,
          serverError: job.error || ""
        });
        if (job.error && !seenServerJobErrors.has(errorKey)) {
          seenServerJobErrors.add(errorKey);
          toast(`${job.label || "生成失败"}：${job.error}`);
        }
        if (!shouldPersistJobError(key)) {
          clearJobSoon(key);
        }
      }
      continue;
    }
    if (job.status === "succeeded") {
      const previous = jobs.get(key);
      if (previous?.status === "running") {
        jobs.set(key, {
          status: "done",
          label: job.label || "已完成",
          updatedAt: Date.parse(job.updatedAt || job.createdAt || "") || Date.now(),
          server: true
        });
        clearJobSoon(key);
      }
    }
  }

  if (options.prune !== false) {
    for (const [key, job] of jobs.entries()) {
      if (job.server && job.status === "running" && !activeServerKeys.has(key)) {
        jobs.delete(key);
      }
    }
  }
  busy = hasRunningJobs();
  scheduleServerJobPolling();
}

function syncSingleServerJob(job) {
  if (!job?.key) return;
  syncServerJobs([job], { prune: false });
}

function hasServerRunningJobs() {
  for (const job of jobs.values()) {
    if (job.server && job.status === "running") return true;
  }
  return false;
}

function scheduleServerJobPolling() {
  if (serverJobPollTimer || !hasServerRunningJobs()) return;
  serverJobPollTimer = window.setTimeout(pollServerJobs, 3500);
}

async function pollServerJobs() {
  serverJobPollTimer = null;
  if (!hasServerRunningJobs() || serverJobPollInFlight) return;
  serverJobPollInFlight = true;
  try {
    const data = await api.get("/api/state");
    applyServerData(data);
    render();
  } catch (error) {
    console.warn(error);
  } finally {
    serverJobPollInFlight = false;
    scheduleServerJobPolling();
  }
}

function hasPendingVideoTasks() {
  return (current.state?.episodes || []).some((episode) => (episode.videos || []).some((video) => isPendingVideoTask(video)));
}

function isPendingVideoTask(video = {}) {
  const status = String(video.status || "").toLowerCase();
  return Boolean(video.taskId) && !["completed", "failed", "cancelled"].includes(status);
}

function scheduleVideoTaskPolling() {
  if (videoTaskPollTimer || !hasPendingVideoTasks()) return;
  videoTaskPollTimer = window.setTimeout(pollVideoTasks, 10000);
}

async function pollVideoTasks() {
  videoTaskPollTimer = null;
  if (!hasPendingVideoTasks() || videoTaskPollInFlight) return;
  videoTaskPollInFlight = true;
  try {
    const data = await api.post("/api/videos/status", {});
    applyServerData(data);
    render();
  } catch (error) {
    console.warn(error);
  } finally {
    videoTaskPollInFlight = false;
    scheduleVideoTaskPolling();
  }
}

function clientJobKeyFromServer(job = {}) {
  if (String(job.scopeId || "").startsWith("shot-assets:")) {
    return packageAssetsJobKey(String(job.scopeId).replace(/^shot-assets:/, ""));
  }
  if (job.type === "episode-script") {
    return `episode-script:${job.scopeId || "global"}`;
  }
  if (job.type === "prompt-package") {
    const scopeId = String(job.scopeId || "");
    const parts = scopeId.split(":").filter(Boolean);
    if (parts.length >= 2) return promptJobKeyForEpisode(parts[0], parts.slice(1).join(":"));
    return `prompt-package:legacy:${scopeId || "global"}`;
  }
  if (job.type === "video-clip") {
    return `video-clip:${job.scopeId || "video-clips"}`;
  }
  return job.key;
}

async function createProjectFromForm(event) {
  event.preventDefault();
  const formData = new FormData(els.createProjectForm);
  const title = String(formData.get("title") || "").trim();
  const scriptText = String(formData.get("scriptText") || "").trim();
  if (!title || !scriptText) {
    toast("请填写项目名称和整部短剧剧本");
    return;
  }
  await withBusy("project:create", async () => {
    const data = await api.post("/api/projects", { title, scriptText });
    applyServerData(data);
    closeCreateProjectModal();
    render();
    showStudio();
    showProjectSettings();
    setSettingsTab("project-script-block");
    toast("项目已创建");
  }, "创建项目失败");
}

async function openProject(projectId, options = {}) {
  await withBusy(`project:open:${projectId}`, async () => {
    const data = await api.post("/api/projects/open", { projectId });
    applyServerData(data);
    render();
    showStudio();
    if (options.mode === "settings") {
      showProjectSettings({ tab: options.tab });
    } else {
      showEpisodeWorkspace();
    }
    toast("项目已打开");
  }, "打开项目失败");
}

function showProjectSettings(options = {}) {
  setStudioMode("settings");
  setActiveView("project-settings");
  setSettingsTab(options.tab || nextProjectSetupTab());
}

function showEpisodeWorkspace() {
  if (!projectSetupComplete()) {
    toast("请先按顺序完成项目剧本、项目属性和项目资产");
    showProjectSettings();
    return;
  }
  setStudioMode("episodes");
  setActiveView("episode-script");
}

function setStudioMode(mode) {
  current.studioMode = mode;
  els.studioShell.dataset.mode = mode;
  els.projectSetupNav.classList.toggle("is-hidden", mode !== "settings");
  els.episodeListNav.classList.toggle("is-hidden", mode !== "episodes");
  els.episodeFlowNav.classList.toggle("is-hidden", mode !== "episodes");
  els.runAllBtn.classList.toggle("is-hidden", mode !== "episodes");
  els.resetBtn.classList.toggle("is-hidden", mode !== "episodes");
}

async function addEpisode() {
  return createEpisodeFromOptions({ brief: "" });
}

async function createEpisodeFromForm(event) {
  event.preventDefault();
  const brief = els.episodeCreateNote.value.trim();
  await createEpisodeFromOptions({ brief });
}

async function createEpisodeFromOptions({ brief = "" } = {}) {
  if (!projectSetupComplete()) {
    toast("请先完成项目剧本、项目属性和项目资产");
    showProjectSettings();
    return false;
  }
  const nextIndex = (current.state?.episodes?.length || 0) + 1;
  return withBusy("episode:add", async () => {
    await saveCurrentConfig();
    const body = {
      title: `第 ${nextIndex} 集`,
      brief
    };
    const data = await api.post("/api/episodes", body);
    applyServerData(data);
    closeCreateEpisodeModal();
    render();
    setStudioMode("episodes");
    setActiveView("episode-script");
    toast(`已添加第 ${nextIndex} 集${brief ? "，故事意图已保存" : ""}`);
  }, "添加剧集失败");
}

async function openEpisode(episodeId) {
  await withBusy(`episode:open:${episodeId}`, async () => {
    const data = await api.post("/api/episodes/open", { episodeId });
    current.state = normalizeClientState(data.state);
    render();
    setActiveView("episode-script");
    toast("剧集已切换");
  }, "切换剧集失败");
}

function openDeleteProjectConfirm(projectId) {
  const project = (current.projects || []).find((item) => item.id === projectId);
  if (!project) {
    toast("项目不存在或已删除");
    return;
  }
  pendingDelete = { type: "project", id: projectId };
  els.confirmDeleteTitle.textContent = "删除项目";
  els.confirmDeleteBtn.textContent = "删除项目";
  els.confirmDeleteBody.innerHTML = `
    <p>删除后将移除该项目的剧本、资产、分集、提示词和视频任务记录，并清理不再被引用的本地缓存文件。</p>
    <dl class="delete-summary">
      <div><dt>项目</dt><dd>${escapeHtml(displayProjectTitle(project))}</dd></div>
      <div><dt>分集</dt><dd>${escapeHtml(project.stats?.episodes || 0)} 集</dd></div>
      <div><dt>资产</dt><dd>${escapeHtml(project.stats?.assets || 0)} 个</dd></div>
      <div><dt>分镜</dt><dd>${escapeHtml(project.stats?.shots || 0)} 个</dd></div>
      <div><dt>提示词包</dt><dd>${escapeHtml(project.stats?.promptPackages || 0)} 个</dd></div>
      <div><dt>更新时间</dt><dd>${escapeHtml(formatTime(project.updatedAt || project.createdAt))}</dd></div>
    </dl>
  `;
  els.confirmDeleteModal.classList.remove("is-hidden");
}

function openDeleteEpisodeConfirm(episodeId) {
  const episode = (current.state?.episodes || []).find((item) => item.id === episodeId);
  if (!episode) {
    toast("剧集不存在或已删除");
    return;
  }
  pendingDelete = { type: "episode", id: episodeId };
  els.confirmDeleteTitle.textContent = "删除剧集";
  els.confirmDeleteBtn.textContent = "删除剧集";
  els.confirmDeleteBody.innerHTML = `
    <p>删除后将移除该剧集的剧本、分镜、提示词包和视频任务记录。项目资产库不会被删除。</p>
    <dl class="delete-summary">
      <div><dt>剧集</dt><dd>${escapeHtml(episode.title || episode.id)}</dd></div>
      <div><dt>分镜</dt><dd>${escapeHtml((episode.shots || []).length)} 个</dd></div>
      <div><dt>提示词包</dt><dd>${escapeHtml((episode.promptPackages || []).length)} 个</dd></div>
      <div><dt>视频任务</dt><dd>${escapeHtml((episode.videos || []).length)} 个</dd></div>
      <div><dt>更新时间</dt><dd>${escapeHtml(formatTime(episode.updatedAt || episode.createdAt))}</dd></div>
    </dl>
  `;
  els.confirmDeleteModal.classList.remove("is-hidden");
}

function openDeleteAssetConfirm(assetId) {
  const asset = findClientAsset(assetId);
  if (!asset) {
    toast("资产不存在或已删除");
    return;
  }
  const usage = assetUsageSummary(assetId);
  pendingDelete = { type: "asset", id: assetId };
  els.confirmDeleteTitle.textContent = "删除资产";
  els.confirmDeleteBtn.textContent = "删除资产";
  els.confirmDeleteBody.innerHTML = `
    <p>删除后将移除资产卡、当前图和历史图，并从分镜/提示词包中移除引用；已生成且引用该资产的视频会标记为需要重新生成。</p>
    <dl class="delete-summary">
      <div><dt>资产</dt><dd>${escapeHtml(asset.name || asset.id)}</dd></div>
      <div><dt>类型</dt><dd>${escapeHtml(assetTypeLabel(asset.type))}</dd></div>
      <div><dt>历史图</dt><dd>${escapeHtml(usage.historyCount)} 张</dd></div>
      <div><dt>引用分镜</dt><dd>${escapeHtml(usage.shots)} 个</dd></div>
      <div><dt>引用提示词</dt><dd>${escapeHtml(usage.packages)} 个</dd></div>
      <div><dt>引用视频</dt><dd>${escapeHtml(usage.videos)} 个</dd></div>
    </dl>
  `;
  els.confirmDeleteModal.classList.remove("is-hidden");
}

function closeConfirmDeleteModal() {
  pendingDelete = null;
  els.confirmDeleteModal.classList.add("is-hidden");
  els.confirmDeleteBody.innerHTML = "";
}

async function confirmPendingDelete() {
  if (!pendingDelete) return;
  const target = pendingDelete;
  const labels = { project: "项目", episode: "剧集", asset: "资产" };
  await withBusy(`delete:${target.type}:${target.id}`, async () => {
    const data = await api.post(deleteEndpoint(target.type), deletePayload(target));
    applyServerData(data);
    closeConfirmDeleteModal();
    render();
    if (target.type === "project") {
      showProjectHome();
    } else if (target.type === "episode") {
      setStudioMode("episodes");
      setActiveView("episode-script");
    } else if (target.type === "asset") {
      setAssetTab(current.activeAssetTab);
    }
    toast(`${labels[target.type] || "内容"}已删除${data.removedFiles?.length ? `，清理缓存 ${data.removedFiles.length} 个` : ""}`);
  }, `删除${labels[target.type] || "内容"}失败`);
}

function deleteEndpoint(type) {
  return {
    project: "/api/projects/delete",
    episode: "/api/episodes/delete",
    asset: "/api/assets/delete"
  }[type];
}

function deletePayload(target) {
  if (target.type === "project") return { projectId: target.id };
  if (target.type === "episode") return { episodeId: target.id };
  return { assetId: target.id };
}

function showProjectHome() {
  current.mode = "home";
  els.projectHome.classList.remove("is-hidden");
  els.studioShell.classList.add("is-hidden");
  els.runAllBtn.classList.add("is-hidden");
  els.backProjectsBtn.classList.add("is-hidden");
  renderProjects();
}

function showStudio() {
  current.mode = "studio";
  els.projectHome.classList.add("is-hidden");
  els.studioShell.classList.remove("is-hidden");
  els.backProjectsBtn.classList.remove("is-hidden");
  setStudioMode(current.studioMode || "settings");
}

async function goToProjectAttrs() {
  if (!projectScriptInputReady()) {
    toast("请先填写项目剧本");
    return;
  }
  const ok = await saveStoryScript({ silent: true });
  if (ok) setSettingsTab("project-attrs-block");
}

async function goToProjectAssets() {
  if (!projectAttributesInputReady()) {
    toast("请先补齐视频风格、尺寸、长度、字幕和对白语言");
    return;
  }
  const ok = await saveConfig({ silent: true, requireComplete: true });
  if (ok) setSettingsTab("project-assets-block");
}

function finishProjectSetup() {
  if (!projectSetupComplete()) {
    toast("请先完成项目剧本、项目属性和项目资产");
    setSettingsTab(nextProjectSetupTab());
    return;
  }
  setStudioMode("episodes");
  setActiveView("episode-script");
  if (!getActiveEpisode()) toast("项目设置已完成，可以在左侧添加剧集");
}

function openCreateProjectModal() {
  els.createProjectForm.reset();
  els.createProjectModal.classList.remove("is-hidden");
  els.createProjectForm.elements.title.focus();
}

function closeCreateProjectModal() {
  els.createProjectModal.classList.add("is-hidden");
}

function openCreateEpisodeModal() {
  if (!projectSetupComplete()) {
    toast("请先完成项目剧本、项目属性和项目资产");
    showProjectSettings();
    return;
  }
  els.createEpisodeForm.reset();
  els.createEpisodeSubmitBtn.textContent = "创建剧集";
  els.episodeCreateNote.placeholder = "可以留空。填写后会保存为本集意图；不填写时，后续点击“生成/完善剧本”会根据项目总剧本和上一集自动续写。";
  els.episodeCreateHint.textContent = "新建剧集只创建空白剧集，不会立即调用 LLM；请在分集剧本页点击“生成/完善剧本”。";
  els.createEpisodeModal.classList.remove("is-hidden");
  els.episodeCreateNote.focus();
}

function closeCreateEpisodeModal() {
  els.createEpisodeModal.classList.add("is-hidden");
}

function openStyleModal(styleId = "") {
  const style = styleId ? currentProjectStyleOptions().find((item) => item.id === styleId) : null;
  els.styleForm.reset();
  els.styleIdInput.value = style?.id || "";
  els.styleNameInput.value = style?.name || "";
  els.styleImageInput.value = style?.imageUrl || "";
  els.stylePromptInput.value = style?.prompt || "";
  document.getElementById("styleModalTitle").textContent = style ? "编辑风格" : "添加风格";
  els.styleImageFileName.textContent = "支持本地图片，或在下方粘贴图片地址";
  if (style?.imageUrl) {
    els.styleImageFileName.textContent = "已设置参考图，可上传替换";
  }
  els.addStyleBtn.textContent = style ? "保存修改" : "提交";
  els.styleModal.classList.remove("is-hidden");
  els.styleNameInput.focus();
}

function closeStyleModal() {
  els.styleModal.classList.add("is-hidden");
}

function openAssetModal({ type, id } = {}) {
  const asset = id ? findClientAsset(id) : null;
  const assetType = normalizeAssetType(type || asset?.type || current.activeAssetTab);
  els.assetForm.reset();
  els.assetIdInput.value = asset?.id || "";
  els.assetTypeInput.value = assetType;
  els.assetNameInput.value = asset?.name || "";
  els.assetPromptInput.value = asset?.prompt || "";
  els.assetImageInput.value = asset?.imageUrl || "";
  els.assetModalTitle.textContent = `${asset ? "编辑" : "手动添加"}${assetTypeLabel(assetType)}`;
  els.assetImageHelp.textContent = asset?.imageUrl ? "已有关联参考图，可重新上传替换" : "支持 png、jpg、webp 格式，大小不超过 15MB";
  updateAssetPreview(asset?.imageUrl || "");
  renderAssetImageHistory(asset?.id || "", asset?.imageUrl || "");
  els.assetModal.classList.remove("is-hidden");
  els.assetNameInput.focus();
}

function closeAssetModal() {
  els.assetModal.classList.add("is-hidden");
  if (els.assetImageHistory) els.assetImageHistory.innerHTML = "";
}

function openModelSettings() {
  closeAssetModal();
  setStudioMode("settings");
  setActiveView("project-settings");
  setSettingsTab("model-settings-block");
}

function openModelCenterModal() {
  if (!current.config) {
    toast("配置加载中，请稍后再打开模型中心");
    return;
  }
  fillConfig(current.config);
  els.modelCenterModal.classList.remove("is-hidden");
}

function closeModelCenterModal() {
  els.modelCenterModal.classList.add("is-hidden");
}

function openPromptDetailModal(packageId) {
  const pack = (getActiveEpisode()?.promptPackages || []).find((item) => item.id === packageId);
  if (!pack) {
    toast("请先生成分镜提示词");
    return;
  }
  const shot = (getActiveEpisode()?.shots || []).find((item) => item.id === pack.shotId) || {};
  promptEditor = createPromptEditorState(pack, shot);
  els.promptDetailBody.innerHTML = renderPromptDetail(pack, shot);
  attachPromptMentionEditors();
  els.promptDetailCopyBtn.dataset.copyPrompt = pack.id;
  els.promptDetailExportBtn.dataset.exportPrompt = pack.id;
  els.promptDetailUseBtn.textContent = "保存修改";
  els.promptDetailModal.classList.remove("is-hidden");
}

function closePromptDetailModal() {
  detachPromptMentionEditors();
  els.promptDetailModal.classList.add("is-hidden");
  els.promptDetailBody.innerHTML = "";
  els.promptDetailCopyBtn.dataset.copyPrompt = "";
  els.promptDetailExportBtn.dataset.exportPrompt = "";
  promptEditor = null;
}

function openShotEditorModal(shotId) {
  const episode = getActiveEpisode();
  const shot = (episode?.shots || []).find((item) => item.id === shotId);
  if (!shot) {
    toast("没有找到分镜脚本");
    return;
  }
  shotEditor = {
    episodeId: episode.id,
    shotId: shot.id
  };
  const form = els.shotEditorForm;
  form.elements.sceneId.value = shot.sceneId || "";
  form.elements.shotType.value = shot.shotType || "";
  form.elements.camera.value = shot.camera || "";
  form.elements.action.value = shot.action || "";
  form.elements.dialogue.value = shot.dialogue || "";
  form.elements.assetNotes.value = shot.assetNotes || "";
  form.elements.visualNotes.value = shot.visualNotes || "";
  form.elements.continuity.value = shot.continuity || "";
  els.shotEditorTitle.textContent = `编辑分镜脚本 ${shot.id}`;
  els.shotEditorMeta.textContent = `${shot.durationSec || 15}s / ${shot.sceneId || "未指定场景"}`;
  els.shotEditorModal.classList.remove("is-hidden");
  form.elements.camera.focus();
}

function closeShotEditorModal() {
  els.shotEditorModal.classList.add("is-hidden");
  els.shotEditorForm.reset();
  shotEditor = null;
}

async function saveShotEditorEdits(event) {
  event.preventDefault();
  if (!shotEditor?.shotId) return;
  const formData = new FormData(els.shotEditorForm);
  const shot = {
    sceneId: String(formData.get("sceneId") || "").trim(),
    shotType: String(formData.get("shotType") || "").trim(),
    camera: String(formData.get("camera") || "").trim(),
    action: String(formData.get("action") || "").trim(),
    dialogue: String(formData.get("dialogue") || "").trim(),
    assetNotes: String(formData.get("assetNotes") || "").trim(),
    visualNotes: String(formData.get("visualNotes") || "").trim(),
    continuity: String(formData.get("continuity") || "").trim()
  };
  if (!shot.camera || !shot.action) {
    toast("请至少填写运镜和画面动作");
    return;
  }
  await withBusy(`shot:save:${shotEditor.shotId}`, async () => {
    const data = await api.post("/api/shots/save", {
      episodeId: shotEditor.episodeId,
      shotId: shotEditor.shotId,
      shot
    });
    applyServerData(data);
    closeShotEditorModal();
    render();
    toast("分镜脚本已保存，相关提示词和视频需要重新确认");
  }, "保存分镜失败");
}

function openEventsModal() {
  renderEvents(current.state?.events || []);
  els.eventsModal.classList.remove("is-hidden");
}

function closeEventsModal() {
  els.eventsModal.classList.add("is-hidden");
}

function setPromptSubshotTab(subshotId) {
  els.promptDetailBody.querySelectorAll("[data-subshot-tab]").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.subshotTab === subshotId);
  });
  els.promptDetailBody.querySelectorAll("[data-subshot-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.subshotPanel === subshotId);
  });
}

function createPromptEditorState(pack = {}, shot = {}) {
  const referenceAssets = uniqueAssets([
    ...(pack.assetReferences || []),
    ...clientAssetCatalog().filter((asset) => (pack.assetRefs || []).includes(asset.id))
  ]);
  return {
    packageId: pack.id,
    episodeId: getActiveEpisode()?.id || "",
    shotId: pack.shotId || shot.id || "",
    tagifyFields: [],
    attachedFields: [],
    manualEdited: Boolean(pack.manualEditedAt),
    showRequestPreview: false,
    assetCatalog: clientAssetCatalog(),
    selectedRefs: new Set(referenceAssets.map((asset) => asset.id))
  };
}

function handlePromptEditorInput(event) {
  const field = event.target.closest("[data-prompt-editor]");
  if (!field || !promptEditor) return;
  updatePromptReferenceCounter();
}

function handlePromptEditorFocusIn(event) {
  const field = event.target.closest("[data-prompt-editor]");
  if (!field || !promptEditor) return;
  const row = field.closest(".prompt-edit-row");
  if (row) row.classList.add("is-editing");
}

function handlePromptEditorFocusOut(event) {
  const field = event.target.closest("[data-prompt-editor]");
  if (!field || !promptEditor) return;
  window.setTimeout(() => {
    const row = field.closest(".prompt-edit-row");
    if (row && document.activeElement !== field) row.classList.remove("is-editing");
    updatePromptMentionPreview(field);
  }, 0);
}

function promptFieldRefs(field) {
  return uniqueAssetIds(parsePromptMentions(field?.value || "").map((item) => item.id));
}

function promptFieldText(field) {
  if (!field) return "";
  return decodePromptMentionText(field.value || "").trim();
}

function attachPromptMentionEditors() {
  if (!promptEditor) return;
  const fields = [...els.promptDetailBody.querySelectorAll("[data-prompt-editor]")];
  promptEditor.attachedFields = fields;
  fields.forEach(updatePromptMentionPreview);
  if (typeof Tribute === "undefined") {
    toast("提示词 @ 选择器库未加载");
    return;
  }
  promptEditor.tribute = new Tribute({
    trigger: "@",
    values: promptMentionValues(),
    lookup: (item) => item.lookup,
    fillAttr: "insertText",
    requireLeadingSpace: false,
    allowSpaces: true,
    replaceTextSuffix: "",
    menuItemTemplate: (item) => renderPromptMentionMenuItem(item.original),
    selectTemplate: (item) => item?.original?.insertText || ""
  });
  promptEditor.tribute.attach(fields);
  fields.forEach((field) => {
    field.addEventListener("tribute-replaced", () => {
      updatePromptMentionPreview(field);
      updatePromptReferenceCounter();
    });
  });
}

function detachPromptMentionEditors() {
  if (promptEditor?.tribute && promptEditor.attachedFields?.length) {
    promptEditor.tribute.detach(promptEditor.attachedFields);
  }
}

function promptMentionValues() {
  return (promptEditor?.assetCatalog || []).map((asset) => {
    const label = asset.name && asset.name !== asset.id ? `${asset.name} ${asset.id}` : asset.name || asset.id;
    return {
      id: asset.id,
      name: asset.name || asset.id,
      type: asset.type,
      imageUrl: asset.imageUrl || "",
      lookup: uniqueAssetIds([asset.name, asset.id, ...(asset.aliases || [])]).join(" "),
      insertText: promptMentionDisplay(asset),
      label
    };
  });
}

function renderPromptMentionMenuItem(asset = {}) {
  return `
    <span class="prompt-mention-option">
      ${asset.imageUrl ? `<img src="${escapeAttr(asset.imageUrl)}" alt="${escapeAttr(asset.name || asset.id)}">` : `<i>${escapeHtml((asset.name || asset.id || "?").slice(0, 1))}</i>`}
      <strong>${escapeHtml(asset.name || asset.id)}</strong>
      <small>${escapeHtml(assetTypeLabel(asset.type))}</small>
    </span>
  `;
}

function promptMentionMarkup(asset = {}) {
  return promptMentionDisplay(asset);
}

function promptMentionDisplay(asset = {}) {
  return `@${asset.name || asset.id}`;
}

function parsePromptMentions(text = "", assets = promptEditor?.assetCatalog || clientAssetCatalog()) {
  const source = String(text || "");
  const matches = [];
  for (const asset of assets) {
    for (const term of promptMentionParseTerms(asset, assets)) {
      let start = 0;
      const needle = `@${term}`;
      while (start < source.length) {
        const index = source.indexOf(needle, start);
        if (index < 0) break;
        matches.push({ id: asset.id, name: asset.name || asset.id, index, raw: needle, length: needle.length });
        start = index + needle.length;
      }
    }
  }
  const accepted = [];
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  for (const match of matches) {
    if (accepted.some((item) => rangesOverlap(match.index, match.index + match.length, item.index, item.index + item.length))) continue;
    accepted.push(match);
  }
  return accepted.sort((a, b) => a.index - b.index);
}

function decodePromptMentionText(text = "") {
  const source = String(text || "");
  const mentions = parsePromptMentions(source);
  if (!mentions.length) return source;
  const pieces = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.index < cursor) continue;
    pieces.push(source.slice(cursor, mention.index));
    pieces.push(`@${mention.id} ${mention.name}`);
    cursor = mention.index + mention.raw.length;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

function updatePromptMentionPreview(field) {
  const row = field?.closest(".prompt-edit-row");
  const preview = row?.querySelector("[data-prompt-mention-preview]");
  if (!preview) return;
  preview.innerHTML = renderPromptMentionPreview(field.value || "");
  preview.classList.toggle("is-empty", !String(field.value || "").trim());
}

function renderPromptMentionPreview(text = "") {
  const source = String(text || "");
  if (!source.trim()) return "输入 @ 可从项目资产库插入参考对象";
  const mentions = parsePromptMentions(source);
  if (!mentions.length) return escapeHtml(source);
  const pieces = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.index < cursor) continue;
    pieces.push(escapeHtml(source.slice(cursor, mention.index)));
    pieces.push(renderPromptMentionChip(mention));
    cursor = mention.index + mention.raw.length;
  }
  pieces.push(escapeHtml(source.slice(cursor)));
  return pieces.join("");
}

function renderPromptMentionChip(mention = {}) {
  const asset = findClientAsset(mention.id) || { id: mention.id, name: mention.name, type: "prop", imageUrl: "" };
  const typeLabel = assetTypeLabel(asset.type);
  const label = asset.name || asset.id || mention.raw || "参考对象";
  return `
    <span class="prompt-asset-chip" title="${escapeAttr(`${typeLabel} ${label}`)}" data-asset-id="${escapeAttr(asset.id || "")}">
      ${asset.imageUrl ? `<img src="${escapeAttr(asset.imageUrl)}" alt="${escapeAttr(label)}">` : `<i>${escapeHtml(label.slice(0, 1))}</i>`}
      <b>${escapeHtml(typeLabel)}</b>
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function updatePromptReferenceCounter() {
  if (!promptEditor) return;
  const refs = collectPromptEditorRefs();
  promptEditor.selectedRefs = new Set(refs);
  const counter = els.promptDetailBody.querySelector("[data-prompt-ref-counter]");
  if (counter) {
    counter.textContent = `参考对象 ${refs.length}/${maxPromptReferenceAssets}`;
    counter.classList.toggle("is-over", refs.length > maxPromptReferenceAssets);
  }
}

function collectPromptEditorRefs() {
  const refs = [];
  els.promptDetailBody.querySelectorAll("[data-prompt-field]").forEach((field) => {
    refs.push(...promptFieldRefs(field));
  });
  return [...new Set(refs)];
}

function togglePromptRequestPreview() {
  if (!promptEditor) return;
  promptEditor.showRequestPreview = !promptEditor.showRequestPreview;
  const preview = els.promptDetailBody.querySelector("[data-request-preview-panel]");
  const button = els.promptDetailBody.querySelector("[data-toggle-request-preview]");
  if (preview) preview.classList.toggle("is-hidden", !promptEditor.showRequestPreview);
  if (button) button.textContent = promptEditor.showRequestPreview ? "隐藏实际提交内容" : "查看实际提交内容";
}

async function savePromptPackageEdits() {
  if (!promptEditor?.packageId) {
    closePromptDetailModal();
    return;
  }
  syncPromptTagifyEditors();
  const payload = readPromptEditorPayload();
  await withBusy(`prompt-edit:${promptEditor.packageId}`, async () => {
    const data = await api.post("/api/prompt-packages/save", payload);
    applyServerData(data);
    render();
    closePromptDetailModal();
    toast("分镜提示词已保存，相关视频已标记为提示词已更新");
  }, "保存分镜提示词失败");
}

function readPromptEditorPayload() {
  const fields = new Map([...els.promptDetailBody.querySelectorAll("[data-prompt-field]")].map((field) => [field.dataset.promptField, field]));
  const read = (key) => promptFieldText(fields.get(key));
  const refs = (key) => promptFieldRefs(fields.get(key));
  const pack = (getActiveEpisode()?.promptPackages || []).find((item) => item.id === promptEditor.packageId) || {};
  const audio = (pack.audio || []).map((row, index) => ({
    content: read(`audio:${index}`),
    assetRefs: refs(`audio:${index}`)
  }));
  const dialogue = (pack.dialogue || []).map((row, index) => ({
    speakerAssetId: [...refs(`dialogueText:${index}`), ...refs(`dialogueVoice:${index}`)][0] || "",
    voice: read(`dialogueVoice:${index}`),
    text: read(`dialogueText:${index}`)
  }));
  const subShots = (pack.subShots || []).map((subShot, index) => ({
    id: subShot.id,
    cameraLanguage: read(`subShot:${index}:cameraLanguage`),
    blocking: read(`subShot:${index}:blocking`),
    composition: read(`subShot:${index}:composition`),
    action: read(`subShot:${index}:action`),
    assetRefs: [
      ...refs(`subShot:${index}:cameraLanguage`),
      ...refs(`subShot:${index}:blocking`),
      ...refs(`subShot:${index}:composition`),
      ...refs(`subShot:${index}:action`)
    ]
  }));
  return {
    episodeId: promptEditor.episodeId,
    packageId: promptEditor.packageId,
    package: {
      soundDesign: read("soundDesign"),
      audio,
      dialogue,
      subShots,
      assetRefs: collectPromptEditorRefs()
    }
  };
}

async function saveManualAsset(event) {
  event.preventDefault();
  const name = els.assetNameInput.value.trim();
  if (!name) {
    toast("请填写资产名称");
    return;
  }
  await withBusy("asset:save", async () => {
    const data = await api.post("/api/assets/manual", {
      id: els.assetIdInput.value,
      type: els.assetTypeInput.value,
      name,
      prompt: els.assetPromptInput.value.trim(),
      imageUrl: els.assetImageInput.value,
      description: els.assetPromptInput.value.trim()
    });
    current.state = normalizeClientState(data.state);
    render();
    setAssetTab(els.assetTypeInput.value);
    closeAssetModal();
    toast("资产已保存");
  }, "保存资产失败");
}

function loadAssetImageFile() {
  const file = els.assetImageFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件");
    return;
  }
  if (file.size > maxUploadImageBytes) {
    toast("图片不能超过 15MB");
    els.assetImageFileInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const imageUrl = String(reader.result || "");
    els.assetImageInput.value = imageUrl;
    els.assetImageHelp.textContent = file.name;
    updateAssetPreview(imageUrl);
    renderAssetImageHistory(els.assetIdInput.value, imageUrl);
  });
  reader.readAsDataURL(file);
}

function updateAssetPreview(imageUrl) {
  if (imageUrl) {
    els.assetPreviewPanel.innerHTML = `<img src="${escapeAttr(imageUrl)}" alt="资产参考图">`;
    els.assetPreviewPanel.classList.add("has-image");
  } else {
    els.assetPreviewPanel.textContent = "暂无图片";
    els.assetPreviewPanel.classList.remove("has-image");
  }
}

function selectAssetHistoryImage(imageUrl = "") {
  if (!imageUrl) return;
  els.assetImageInput.value = imageUrl;
  els.assetImageHelp.textContent = imageUrl.startsWith("data:image/") ? "已选择新上传图片，保存后写入资产库" : "已选择历史图片，保存后生效";
  updateAssetPreview(imageUrl);
  renderAssetImageHistory(els.assetIdInput.value, imageUrl);
}

function assetImageHistoryRows(assetId = "", selectedUrl = "") {
  const history = current.state?.assetImageHistory || {};
  const rows = Array.isArray(history[assetId]) ? [...history[assetId]] : [];
  if (selectedUrl && !rows.some((row) => row.url === selectedUrl)) {
    rows.unshift({
      id: `pending-${Date.now()}`,
      url: selectedUrl,
      source: selectedUrl.startsWith("data:image/") ? "upload-preview" : "current",
      createdAt: new Date().toISOString()
    });
  }
  return rows.filter((row) => row?.url).slice(0, 5);
}

function renderAssetImageHistory(assetId = "", selectedUrl = "") {
  if (!els.assetImageHistory) return;
  const rows = assetImageHistoryRows(assetId, selectedUrl);
  current.assetHistoryRows = rows;
  if (!rows.length) {
    els.assetImageHistory.innerHTML = `<div class="asset-history-empty">暂无历史图片</div>`;
    return;
  }
  els.assetImageHistory.innerHTML = `
    <div class="asset-history-head">
      <strong>最近图片</strong>
      <small>最多保留 5 张，点击切换</small>
    </div>
    <div class="asset-history-list">
      ${rows.map((row, index) => `
        <button class="asset-history-item ${row.url === selectedUrl ? "is-active" : ""}" type="button" data-select-asset-history="${index}" title="${escapeAttr(formatAssetHistorySource(row.source))}">
          <img src="${escapeAttr(row.url)}" alt="资产历史图 ${index + 1}">
          <span>${escapeHtml(formatAssetHistorySource(row.source))}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function formatAssetHistorySource(source = "") {
  if (source === "manual") return "手动";
  if (source === "adapter") return "生成";
  if (source === "mock" || source === "mock-fallback") return "Mock";
  if (source === "upload-preview") return "待保存";
  if (source === "current") return "当前";
  return "历史";
}

async function addProjectStyle(event) {
  event.preventDefault();
  const styleId = els.styleIdInput.value.trim();
  const name = els.styleNameInput.value.trim();
  let imageUrl = els.styleImageInput.value.trim();
  const prompt = els.stylePromptInput.value.trim();
  if (!name || !prompt) {
    toast("请填写风格名称和风格提示词");
    return;
  }
  await withBusy(styleId ? "style:edit" : "style:add", async () => {
    if (imageUrl.startsWith("data:image/")) {
      const uploaded = await api.post("/api/upload/style-image", { name, dataUrl: imageUrl });
      imageUrl = uploaded.url || imageUrl;
    }
    const nextId = styleId || uniqueStyleId(styleIdFromName(name), currentProjectStyleOptions());
    const styles = currentProjectStyleOptions().filter((style) => style.id !== styleId && style.id !== nextId);
    const nextStyle = {
      id: nextId,
      name,
      imageUrl,
      prompt
    };
    styles.push(nextStyle);
    setProjectStyles(styles);
    await selectStyle(nextStyle, { silent: true });
    closeStyleModal();
    toast(styleId ? "风格已更新并应用" : "风格已添加并应用");
  }, styleId ? "编辑风格失败" : "添加风格失败");
}

function handleStyleCardsClick(event) {
  const deleteButton = event.target.closest("[data-delete-style]");
  if (deleteButton) {
    event.stopPropagation();
    removeStyle(deleteButton.dataset.deleteStyle);
    return;
  }
  const editButton = event.target.closest("[data-edit-style]");
  if (editButton) {
    event.stopPropagation();
    openStyleModal(editButton.dataset.editStyle);
    return;
  }
  if (event.target.closest("[data-add-style]")) {
    openStyleModal();
    return;
  }
  const styleButton = event.target.closest("[data-style-id]");
  if (styleButton) {
    const style = currentProjectStyleOptions().find((item) => item.id === styleButton.dataset.styleId);
    if (style) selectStyle(style);
    return;
  }
}

async function selectStyle(style, options = {}) {
  const field = els.configForm.elements.visualStyle;
  field.value = style.prompt;
  setActiveStyleId(style.id);
  renderStyleCards();
  updateAvailability();
  if (options.persist !== false) {
    await persistStyleConfig(options.silent ? "" : "风格已应用");
  }
}

async function removeStyle(styleId) {
  const styles = currentProjectStyleOptions().filter((style) => style.id !== styleId);
  setProjectStyles(styles);
  if (activeStyleId() === styleId) {
    const fallback = styles[0] || null;
    els.configForm.elements.visualStyle.value = fallback?.prompt || "";
    setActiveStyleId(fallback?.id || "");
  }
  renderStyleCards();
  updateAvailability();
  await persistStyleConfig("风格已删除");
}

async function persistStyleConfig(message = "") {
  const data = await api.post("/api/config", { config: readConfigForm() });
  applyServerData(data);
  render();
  if (message) toast(message);
}

function setProjectOption(name, value) {
  const field = els.configForm.elements[name];
  if (!field) return;
  field.value = value;
  if (name === "videoLength") {
    els.configForm.elements.episodeDuration.value = value;
  }
  if (name === "dialogueLanguage") {
    els.configForm.elements.language.value = value;
  }
  updateParamSelections();
  updateAvailability();
}

function loadStyleImageFile() {
  const file = els.styleImageFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件");
    return;
  }
  if (file.size > maxUploadImageBytes) {
    toast("图片不能超过 15MB");
    els.styleImageFileInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    els.styleImageInput.value = String(reader.result || "");
    els.styleImageFileName.textContent = file.name;
  });
  reader.readAsDataURL(file);
}

async function saveStoryScript(options = {}) {
  if (!projectScriptInputReady()) {
    toast("请先填写项目剧本");
    return false;
  }
  return withBusy("project:story:save", async () => {
    const project = readConfigForm().project;
    const data = await api.post("/api/story-script", {
      title: project.title,
      scriptText: project.logline
    });
    applyServerData(data);
    render();
    if (!options.silent) toast("项目剧本已保存");
  }, "保存剧本失败");
}

async function saveConfig(options = {}) {
  if (options.requireComplete && !projectAttributesInputReady()) {
    toast("请先补齐视频风格、尺寸、长度、字幕和对白语言");
    return false;
  }
  return withBusy("project:config:save", async () => {
    await saveCurrentConfig();
    const data = await api.get("/api/state");
    applyServerData(data);
    render();
    if (els.modelCenterModal && !els.modelCenterModal.classList.contains("is-hidden")) {
      closeModelCenterModal();
    }
    if (!options.silent) toast(options.message || "项目属性已保存，后续剧集会继承这些设置");
  }, "保存属性失败");
}

async function saveEpisodeScript() {
  const episode = getActiveEpisode();
  if (!episode) {
    toast("请先创建剧集");
    return;
  }
  const scriptText = els.episodeScriptInput.value.trim();
  await withBusy("episode:script:save", async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/episodes/script", {
      episodeId: episode.id,
      title: episode.title,
      scriptText
    });
    current.state = normalizeClientState(data.state);
    render();
    toast(`${episode.title} 剧本已保存`);
  }, "保存分集剧本失败");
}

async function saveEpisodeBrief(options = {}) {
  const episode = getActiveEpisode();
  if (!episode) {
    toast("请先创建剧集");
    return false;
  }
  const brief = els.episodeScriptInput.value.trim();
  return withBusy("episode:brief:save", async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/episodes/brief", {
      episodeId: episode.id,
      brief
    });
    applyServerData(data);
    render();
    if (!options.silent) toast(`${episode.title} 故事意图已保存`);
  }, "保存故事意图失败");
}

async function structureEpisodeScript() {
  const episode = getActiveEpisode();
  if (!episode) {
    toast("请先创建剧集");
    return false;
  }
  const brief = els.episodeScriptInput.value.trim();
  const key = episodeScriptJobKey(episode.id);
  return withBusy(key, async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/episodes/structure-script", {
      episodeId: episode.id,
      brief
    });
    applyServerData(data);
    render();
    if (data.duplicate) {
      toast(`${episode.title} 剧本正在生成/完善中，请稍后刷新查看`);
      return "keep-running";
    }
    toast(`${episode.title} 剧本已生成/完善${sourceSuffix(data)}`);
  }, "生成/完善分集剧本失败");
}

async function runStage(stage) {
  const path = {
    script: "/api/generate/script",
    shots: "/api/generate/shots",
    cards: "/api/generate/cards",
    images: "/api/generate/asset-images",
    videos: "/api/generate/prompt-packages"
  }[stage];

  if (stage === "videos") {
    await runPromptPackagesForCurrentEpisode();
    return;
  }

  await withBusy(stageJobKey(stage), async () => {
    await saveCurrentConfig();
    const body = stage === "shots" ? { episodeId: getActiveEpisode()?.id } : stage === "images" ? { force: true } : {};
    const data = await api.post(path, body);
    applyServerData(data);
    render();
    if (data.duplicate) {
      toast(`${stageName(stage)}正在生成中，请稍后刷新查看`);
      return "keep-running";
    }
    toast(`${stageName(stage)}完成${sourceSuffix(data)}`);
  }, `${stageName(stage)}失败`);
}

async function runAll() {
  await withBusy("batch:episode", async () => {
    await saveCurrentConfig();
    setJob(stageJobKey("shots"), "running", `正在生成${stageName("shots")}`);
    toast(`正在生成${stageName("shots")}`);
    try {
      const shotsData = await api.post("/api/generate/shots", { episodeId: getActiveEpisode()?.id });
      applyServerData(shotsData);
      if (shotsData.duplicate) {
        toast("15s 分镜正在生成中，请稍后刷新查看");
        return "keep-running";
      }
      setJob(stageJobKey("shots"), "done", `${stageName("shots")}完成`);
      clearJobSoon(stageJobKey("shots"));
      render();
    } catch (error) {
      setJob(stageJobKey("shots"), "error", `${stageName("shots")}失败`);
      clearJobSoon(stageJobKey("shots"));
      throw error;
    }
    await generatePromptPackagesByShot();
    const data = await api.get("/api/state");
    applyServerData(data);
    render();
    setActiveView("shot-making");
    toast("当前剧集的 Seedance 分镜提示词已生成，可在分镜制作的提示词列查看");
  }, "生成流程失败");
}

async function runAssetImage(assetId) {
  await withBusy(assetJobKey(assetId), async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/generate/asset-images", { assetIds: [assetId], force: true });
    applyServerData(data);
    render();
    if (data.duplicate) {
      toast(`资产图正在生成中：${assetId}`);
      return "keep-running";
    }
    toast(`资产参考图完成：${assetId}`);
  }, `资产参考图失败：${assetId}`);
}

async function runPromptPackage(shotId) {
  await withBusy(promptJobKey(shotId), async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/generate/prompt-packages", { episodeId: getActiveEpisode()?.id, shotIds: [shotId] });
    applyServerData(data);
    render();
    if (data.duplicate) {
      toast(`分镜提示词正在生成中：${shotId}`);
      return "keep-running";
    }
    toast(`分镜提示词完成：${shotId}`);
  }, `分镜提示词失败：${shotId}`);
}

async function runExtractShotAssets(shotId) {
  if (!shotId) {
    toast("请先生成分镜脚本");
    return;
  }
  const jobKey = packageAssetsJobKey(shotId);
  setJob(jobKey, "running", `正在提取 ${shotId}`);
  render();
  try {
    await saveCurrentConfig();
    const episode = getActiveEpisode();
    const data = await api.post("/api/generate/cards", {
      scope: "shot",
      episodeId: episode?.id,
      shotIds: [shotId]
    });
    applyServerData(data);
    if (data.duplicate) {
      render();
      toast(`分镜资产正在提取中：${shotId}`);
      return "keep-running";
    }
    setJob(jobKey, "done", `${shotId} 资产完成`);
    clearJobNow(jobKey);
    render();
    toast(`已提取并合并到项目资产库：${shotId}`);
  } catch (error) {
    console.error(error);
    setServiceStatus("本地服务异常", false);
    setJob(jobKey, "error", `${shotId} 资产失败`);
    render();
    toast(`提取资产失败：${shotId}: ${error.message}`);
    clearJobSoon(jobKey);
  }
}

async function runPromptPackagesForCurrentEpisode() {
  await withBusy(stageJobKey("videos"), async () => {
    await saveCurrentConfig();
    await generatePromptPackagesByShot();
    const data = await api.get("/api/state");
    applyServerData(data);
    render();
    setActiveView("shot-making");
    toast("分镜提示词批量生成完成，可在分镜制作中查看");
  }, "分镜提示词失败");
}

async function runVideoClipsForCurrentEpisode() {
  const episode = getActiveEpisode();
  if (!episode?.promptPackages?.length) {
    toast("请先在分镜制作中生成 Seedance 提示词包");
    setActiveView("shot-making");
    return;
  }
  await withBusy("video-clip:video-clips", async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/generate/videos", { episodeId: episode.id });
    applyServerData(data);
    render();
    setActiveView("shot-editing");
    if (data.duplicate) {
      toast("视频片段正在提交中，请稍后刷新");
      return "keep-running";
    }
    toast(`Seedance 视频任务已提交：${data.outputs?.length || 0} 个`);
  }, "视频片段生成失败");
}

async function refreshVideoTasks() {
  const hasAnyTask = (current.state?.episodes || []).some((episode) => (episode.videos || []).some((video) => video.taskId));
  if (!hasAnyTask) {
    toast("暂无可刷新的 Seedance 任务");
    return;
  }
  await withBusy("video-task:refresh", async () => {
    const data = await api.post("/api/videos/status", {});
    applyServerData(data);
    render();
    setActiveView("shot-editing");
    toast(`已刷新 ${data.outputs?.length || 0} 个视频任务`);
  }, "刷新视频任务失败");
}

async function runVideoClip(shotId) {
  const episode = getActiveEpisode();
  if (!episode || !shotId) return;
  await withBusy(`video-clip:${shotId}`, async () => {
    await saveCurrentConfig();
    const data = await api.post("/api/generate/videos", { episodeId: episode.id, shotIds: [shotId] });
    applyServerData(data);
    render();
    setActiveView("shot-editing");
    if (data.duplicate) {
      toast(`${shotId} 视频片段正在提交中`);
      return "keep-running";
    }
    toast(`${shotId} 视频任务已提交`);
  }, `${shotId} 视频片段生成失败`);
}

async function generatePromptPackagesByShot() {
  const episode = getActiveEpisode();
  const shots = episode?.shots || [];
  if (!shots.length) {
    throw new Error("请先生成 15s 分镜");
  }
  let done = 0;
  toast(`正在生成分镜提示词 0/${shots.length}`);
  await runClientPool(shots, 2, async (shot) => {
    const jobKey = promptJobKeyForEpisode(episode.id, shot.id);
    setJob(jobKey, "running", `正在生成 ${shot.id}`);
    render();
    try {
      const data = await api.post("/api/generate/prompt-packages", { episodeId: episode.id, shotIds: [shot.id] });
      if (data.duplicate) {
        applyServerData(data);
        render();
        return;
      }
      mergePromptPackagesFromState(data.state, episode.id);
      done += 1;
      setJob(jobKey, "done", `${shot.id} 完成`);
      clearJobSoon(jobKey);
      toast(`正在生成分镜提示词 ${done}/${shots.length}`);
      render();
    } catch (error) {
      setJob(jobKey, "error", `${shot.id} 失败`);
      clearJobSoon(jobKey);
      render();
      throw error;
    }
  });
}

async function runClientPool(items, limit, worker) {
  const input = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 1, input.length || 1));
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(input[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
}

function mergePromptPackagesFromState(serverState, episodeId) {
  const incomingState = normalizeClientState(serverState);
  if (!current.state) {
    current.state = incomingState;
    return;
  }
  const localEpisode = (current.state.episodes || []).find((item) => item.id === episodeId);
  const incomingEpisode = (incomingState.episodes || []).find((item) => item.id === episodeId);
  if (!localEpisode || !incomingEpisode) {
    current.state = incomingState;
    return;
  }
  localEpisode.promptPackages = mergePromptPackagesByShot(localEpisode.promptPackages || [], incomingEpisode.promptPackages || []);
  localEpisode.updatedAt = incomingEpisode.updatedAt || localEpisode.updatedAt;
  current.state.assetImages = mergeClientById(current.state.assetImages || [], incomingState.assetImages || []);
  current.state.cards = incomingState.cards || current.state.cards;
  current.state.events = mergeClientById(current.state.events || [], incomingState.events || []).slice(0, 30);
  current.state.meta = incomingState.meta || current.state.meta;
}

function mergeClientById(previous, next) {
  const map = new Map((previous || []).map((item) => [item.id, item]));
  for (const item of next || []) {
    map.set(item.id, item);
  }
  return [...map.values()];
}

function mergePromptPackagesByShot(previous, next) {
  const nextShotIds = new Set((next || []).map((item) => item.shotId).filter(Boolean));
  return [
    ...(previous || []).filter((item) => !nextShotIds.has(item.shotId)),
    ...(next || [])
  ];
}

async function runPackageAssetImages(packageId) {
  if (!packageId) {
    toast("请先生成 Seedance 2.0 提示词，再补齐资产图");
    return;
  }
  const pack = (getActiveEpisode()?.promptPackages || []).find((item) => item.id === packageId);
  if (!pack) {
    toast("没有找到提示词包");
    return;
  }
  const assetIds = (pack.assetReferences || []).filter((asset) => !asset.imageUrl).map((asset) => asset.id);
  if (!assetIds.length) {
    toast(`资产参考图已齐：${packageId}`);
    return;
  }
  await withBusy(packageAssetsJobKey(packageId), async () => {
    await saveCurrentConfig();
    assetIds.forEach((assetId) => setJob(assetJobKey(assetId), "running", "正在补齐资产图"));
    render();
    try {
      const data = await api.post("/api/generate/asset-images", { assetIds, missingOnly: true });
      applyServerData(data);
      if (data.duplicate) {
        render();
        toast(`镜头资产图正在生成中：${packageId}`);
        return "keep-running";
      }
      assetIds.forEach((assetId) => {
        setJob(assetJobKey(assetId), "done", "资产图完成");
        clearJobSoon(assetJobKey(assetId));
      });
      render();
      toast(`已生成镜头资产图：${packageId}`);
    } catch (error) {
      assetIds.forEach((assetId) => {
        setJob(assetJobKey(assetId), "error", "资产图失败");
        clearJobSoon(assetJobKey(assetId));
      });
      throw error;
    }
  }, `镜头资产图失败：${packageId}`);
}

async function copyPromptPackage(packageId) {
  const payload = buildPromptPackageExport(packageId);
  if (!payload) {
    toast("没有找到提示词包");
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast(`已复制：${packageId}`);
  } catch {
    toast("复制失败，请手动选中 Seedance Prompt");
  }
}

function exportPromptPackage(packageId) {
  const payload = buildPromptPackageExport(packageId);
  if (!payload) {
    toast("没有找到提示词包");
    return;
  }
  downloadJson(payload, `${safeFileNameForDownload(payload.meta.projectTitle)}-${safeFileNameForDownload(payload.meta.episodeTitle)}-${safeFileNameForDownload(packageId)}-seedance-prompt.json`);
  toast(`已导出：${packageId}`);
}

function exportEpisodePromptPackages() {
  const episode = getActiveEpisode();
  const packages = episode?.promptPackages || [];
  if (!episode || !packages.length) {
    toast("请先生成 Seedance 提示词包");
    return;
  }
  const project = current.config?.project || {};
  const videoProfile = activeVideoProfileForClient();
  const payload = {
    schemaVersion: promptPackageExportSchema(videoProfile),
    targetProfile: videoProfile.id || "seedance-2.0",
    videoProfile,
    exportedAt: new Date().toISOString(),
    meta: {
      projectId: current.activeProjectId || "",
      projectTitle: project.title || "",
      episodeId: episode.id || "",
      episodeTitle: episode.title || "",
      packageCount: packages.length
    },
    project: projectExportPayload(project),
    packages: packages.map((pack) => buildPromptPackageExport(pack.id)).filter(Boolean)
  };
  downloadJson(payload, `${safeFileNameForDownload(project.title)}-${safeFileNameForDownload(episode.title)}-seedance-prompt-packages.json`);
  toast(`已导出 ${payload.packages.length} 个提示词包`);
}

function buildPromptPackageExport(packageId) {
  const episode = getActiveEpisode();
  const pack = (episode?.promptPackages || []).find((item) => item.id === packageId);
  if (!episode || !pack) return null;
  const shot = (episode.shots || []).find((item) => item.id === pack.shotId) || {};
  const project = current.config?.project || {};
  const referenceAssets = normalizeExportAssets(promptPackageReferenceAssets(pack));
  const subShots = (pack.subShots || []).map((subShot, index) => ({
    id: subShot.id || `${pack.shotId || shot.id || "SH"}-${String(index + 1).padStart(2, "0")}`,
    timeRange: subShot.timeRange || "",
    cameraLanguage: subShot.cameraLanguage || "",
    blocking: subShot.blocking || "",
    composition: subShot.composition || "",
    action: subShot.action || "",
    assetRefs: filterExportAssetRefs(subShot.assetRefs || [], referenceAssets),
    seedanceText: buildSubShotSeedanceText(subShot, referenceAssets)
  }));
  const audio = (pack.audio || []).map((row) => ({
    timeRange: row.timeRange || "",
    content: row.content || "",
    assetRefs: filterExportAssetRefs(row.assetRefs || [], referenceAssets)
  }));
  const dialogue = (pack.dialogue || []).map((row) => ({
    timeRange: row.timeRange || "",
    speakerAssetId: row.speakerAssetId || "",
    speaker: assetLabelForExport(row.speakerAssetId, referenceAssets),
    voice: row.voice || "",
    text: row.text || ""
  }));
  return {
    schemaVersion: pack.schemaVersion || "seedance-prompt-package-v1",
    targetProfile: pack.targetProfile || current.config?.modelSelection?.videoProfile || "seedance-2.0",
    videoProfile: pack.videoProfile || activeVideoProfileForClient(),
    exportedAt: new Date().toISOString(),
    meta: {
      projectId: current.activeProjectId || "",
      projectTitle: project.title || "",
      episodeId: episode.id || "",
      episodeTitle: episode.title || "",
      shotId: pack.shotId || shot.id || "",
      packageId: pack.id || packageId,
      title: pack.title || "",
      durationSec: pack.durationSec || shot.durationSec || 15,
      aspectRatio: project.aspectRatio || "9:16"
    },
    project: projectExportPayload(project),
    shot: {
      id: shot.id || pack.shotId || "",
      sceneId: shot.sceneId || "",
      order: shot.order || "",
      durationSec: shot.durationSec || pack.durationSec || 15,
      shotType: shot.shotType || "",
      camera: shot.camera || "",
      action: shot.action || "",
      dialogue: shot.dialogue || "",
      continuity: shot.continuity || "",
      visualNotes: shot.visualNotes || "",
      assetNotes: shot.assetNotes || ""
    },
    preview: {
      soundDesign: pack.soundDesign || "",
      audio,
      dialogue,
      subShots,
      seedancePrompt: pack.seedancePrompt || buildSeedancePreview(shot, referenceAssets)
    },
    seedanceRequestDraft: {
      prompt: buildFinalSeedancePrompt(pack, shot, referenceAssets, audio, dialogue, subShots),
      durationSec: pack.durationSec || shot.durationSec || 15,
      aspectRatio: project.aspectRatio || "9:16",
      referenceImages: referenceAssets.map((asset, index) => ({
        index: index + 1,
        assetId: asset.id,
        type: asset.type,
        name: asset.name,
        imageUrl: asset.imageUrl || "",
        prompt: asset.prompt || "",
        description: asset.description || ""
      }))
    },
    referenceAssets
  };
}

function activeVideoProfileForClient() {
  const selected = current.config?.modelSelection?.videoProfile || "seedance-2.0";
  return (current.config?.videoProfiles || []).find((profile) => profile.id === selected) || { id: selected, name: selected };
}

function promptPackageExportSchema(videoProfile = {}) {
  if (!videoProfile.id || videoProfile.id === "seedance-2.0") {
    return "seedance-prompt-package-export-v1";
  }
  return `${videoProfile.id}-prompt-package-export-v1`;
}

function projectExportPayload(project = {}) {
  return {
    title: project.title || "",
    visualStyle: project.visualStyle || "",
    aspectRatio: project.aspectRatio || "9:16",
    videoLength: project.videoLength || project.episodeDuration || "",
    subtitles: project.subtitles || "on",
    dialogueLanguage: project.dialogueLanguage || project.language || "zh-CN"
  };
}

function normalizeExportAssets(assets = []) {
  return uniqueAssets(assets.map((asset) => {
    const full = findClientAsset(asset?.id || asset) || asset || {};
    return {
      id: full.id || "",
      type: normalizeAssetType(full.type || asset?.type || "prop"),
      typeLabel: assetTypeLabel(full.type || asset?.type || "prop"),
      name: full.name || full.id || "",
      aliases: Array.isArray(full.aliases) ? full.aliases : [],
      description: full.description || "",
      prompt: full.prompt || "",
      imageUrl: full.imageUrl || asset?.imageUrl || ""
    };
  })).filter((asset) => asset.id);
}

function promptPackageReferenceAssets(pack = {}) {
  const ids = Array.isArray(pack.assetRefs) ? pack.assetRefs : [];
  if (!ids.length) return [];
  const byId = new Map((pack.assetReferences || []).map((asset) => [asset.id, asset]));
  return uniqueAssetIds(ids)
    .map((id) => byId.get(id) || findClientAsset(id))
    .filter(Boolean);
}

function filterExportAssetRefs(refs = [], assets = []) {
  const allowed = new Set(assets.map((asset) => asset.id));
  return [...new Set((refs || []).filter((id) => allowed.has(id)))];
}

function assetLabelForExport(assetId, assets = []) {
  const asset = assets.find((item) => item.id === assetId);
  return asset ? `${asset.id} ${asset.name}`.trim() : assetId || "";
}

function buildSubShotSeedanceText(subShot = {}, assets = []) {
  return [
    subShot.timeRange ? `[${subShot.timeRange}]` : "",
    subShot.cameraLanguage ? `镜头语言：${subShot.cameraLanguage}` : "",
    subShot.blocking ? `站位：${subShot.blocking}` : "",
    subShot.composition ? `构图运镜：${subShot.composition}` : "",
    subShot.action ? `动作：${subShot.action}` : "",
    (subShot.assetRefs || []).length ? `参考资产：${filterExportAssetRefs(subShot.assetRefs, assets).map((id) => assetLabelForExport(id, assets)).join("；")}` : ""
  ].filter(Boolean).join("\n");
}

function activeProjectStyleForSeedancePrompt(project = {}) {
  const styles = projectStyleOptions(project);
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

function buildSeedanceReferenceBindingBlockForClient(assets = []) {
  const imageReferences = uniqueAssets(assets).filter((asset) => asset.imageUrl).slice(0, 6);
  if (!imageReferences.length) return "";
  return `参考图绑定（顺序与 image_urls 完全一致）：\n${imageReferences.map((asset, index) => {
    const label = `image_urls[${index}] = @${asset.id} ${asset.name || ""}`.trim();
    const type = asset.type ? `，${normalizeAssetType(asset.type)}` : "";
    return `${index + 1}. ${label}${type}。${seedanceReferenceBindingRuleForClient(asset)}`;
  }).join("\n")}`;
}

function seedanceReferenceBindingRuleForClient(asset = {}) {
  const type = normalizeAssetType(asset.type);
  if (type === "character") {
    return "这是角色身份参考图；角色出镜时必须以该图作为外观主锚点，保持脸型、发型、服装、身体比例、颜色和材质，不要被动作、光效或场景风格重塑。";
  }
  if (type === "location") {
    return "这是场景/空间布局参考图；保持空间结构、地标位置、家具/环境关系、材质和整体氛围，不要把场景图当作角色外观参考。";
  }
  if (type === "prop") {
    return "这是道具外观参考图；保持道具形状、颜色、材质、尺寸关系和关键识别点，不要把道具图当作角色或场景参考。";
  }
  return "这是视觉参考图；仅用于对应 @资产 的外观一致性，不要混用到其他资产。";
}

function buildSeedanceSubmissionSubShotBlockForClient(pack = {}, shot = {}, subShots = []) {
  const rows = Array.isArray(subShots) ? subShots : [];
  if (rows.length) {
    return `分镜提示词（仅按以下时间段生成视频画面）：\n${rows.map((subShot) => [
      subShot.timeRange ? `[${subShot.timeRange}]` : "",
      subShot.cameraLanguage || "",
      subShot.blocking || "",
      subShot.composition || "",
      subShot.action || "",
      subShot.assetRefs?.length ? `参考资产：${subShot.assetRefs.map((id) => `@${id}`).join(" ")}` : ""
    ].filter(Boolean).join("；")).join("\n")}`;
  }
  if (pack.seedancePrompt) {
    return `分镜提示词：\n${pack.seedancePrompt}`;
  }
  const fallback = [
    shot.camera || "",
    shot.action || "",
    shot.dialogue ? `台词：${shot.dialogue}` : "",
    shot.continuity ? `衔接：${shot.continuity}` : ""
  ].filter(Boolean).join("；");
  return fallback ? `分镜提示词：\n${fallback}` : "";
}

function buildFinalSeedancePrompt(pack = {}, shot = {}, assets = [], audio = [], dialogue = [], subShots = []) {
  const style = activeProjectStyleForSeedancePrompt(current.config?.project || {});
  return [
    "Seedance 2.0 视频生成提示词。请结合 image_urls 参考图生成连续视频，不要生成故事板图或首帧图。",
    buildSeedanceReferenceBindingBlockForClient(assets),
    style.prompt ? `项目统一风格：${style.prompt}` : "",
    buildSeedanceSubmissionSubShotBlockForClient(pack, shot, subShots),
    pack.soundDesign ? `分镜音效：\n${pack.soundDesign}` : "",
    audio.length ? `音效时间轴：\n${audio.map((row) => `${row.timeRange || ""} ${row.content || ""}${row.assetRefs?.length ? ` 关联资产：${row.assetRefs.map((id) => `@${id}`).join(" ")}` : ""}`.trim()).join("\n")}` : "",
    dialogue.length ? `分镜台词：\n${dialogue.map((row) => `${row.timeRange || ""} ${row.speakerAssetId ? `@${row.speakerAssetId}` : row.speaker ? `@${row.speaker}` : ""}${row.voice ? ` ${row.voice}` : ""}: ${row.text || ""}`.trim()).join("\n")}` : "",
    buildSeedanceSpeechLanguageRuleForClient(current.config?.project || {}, dialogue),
    "要求：严格保持参考图中的角色身份、场景布局、道具外观和项目风格；不要根据未绑定的文字描述重塑角色外观；不要新增未指定角色；不要生成字幕水印。"
  ].filter(Boolean).join("\n\n");
}

function buildSeedanceSpeechLanguageRuleForClient(project = {}, dialogue = []) {
  const code = project.dialogueLanguage || project.language || "zh-CN";
  const language = dialogueLanguageNameForPrompt(code);
  if (!dialogue.length) {
    return `语音语言规则：如需要生成角色语音或口播，必须使用项目对白语言：${language}。中文画面、镜头、动作、音效说明只作为制作指导，不是口播内容。`;
  }
  if (code === "zh-CN") {
    return [
      "语音语言规则：",
      "所有角色说出口的台词必须严格使用项目对白语言：中文。",
      "只朗读“分镜台词”区域中的台词文本；画面、镜头、动作、音效说明不是口播内容。"
    ].join("\n");
  }
  return [
    "Speech language rule:",
    `All spoken dialogue and generated speech must be in ${language} only.`,
    "Do not speak Chinese.",
    `If any dialogue line is accidentally written in another language, express its meaning in ${language} instead of speaking the source language.`,
    "Chinese text in this prompt is production guidance for visuals, camera, action, and sound design only. It is not narration and must not be spoken.",
    "Only speak the dialogue lines listed in the Dialogue/分镜台词 section."
  ].join("\n");
}

function downloadJson(payload, fileName) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "seedance-prompt-package.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileNameForDownload(value) {
  return String(value || "untitled")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "untitled";
}

async function saveCurrentConfig() {
  const data = await api.post("/api/config", { config: readConfigForm() });
  current.config = data.config;
  fillConfig(current.config);
  return data.config;
}

async function resetPipeline() {
  if (!confirm("重置会清空当前工作台状态，但不会删除已生成的 cache 文件。继续吗？")) return;
  await withBusy("state:reset", async () => {
    const data = await api.post("/api/reset");
    current.state = normalizeClientState(data.state);
    render();
    showProjectSettings();
    toast("流水线已重置");
  }, "重置失败");
}

async function withBusy(keyOrTask, taskOrFailPrefix, maybeFailPrefix) {
  const key = typeof keyOrTask === "string" ? keyOrTask : "global";
  const task = typeof keyOrTask === "string" ? taskOrFailPrefix : keyOrTask;
  const failPrefix = typeof keyOrTask === "string" ? maybeFailPrefix : taskOrFailPrefix;
  if (isJobRunning(key)) return false;
  setJob(key, "running", failPrefix || "处理中");
  try {
    const result = await task();
    if (result === "keep-running") {
      return true;
    }
    setJob(key, "done", failPrefix || "完成");
    return true;
  } catch (error) {
    console.error(error);
    setServiceStatus("本地服务异常", false);
    setJob(key, "error", failPrefix || "失败", { serverError: error.message });
    toast(`${failPrefix}: ${error.message}`);
    return false;
  } finally {
    if (jobs.get(key)?.status !== "error" || !shouldPersistJobError(key)) {
      clearJobSoon(key);
    }
  }
}

function shouldPersistJobError(key = "") {
  return (key.startsWith("prompt-package:") && !key.startsWith("prompt-package:legacy:")) || key.startsWith("episode-script:");
}

function setJob(key, status, label = "", detail = {}) {
  jobs.set(key, {
    status,
    label,
    updatedAt: Date.now(),
    ...detail
  });
  busy = hasRunningJobs();
  renderJobFeedback();
  updateAvailability();
}

function clearJobSoon(key) {
  window.setTimeout(() => {
    const job = jobs.get(key);
    if (job && job.status !== "running") {
      clearJobNow(key);
    }
  }, 1200);
}

function clearJobNow(key) {
  jobs.delete(key);
  busy = hasRunningJobs();
  renderJobFeedback();
  updateAvailability();
  scheduleServerJobPolling();
}

function isJobRunning(key) {
  return jobs.get(key)?.status === "running";
}

function hasRunningJobs() {
  for (const job of jobs.values()) {
    if (job.status === "running") return true;
  }
  return false;
}

function stageJobKey(stage) {
  return {
    script: "generate:script",
    shots: "generate:shots",
    cards: "generate:cards",
    images: "generate:asset-images",
    videos: "generate:prompt-packages"
  }[stage] || `generate:${stage}`;
}

function episodeScriptJobKey(episodeId = getActiveEpisode()?.id) {
  return `episode-script:episode-script:${episodeId || "global"}`;
}

function assetJobKey(assetId) {
  return `asset-image:${assetId}`;
}

function promptJobKey(shotId) {
  return promptJobKeyForEpisode(getActiveEpisode()?.id, shotId);
}

function promptJobKeyForEpisode(episodeId, shotId) {
  return `prompt-package:${[episodeId, shotId].filter(Boolean).join(":") || "global"}`;
}

function packageAssetsJobKey(packageId) {
  return `package-assets:${packageId}`;
}

function shotAssetsServerScope(shotId) {
  return `shot-assets:${shotId}`;
}

function relatedJobRunning(key) {
  const episodeGenerating = isJobRunning("batch:episode");
  const promptGenerating = isJobRunning(stageJobKey("videos"));
  const shotsGenerating = isJobRunning(stageJobKey("shots"));
  const assetsGenerating = isJobRunning(stageJobKey("images"));
  const cardsGenerating = isJobRunning(stageJobKey("cards"));
  const scriptStructuring = isJobRunning(episodeScriptJobKey());
  if (key.startsWith("episode-script:")) {
    return episodeGenerating || shotsGenerating || promptGenerating;
  }
  if (key.startsWith("prompt-package:")) {
    return promptGenerating || episodeGenerating || scriptStructuring;
  }
  if (key.startsWith("asset-image:")) {
    return assetsGenerating;
  }
  if (key.startsWith("package-assets:")) {
    return cardsGenerating;
  }
  if (key === stageJobKey("shots")) {
    return episodeGenerating || promptGenerating || scriptStructuring;
  }
  if (key === stageJobKey("videos")) {
    return episodeGenerating || shotsGenerating || scriptStructuring;
  }
  if (key === "video-clip:video-clips" || key === "video-task:refresh") {
    return episodeGenerating || promptGenerating || scriptStructuring;
  }
  if (key.startsWith("video-clip:")) {
    return episodeGenerating || promptGenerating || scriptStructuring || isJobRunning("video-clip:video-clips");
  }
  if (key === stageJobKey("images")) {
    return cardsGenerating;
  }
  if (key === stageJobKey("cards")) {
    return assetsGenerating || promptGenerating || episodeGenerating;
  }
  if (key === "project:story:save" || key === "project:config:save" || key === "episode:script:save" || key === "episode:brief:save") {
    return shotsGenerating || promptGenerating || episodeGenerating || scriptStructuring;
  }
  return false;
}

function renderJobFeedback() {
  document.querySelectorAll("[data-job-key]").forEach((element) => {
    const key = element.dataset.jobKey;
    const job = jobs.get(key);
    const running = job?.status === "running" || relatedJobRunning(key);
    element.classList.toggle("is-loading", running);
    element.classList.toggle("has-job-error", job?.status === "error");
    element.classList.toggle("has-job-done", job?.status === "done");
    if (element.tagName === "BUTTON") {
      element.disabled = running || element.dataset.locked === "true";
      if (element.dataset.idleText) {
        element.textContent = running ? (element.dataset.loadingText || "生成中...") : element.dataset.idleText;
      }
    }
  });
}

function updateAvailability() {
  const ready = projectReady();
  if (els.addEpisodeBtn) {
    els.addEpisodeBtn.disabled = isJobRunning("episode:add") || !ready;
    els.addEpisodeBtn.title = ready ? "添加剧集" : "请先完成项目剧本、项目属性和项目资产";
  }
  const hasEpisode = Boolean(getActiveEpisode());
  const hasEpisodeScript = Boolean(getActiveEpisode()?.script);
  setButtonLoading(els.genScriptBtn, "script", !projectScriptInputReady() || isJobRunning("batch:episode"));
  setButtonLoading(els.genCardsBtn, "cards", !projectScriptReady() || relatedJobRunning(stageJobKey("cards")));
  setButtonLoading(els.genImagesBtn, "images", !countCards(current.state?.cards) || relatedJobRunning(stageJobKey("images")));
  if (els.genImagesBtn) {
    els.genImagesBtn.title = countCards(current.state?.cards) ? "按当前项目风格强制重新生成全部资产参考图" : "请先提取或添加资产";
  }
  setButtonLoading(els.genShotsBtn, "shots", !hasEpisodeScript || relatedJobRunning(stageJobKey("shots")));
  if (els.genShotsBtn) {
    els.genShotsBtn.title = hasEpisodeScript ? "根据当前本集结构化剧本生成 15s 分镜脚本" : "请先在分集剧本页生成/完善本集结构化剧本";
  }
  setButtonLoading(els.genVideosBtn, "videos", !hasEpisode || !(getActiveEpisode()?.shots || []).length || relatedJobRunning(stageJobKey("videos")));
  setStandaloneButtonLoading(els.genVideoClipsBtn, "video-clip:video-clips", !hasEpisode || !(getActiveEpisode()?.promptPackages || []).length || relatedJobRunning("video-clip:video-clips"), "生成中...");
  const pendingVideos = (getActiveEpisode()?.videos || []).filter((video) => video.taskId && !["completed", "failed", "cancelled"].includes(String(video.status || "").toLowerCase())).length;
  setStandaloneButtonLoading(els.refreshVideoTasksBtn, "video-task:refresh", !pendingVideos || relatedJobRunning("video-task:refresh"), "刷新中...");
  if (els.exportPromptPackagesBtn) {
    const packageCount = getActiveEpisode()?.promptPackages?.length || 0;
    els.exportPromptPackagesBtn.disabled = !packageCount;
    els.exportPromptPackagesBtn.title = packageCount ? "导出当前剧集全部 Seedance 提示词包" : "请先生成 Seedance 提示词包";
  }
  if (els.saveEpisodeScriptBtn) els.saveEpisodeScriptBtn.disabled = isJobRunning("episode:script:save") || relatedJobRunning("episode:script:save") || !hasEpisode;
  if (els.saveEpisodeBriefBtn) els.saveEpisodeBriefBtn.disabled = isJobRunning("episode:brief:save") || relatedJobRunning("episode:brief:save") || !hasEpisode;
  setStandaloneButtonLoading(els.structureEpisodeScriptBtn, episodeScriptJobKey(), !hasEpisode || relatedJobRunning(episodeScriptJobKey()), "生成中...");
  if (els.saveStoryBtn) els.saveStoryBtn.disabled = isJobRunning("project:story:save") || relatedJobRunning("project:story:save");
  if (els.saveConfigBtn) els.saveConfigBtn.disabled = isJobRunning("project:config:save") || relatedJobRunning("project:config:save");
  if (els.runAllBtn) {
    els.runAllBtn.disabled = isJobRunning("batch:episode") || !hasEpisodeScript || current.studioMode !== "episodes";
    els.runAllBtn.title = hasEpisodeScript ? "生成当前剧集提示词" : "请先生成/完善本集结构化剧本";
  }
  scheduleVideoTaskPolling();
  renderJobFeedback();
  updateSettingsTabLocks();
}

function setButtonLoading(button, stage, locked = false) {
  if (!button) return;
  const running = isJobRunning(stageJobKey(stage));
  button.dataset.jobKey = stageJobKey(stage);
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.dataset.loadingText = `生成中...`;
  button.dataset.locked = locked ? "true" : "false";
  button.disabled = running || locked;
}

function setStandaloneButtonLoading(button, key, locked = false, loadingText = "处理中...") {
  if (!button) return;
  const running = isJobRunning(key);
  button.dataset.jobKey = key;
  button.dataset.idleText = button.dataset.idleText || button.textContent;
  button.dataset.loadingText = loadingText;
  button.dataset.locked = locked ? "true" : "false";
  button.disabled = running || locked;
}

function setServiceStatus(text, ok) {
  els.serviceStatus.textContent = text;
  els.serviceStatus.classList.toggle("ok", ok);
}

function fillConfig(config) {
  const project = config?.project || {};
  renderModelSelectionControls(config);
  const values = {
    ...project,
    videoLength: project.videoLength || project.episodeDuration || "",
    dialogueLanguage: project.dialogueLanguage || project.language || ""
  };
  for (const field of els.configForm.elements) {
    if (field.name && Object.prototype.hasOwnProperty.call(values, field.name)) {
      field.value = values[field.name] || "";
    }
  }
  els.configForm.elements.projectStyles.value = JSON.stringify(projectStyleOptions(project));
  els.configForm.elements.activeStyleId.value = project.activeStyleId || inferActiveStyleId(project);
  els.projectScriptInput.value = project.logline || current.state?.storyScript?.synopsis || "";
  renderStyleCards();
  updateParamSelections();
  for (const key of ["llm", "image", "video"]) {
    const adapter = config?.adapters?.[key] || {};
    document.querySelectorAll(`[data-adapter="${key}"]`).forEach((field) => {
      if (field.name === "apiKey") {
        field.value = "";
        field.placeholder = adapter.hasApiKey ? "已保存，留空保留" : "留空则使用 mock";
      } else if (field.type === "checkbox") {
        field.checked = Boolean(adapter[field.name]);
      } else {
        field.value = adapter[field.name] || "";
      }
    });
  }
}

function readConfigForm() {
  const project = {};
  for (const field of els.configForm.elements) {
    if (field.name && !field.dataset.adapter) project[field.name] = field.value.trim();
  }
  project.logline = els.projectScriptInput.value.trim();
  project.episodeDuration = project.videoLength || "";
  project.language = project.dialogueLanguage || "";
  project.projectStyles = parseProjectStyles(project.projectStyles);
  project.activeStyleId = project.activeStyleId || inferActiveStyleId(project);

  const adapters = {};
  for (const key of ["llm", "image", "video"]) {
    adapters[key] = {};
    document.querySelectorAll(`[data-adapter="${key}"]`).forEach((field) => {
      adapters[key][field.name] = field.type === "checkbox" ? field.checked : field.value.trim();
    });
  }
  const modelSelection = {};
  document.querySelectorAll("[data-model-selection]").forEach((field) => {
    modelSelection[field.dataset.modelSelection] = field.value;
  });
  return { project, adapters, modelSelection };
}

function render() {
  const state = current.state || normalizeClientState({});
  const episode = getActiveEpisode();
  renderProjects();
  renderStyleCards();
  updateParamSelections();
  renderSidebar(state, episode);
  renderStatus(state, episode);
  renderProgress(state, episode);
  renderScript(state.storyScript, els.scriptOutput, "还没有结构化剧本。");
  renderEpisodeEditor(episode, state);
  renderShots(episode?.shots || [], episode?.promptPackages || []);
  renderCards(state.cards || {});
  renderVideos(episode?.promptPackages || [], episode?.shots || []);
  renderOutputSummary(state, episode);
  renderEvents(state.events || []);
  renderModelSelectors();
  if (current.mode === "studio") {
    setStudioMode(current.studioMode || "settings");
  }
  updateAvailability();
}

function renderModelSelectors() {
  const imageModel = modelDisplayName(selectedModelConfig("assetImageModel", "image") || current.config?.adapters?.image, "未设置");
  document.querySelectorAll("[data-selected-image-model]").forEach((node) => {
    node.textContent = imageModel;
  });
  const videoModel = modelDisplayName(selectedModelConfig("videoModel", "video") || current.config?.adapters?.video, "未设置");
  document.querySelectorAll("[data-selected-video-model]").forEach((node) => {
    node.textContent = videoModel;
  });
}

function modelDisplayName(adapter = {}, fallback = "未设置") {
  if (!adapter || adapter.provider === "mock") return adapter?.provider === "mock" ? "mock" : fallback;
  return adapter.name || adapter.model || adapter.provider || fallback;
}

function renderModelSelectionControls(config = current.config) {
  document.querySelectorAll("[data-model-selection]").forEach((field) => {
    const key = field.dataset.modelSelection;
    const options = modelSelectionOptions(config, key);
    const selected = config?.modelSelection?.[key] || options[0]?.value || "";
    field.innerHTML = options.map((option) => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`).join("");
    field.value = options.some((option) => option.value === selected) ? selected : options[0]?.value || "";
  });
}

function modelSelectionOptions(config = {}, key = "") {
  if (key === "videoProfile") {
    return (config.videoProfiles || []).map((profile) => ({
      value: profile.id,
      label: `${profile.name || profile.id}${profile.promptSchema ? ` · ${profile.promptSchema}` : ""}`
    }));
  }
  const type = {
    scriptLlm: "llm",
    episodeScriptLlm: "llm",
    shotLlm: "llm",
    assetExtractLlm: "llm",
    promptPackageLlm: "llm",
    assetImageModel: "image",
    storyboardImageModel: "image",
    videoModel: "video"
  }[key] || "llm";
  return (config.modelConfigs?.[type] || []).map((model) => ({
    value: model.id,
    label: modelDisplayName(model, model.id)
  }));
}

function selectedModelConfig(selectionKey, fallbackType = "llm") {
  const config = current.config || {};
  const id = config.modelSelection?.[selectionKey];
  const type = {
    scriptLlm: "llm",
    episodeScriptLlm: "llm",
    shotLlm: "llm",
    assetExtractLlm: "llm",
    promptPackageLlm: "llm",
    assetImageModel: "image",
    storyboardImageModel: "image",
    videoModel: "video"
  }[selectionKey] || fallbackType;
  return (config.modelConfigs?.[type] || []).find((model) => model.id === id) || (config.modelConfigs?.[type] || [])[0] || null;
}

function renderStyleCards() {
  if (!els.styleCards) return;
  const project = current.config?.project || {};
  const styles = projectStyleOptions({
    ...project,
    projectStyles: els.configForm?.elements.projectStyles?.value || project.projectStyles,
    activeStyleId: els.configForm?.elements.activeStyleId?.value || project.activeStyleId,
    visualStyle: els.configForm?.elements.visualStyle?.value || project.visualStyle
  });
  const selected = activeStyleId() || inferActiveStyleId({ ...project, projectStyles: styles, visualStyle: els.configForm?.elements.visualStyle?.value || project.visualStyle });
  els.styleCards.innerHTML = [
    `<button class="style-add-card" type="button" data-add-style="true">
      <div class="add-mark">＋</div>
      <strong>添加风格</strong>
      <small>上传参考图并填写提示词</small>
    </button>`,
    ...styles.map((style) => `
      <button class="style-ref-card ${style.id === selected ? "is-selected" : ""}" type="button" data-style-id="${escapeAttr(style.id)}">
        <span class="style-thumb">${style.imageUrl ? `<img src="${escapeAttr(style.imageUrl)}" alt="${escapeAttr(style.name)}">` : `<img src="${defaultStyleImage}" alt="">`}</span>
        <strong>${escapeHtml(style.name)}</strong>
        <small>${escapeHtml(style.prompt)}</small>
        <span class="style-actions">
          <span>${style.id === selected ? "已选" : "选择"}</span>
          <span>
            <span data-edit-style="${escapeAttr(style.id)}">编辑</span>
            <span data-delete-style="${escapeAttr(style.id)}">删除</span>
          </span>
        </span>
      </button>
    `)
  ].join("");
}

function updateParamSelections() {
  if (!els.configForm) return;
  document.querySelectorAll("[data-project-option]").forEach((button) => {
    const field = els.configForm.elements[button.dataset.projectOption];
    button.classList.toggle("is-selected", field?.value === button.dataset.value);
  });
}

function renderProjects() {
  const query = (els.projectSearchInput?.value || "").trim().toLowerCase();
  const projects = (current.projects || []).filter((project) => {
    return !query || (project.title || "").toLowerCase().includes(query);
  });
  els.projectGrid.innerHTML = [
    `<article class="project-card create-card" data-create-project="true">
      <div class="create-cover">
        <span>＋</span>
        <strong>创建新项目</strong>
      </div>
      <div class="project-card-body">
        <p>创建项目后，再进入剧本、属性、资产和多剧集制作。</p>
        <button class="primary">立即创建</button>
      </div>
    </article>`,
    ...projects.map((project) => `
      <article class="project-card" data-open-project="${escapeAttr(project.id)}">
        <div class="project-cover">
          ${project.coverUrl ? `<img src="${escapeAttr(project.coverUrl)}" alt="${escapeAttr(project.title)}">` : `<div class="default-cover"><span>AI</span></div>`}
        </div>
        <div class="project-card-body">
          <div class="project-card-title">
            <h3>${escapeHtml(displayProjectTitle(project))}</h3>
            <div class="card-action-row">
              <button class="mini-action" data-project-settings="${escapeAttr(project.id)}" aria-label="项目设置">设置</button>
              <button class="mini-action danger" data-delete-project="${escapeAttr(project.id)}" aria-label="删除项目">删除</button>
            </div>
          </div>
          <p>${escapeHtml(project.scriptText || "暂无剧本摘要")}</p>
          <div class="meta-line">
            <span class="tag">${escapeHtml(formatTime(project.updatedAt || project.createdAt))}</span>
            <span class="tag">${escapeHtml(project.stats?.episodes || 0)} 集</span>
            <span class="tag">${escapeHtml(project.stats?.assets || 0)} 资产</span>
            <span class="tag">${escapeHtml(project.stats?.shots || 0)} 分镜</span>
          </div>
        </div>
      </article>
    `)
  ].join("");
}

function renderSidebar(state, episode) {
  const project = current.config?.project || {};
  els.sidebarProjectTitle.textContent = project.title || "未命名项目";
  els.sidebarProjectMeta.textContent = `${project.aspectRatio || "9:16"} · ${project.videoLength || project.episodeDuration || "未设长度"} · ${languageName(project.dialogueLanguage || project.language)}`;
  els.activeEpisodeName.textContent = episode?.title || "未选择";
  const episodes = state.episodes || [];
  els.episodeList.innerHTML = episodes.length ? episodes.map((item) => `
    <button class="episode-tab ${item.id === state.activeEpisodeId ? "is-active" : ""}" data-open-episode="${escapeAttr(item.id)}">
      <span class="episode-tab-main">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${episodeStatusText(item)}</small>
      </span>
      <span class="episode-delete" data-delete-episode="${escapeAttr(item.id)}" aria-label="删除剧集">删除</span>
    </button>
  `).join("") : `<p class="empty mini-empty">${projectSetupComplete() ? "暂无剧集，点击上方添加剧集。" : "完善项目后可添加剧集。"}</p>`;
}

function renderStatus(state, episode) {
  const setupParts = [
    state.storyScript ? "剧本" : "",
    projectReady(false) ? "属性" : "",
    countCards(state.cards) ? "资产" : ""
  ].filter(Boolean);
  setText("statusProjectSetup", setupParts.length ? setupParts.join(" / ") : "待设置");
  setText("statusEpisodeScript", episode ? episodeScriptStatusLabel(episode.scriptStatus || episodeScriptStatusFromClient(episode)) : "待填写");
  setText("statusShots", episode?.shots?.length ? `${episode.shots.length} 镜` : "未生成");
  const videoCount = (episode?.videos || []).length;
  setText("statusVideos", videoCount ? `${videoCount} 段` : "待视频片段");
  setText("statusOutput", videoCount ? "待合成" : "待视频模型");
}

function renderProgress(state, episode) {
  const items = [
    ["项目剧本", Boolean(state.storyScript)],
    ["属性", projectReady(false)],
    ["资产", countCards(state.cards) > 0],
    ["分集", Boolean(episode?.script)],
    ["分镜", (episode?.shots || []).length > 0],
    ["提示词", (episode?.promptPackages || []).length > 0]
  ];
  els.progressStrip.innerHTML = items.map(([label, done]) => `
    <span class="${done ? "done" : ""}">${escapeHtml(label)}</span>
  `).join("");
}

function updateSettingsTabLocks() {
  const hasScript = projectScriptReady();
  const hasAttrs = projectAttributesReady();
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const tab = button.dataset.settingsTab;
    const locked = (tab === "project-attrs-block" && !hasScript) || (tab === "project-assets-block" && (!hasScript || !hasAttrs));
    button.disabled = locked;
    button.title = locked ? "请先完成前一步" : "";
  });
  if (els.toAttrsBtn) els.toAttrsBtn.disabled = isJobRunning("project:story:save") || relatedJobRunning("project:story:save") || !projectScriptInputReady();
  if (els.toAssetsBtn) els.toAssetsBtn.disabled = isJobRunning("project:config:save") || relatedJobRunning("project:config:save") || !projectAttributesInputReady();
  if (els.finishProjectSetupBtn) els.finishProjectSetupBtn.disabled = !projectSetupComplete();
}

function renderEpisodeEditor(episode, state) {
  if (!episode) {
    els.currentEpisodeTitle.textContent = "分集剧本";
    if (document.activeElement !== els.episodeScriptInput) {
      els.episodeScriptInput.value = "";
    }
    renderEpisodeScriptStatus(null);
    renderScript(null, els.episodeScriptOutput, "请先创建或选择剧集。");
  } else {
    els.currentEpisodeTitle.textContent = `${episode.title} 剧本`;
    if (document.activeElement !== els.episodeScriptInput) {
      els.episodeScriptInput.value = episode.brief || episode.synopsis || "";
    }
    renderEpisodeScriptStatus(episode);
    renderScript(episode.script, els.episodeScriptOutput, "本集结构化剧本尚未生成。请先填写故事意图，或直接点击“生成/完善剧本”自动续写。");
  }
  const project = current.config?.project || {};
  els.inheritedAttrs.innerHTML = [
    `风格：${project.visualStyle || "未设置"}`,
    `尺寸：${project.aspectRatio || "9:16"}`,
    `长度：${project.videoLength || project.episodeDuration || "未设置"}`,
    `字幕：${project.subtitles === "off" ? "无字幕" : "有字幕"}`,
    `对白：${languageName(project.dialogueLanguage || project.language)}`
  ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function renderEpisodeScriptStatus(episode) {
  if (!els.episodeScriptStatus) return;
  if (!episode) {
    els.episodeScriptStatus.innerHTML = "";
    return;
  }
  const key = episodeScriptJobKey(episode.id);
  const job = jobs.get(key);
  const running = job?.status === "running";
  const failed = job?.status === "error";
  const status = running ? "structuring" : failed ? "failed" : (episode.scriptStatus || episodeScriptStatusFromClient(episode));
  const tone = episodeScriptStatusTone(status);
  const sourceMode = episode.scriptSourceMode || (episode.brief ? "brief_guided" : "auto_continue");
  const selected = normalizeClientStringList(episode.selectedBeats);
  const deferred = normalizeClientStringList(episode.deferredBeats);
  const meta = [
    `<span class="status-pill ${escapeAttr(tone)}">${escapeHtml(episodeScriptStatusLabel(status))}</span>`,
    `<span class="tag">${escapeHtml(episodeScriptSourceModeLabel(sourceMode))}</span>`
  ];
  if (episode.scriptStructuredAt) meta.push(`<span class="tag">结构化：${escapeHtml(formatTime(episode.scriptStructuredAt))}</span>`);
  if (episode.briefUpdatedAt) meta.push(`<span class="tag">意图：${escapeHtml(formatTime(episode.briefUpdatedAt))}</span>`);
  els.episodeScriptStatus.innerHTML = `
    ${running ? `<div class="pending-panel is-live"><span class="spinner"></span><strong>${escapeHtml(job?.label || "AI 正在生成/完善本集剧本")}</strong><small>可继续浏览其他模块，完成后会自动刷新状态。</small></div>` : ""}
    ${failed ? `<small class="prompt-box error-box">${escapeHtml(job?.serverError || episode.scriptAdapterError || "生成/完善失败，请检查模型配置后重试。")}</small>` : ""}
    <div class="episode-status-row">${meta.join("")}</div>
    ${episode.capacityNote ? `<p class="episode-capacity-note">${escapeHtml(episode.capacityNote)}</p>` : ""}
    ${selected.length || deferred.length ? `
      <div class="episode-beat-grid">
        ${renderEpisodeBeatList("本集采用", selected)}
        ${renderEpisodeBeatList("顺延到后续", deferred)}
      </div>
    ` : ""}
    ${status === "stale" ? `<small class="warning-text">故事意图已修改，建议重新点击“生成/完善剧本”，否则后续分镜仍会基于旧结构化剧本。</small>` : ""}
  `;
}

function episodeScriptStatusFromClient(episode = {}) {
  if (episode.script) return "structured";
  if (episode.brief || episode.synopsis) return "brief_saved";
  return "empty";
}

function episodeScriptStatusLabel(status = "") {
  return {
    empty: "未填写意图",
    brief_saved: "意图已保存",
    stale: "需重新完善",
    structured: "已结构化",
    structuring: "生成中",
    failed: "生成失败"
  }[status] || "待处理";
}

function episodeScriptStatusTone(status = "") {
  return {
    structured: "ok",
    structuring: "pending",
    stale: "warning",
    failed: "danger",
    brief_saved: "pending"
  }[status] || "";
}

function episodeScriptSourceModeLabel(mode = "") {
  return {
    brief_guided: "按人工意图完善",
    auto_continue: "自动续写",
    manual: "手动剧本",
    local: "本地"
  }[mode] || "待生成";
}

function renderEpisodeBeatList(title, items = []) {
  if (!items.length) return "";
  return `
    <div class="episode-beat-list">
      <strong>${escapeHtml(title)}</strong>
      ${items.slice(0, 6).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>
  `;
}

function normalizeClientStringList(values = []) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function displayProjectTitle(project) {
  const title = project.title || "";
  return /[�鐢鍓圭洰]/.test(title) ? "未命名项目" : title || "未命名项目";
}

function renderScript(script, target, emptyText = "还没有剧本。") {
  if (!script) {
    target.className = "scene-list empty";
    target.textContent = emptyText;
    return;
  }
  target.className = "scene-list";
  target.innerHTML = [
    `<article class="scene-card">
      <h3>${escapeHtml(script.title)}</h3>
      <p>${escapeHtml(script.synopsis || script.logline || "")}</p>
      <div class="meta-line"><span class="tag">${escapeHtml(script.source || "local")}</span><span class="tag">${escapeHtml(formatTime(script.createdAt))}</span></div>
      ${script.adapterError ? `<small class="prompt-box error-box">${escapeHtml(script.adapterError)}</small>` : ""}
    </article>`,
    ...(script.scenes || []).map((scene) => `
      <article class="scene-card">
        <h3>${escapeHtml(scene.id)} ${escapeHtml(scene.title)}</h3>
        <div class="meta-line">
          <span class="tag">${escapeHtml(scene.location)}</span>
          <span class="tag">${escapeHtml(scene.timeOfDay)}</span>
          <span class="tag">${escapeHtml(scene.mood)}</span>
        </div>
        <p>${escapeHtml(scene.action)}</p>
        ${scene.narration ? `<p><strong>旁白：</strong>${escapeHtml(scene.narration)}</p>` : ""}
        <div class="dialogue">${(scene.dialogue || []).map((line) => `<div class="dialogue-row"><strong>${escapeHtml(line.speaker)}</strong><span>${escapeHtml(line.text)}</span></div>`).join("")}</div>
        ${scene.visualNotes ? `<small class="prompt-box">${escapeHtml(scene.visualNotes)}</small>` : ""}
      </article>
    `)
  ].join("");
}

function renderShots(shots, packages) {
  if (!shots.length) {
    els.shotsOutput.className = "shot-list empty";
    els.shotsOutput.textContent = "还没有 15s 分镜。";
    return;
  }
  const packageByShot = new Map((packages || []).map((pack) => [pack.shotId, pack]));
  const videosByShot = new Map(((getActiveEpisode()?.videos || [])).map((video) => [video.shotId, video]));
  const assetCatalog = clientAssetCatalog();
  els.shotsOutput.innerHTML = shots.map((shot) => {
    const pack = packageByShot.get(shot.id);
    const video = videosByShot.get(shot.id) || {};
    const assets = pack ? promptPackageReferenceAssets(pack) : inferShotAssets(shot, assetCatalog);
    const activeAssetTab = normalizeShotAssetTab(current.shotAssetTabs?.[shot.id] || "all");
    const visibleAssets = filterShotAssets(assets, activeAssetTab);
    const promptKey = promptJobKey(shot.id);
    const promptJob = jobs.get(promptKey);
    const promptRunning = promptJob?.status === "running";
    const promptError = promptJob?.status === "error" ? promptJob : null;
    const promptLocked = promptRunning || relatedJobRunning(promptKey);
    const assetsRunning = isJobRunning(packageAssetsJobKey(shot.id));
    return `
      <article class="shot-pipeline-row ${promptRunning || assetsRunning ? "is-generating" : ""}">
        <section class="shot-cell shot-script-cell">
          <span class="shot-ribbon">${escapeHtml(shot.id || "镜头")}</span>
          <div class="shot-cell-actions">
            <button type="button" aria-label="编辑分镜脚本" title="编辑分镜脚本" data-edit-shot="${escapeAttr(shot.id)}">✎</button>
          </div>
          ${renderShotScriptPreview(shot)}
        </section>
        <section class="shot-cell shot-asset-cell">
          ${assetsRunning ? `<div class="cell-loading"><span class="spinner"></span><strong>正在提取资产</strong></div>` : ""}
          <div class="shot-cell-tabs">
            ${renderShotAssetTabs(shot.id, activeAssetTab)}
          </div>
          ${renderShotAssetStrip(visibleAssets)}
          <button class="pipeline-action" type="button" data-generate-package-assets="${escapeAttr(shot.id)}" data-job-key="${escapeAttr(packageAssetsJobKey(shot.id))}" data-idle-text="提取资产" data-loading-text="提取中..." ${assetsRunning ? "disabled" : ""}>${assetsRunning ? "提取中..." : "提取资产"}</button>
        </section>
        <section class="shot-cell shot-prompt-cell">
          ${promptRunning ? `<div class="pending-panel is-live"><span class="spinner"></span><strong>Seedance 提示词生成中</strong><small>可继续浏览其他分镜</small></div>` : pack ? renderPromptSummary(pack, shot, assets) : promptError ? renderPromptError(promptError) : `<div class="pending-panel">待生成</div>`}
          <div class="prompt-action-row">
            ${pack ? `<button class="pipeline-action secondary-action" type="button" data-view-prompt="${escapeAttr(pack.id)}">查看提示词</button>` : ""}
            ${pack ? `<button class="pipeline-action secondary-action" type="button" data-export-prompt="${escapeAttr(pack.id)}">导出 JSON</button>` : ""}
            <button class="pipeline-action" type="button" data-generate-prompt="${escapeAttr(shot.id)}" data-job-key="${escapeAttr(promptKey)}" data-idle-text="${pack ? "重新生成" : "生成提示词"}" data-loading-text="生成中..." ${promptLocked ? "disabled" : ""}>${promptRunning ? "生成中..." : pack ? "重新生成" : "生成提示词"}</button>
          </div>
        </section>
        <section class="shot-cell shot-video-cell">
          ${renderShotVideoPanel(shot, pack, video)}
        </section>
      </article>
    `;
  }).join("");
}

function renderShotVideoPanel(shot = {}, pack = null, video = {}) {
  const shotId = shot.id || pack?.shotId || "";
  const jobKey = `video-clip:${shotId}`;
  const running = isJobRunning(jobKey);
  const promptStale = promptPackageIsStale(pack);
  const stale = videoIsStale(video, pack);
  const status = video.status || (video.taskId ? "submitted" : "not-started");
  const pending = video.taskId && !["completed", "failed", "cancelled"].includes(String(status).toLowerCase());
  const locked = !pack || promptStale || running || relatedJobRunning(jobKey);
  const buttonText = running ? "提交中..." : promptStale ? "先重新生成提示词" : stale ? "按新提示重新生成" : video.taskId ? "重新生成" : "生成视频";
  const panel = video.url
    ? `<video class="shot-video-preview" src="${escapeAttr(video.url)}" controls preload="metadata"></video>`
    : video.thumbnailUrl
      ? `<img class="shot-video-preview" src="${escapeAttr(video.thumbnailUrl)}" alt="${escapeAttr(shotId)}">`
      : `<div class="pending-panel ${pending || running ? "is-live" : ""}">${pending || running ? `<span class="spinner"></span><strong>${escapeHtml(videoStatusText(status))}</strong>` : pack ? "待生成" : "先生成提示词"}</div>`;
  return `
    ${panel}
    <div class="shot-video-meta">
      <span class="video-status ${escapeAttr(stale ? "stale" : videoStatusTone(status))}">${escapeHtml(stale ? "提示词已更新" : videoStatusText(status))}${!stale && video.progress != null ? ` ${escapeHtml(video.progress)}%` : ""}</span>
      ${promptStale ? `<small class="warning-text">分镜脚本已更新，请先重新生成 Seedance 提示词。</small>` : ""}
      ${stale ? `<small class="warning-text">当前视频早于最新提示词包，请重新生成视频。</small>` : ""}
      ${video.taskId ? `<small>${escapeHtml(video.taskId)}</small>` : ""}
      ${video.adapterError ? `<small class="error-box">${escapeHtml(video.adapterError)}</small>` : ""}
    </div>
    <div class="prompt-action-row">
      <button class="pipeline-action" type="button" data-generate-video-clip="${escapeAttr(shotId)}" data-job-key="${escapeAttr(jobKey)}" data-idle-text="${escapeAttr(buttonText)}" data-loading-text="提交中..." ${locked ? "disabled" : ""}>${escapeHtml(buttonText)}</button>
      ${pending ? `<button class="pipeline-action secondary-action" type="button" data-refresh-video-task>刷新</button>` : ""}
    </div>
  `;
}

function promptPackageIsStale(pack = {}) {
  return pack?.stale === true || Boolean(pack?.staleReason);
}

function videoIsStale(video = {}, pack = null) {
  if (!video?.id || !pack) return false;
  if (video.stale === true) return true;
  const packTime = Date.parse(pack.updatedAt || pack.manualEditedAt || pack.createdAt || "");
  const videoTime = Date.parse(video.createdAt || "");
  return Number.isFinite(packTime) && Number.isFinite(videoTime) && packTime > videoTime;
}

function renderCards(cards) {
  const type = normalizeAssetType(current.activeAssetTab);
  const assets = assetCardsByType(cards, type);
  const imageByAssetId = new Map((current.state?.assetImages || []).map((image) => [image.assetId, image.url]));
  els.cardsOutput.className = "asset-board";
  els.cardsOutput.innerHTML = [
    `<button class="asset-create-card" type="button" data-add-asset="${escapeAttr(type)}">
      <span>＋</span>
      <strong>新建</strong>
    </button>`,
    ...assets.map((asset) => {
      const imageUrl = imageByAssetId.get(asset.id) || "";
      const running = isJobRunning(assetJobKey(asset.id)) || isJobRunning(stageJobKey("images"));
      return `
        <article class="asset-thumb-card ${running ? "is-generating" : ""}" data-edit-asset="${escapeAttr(asset.id)}">
          <div class="asset-thumb ${imageUrl ? "" : "is-empty"}">
            ${running ? `<div class="thumb-loading"><span class="spinner"></span><strong>生成中</strong></div>` : imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(asset.name)}">` : `<span>暂无图片</span>`}
          </div>
          <div class="asset-thumb-body">
            <strong>${escapeHtml(asset.name || asset.id)}</strong>
            <small>${escapeHtml(asset.prompt || asset.description || "未填写提示词")}</small>
            <div class="card-action-row">
              <button class="mini-action" type="button" data-generate-asset="${escapeAttr(asset.id)}" data-job-key="${escapeAttr(assetJobKey(asset.id))}" data-idle-text="${imageUrl ? "重新生成" : "生成参考图"}" data-loading-text="生成中..." ${running ? "disabled" : ""}>${running ? "生成中..." : imageUrl ? "重新生成" : "生成参考图"}</button>
              <button class="mini-action danger" type="button" data-delete-asset="${escapeAttr(asset.id)}">删除</button>
            </div>
          </div>
        </article>
      `;
    })
  ].join("");
}

function formatShotScript(shot = {}) {
  return [
    `[${shot.durationSec || 15}s]`,
    shot.sceneId ? `场景 ${shot.sceneId}` : "",
    shot.shotType || "",
    shot.camera ? `运镜：${shot.camera}` : "",
    shot.action || "",
    shot.dialogue ? `台词：${shot.dialogue}` : "",
    shot.continuity ? `衔接：${shot.continuity}` : ""
  ].filter(Boolean).join("｜");
}

function renderShotScriptPreview(shot = {}) {
  const heading = [
    `[${shot.durationSec || 15}s]`,
    shot.sceneId ? `场景 ${shot.sceneId}` : "",
    shot.shotType || ""
  ].filter(Boolean).join(" ");
  return `
    <div class="shot-script-preview">
      <h3>${escapeHtml(heading || shot.id || "分镜")}</h3>
      ${shot.camera ? `<p><b>运镜</b>${escapeHtml(clipText(shot.camera, 92))}</p>` : ""}
      ${shot.action ? `<p><b>画面</b>${escapeHtml(clipText(shot.action, 118))}</p>` : ""}
      ${shot.dialogue ? `<p><b>台词</b>${escapeHtml(clipText(shot.dialogue, 72))}</p>` : ""}
      ${shot.continuity ? `<p><b>衔接</b>${escapeHtml(clipText(shot.continuity, 72))}</p>` : ""}
    </div>
  `;
}

function inferShotAssets(shot = {}, assets = []) {
  const refs = Array.isArray(shot.assetRefs) ? shot.assetRefs : [];
  const byRefs = refs.map((id) => findAssetForMention(id, assets)).filter(Boolean);
  const text = `${shot.action || ""} ${shot.dialogue || ""} ${shot.camera || ""} ${shot.assetNotes || ""} ${shot.visualNotes || ""}`.toLowerCase();
  const byText = assets.filter((asset) => {
    const name = String(asset.name || "").toLowerCase();
    const id = String(asset.id || "").toLowerCase();
    return (name && text.includes(name)) || (id && text.includes(id));
  });
  return uniqueAssets([...byRefs, ...byText]).slice(0, 8);
}

function renderShotAssetStrip(assets = []) {
  if (!assets.length) {
    return `
      <div class="shot-asset-empty">
        <div class="asset-cube"></div>
        <p>请用「生成提示词」匹配资产，或在资产中心手动添加后校验</p>
      </div>
    `;
  }
  return `
    <div class="shot-asset-strip">
      ${assets.map((asset) => `
        <button class="shot-asset-chip" type="button" data-shot-asset="${escapeAttr(asset.id)}" title="编辑${escapeAttr(asset.name || asset.id)}">
          <div class="shot-asset-thumb">
            ${asset.imageUrl ? `<img src="${escapeAttr(asset.imageUrl)}" alt="${escapeAttr(asset.name || asset.id)}">` : `<span>${escapeHtml((asset.name || asset.id || "?").slice(0, 2))}</span>`}
          </div>
          <strong>${escapeHtml(asset.name || asset.id)}</strong>
          <small>${escapeHtml(asset.type || "asset")}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderShotAssetTabs(shotId, activeType) {
  return [
    ["all", "全部"],
    ["character", "角色"],
    ["location", "场景"],
    ["prop", "道具"]
  ].map(([type, label]) => `
    <button class="${activeType === type ? "is-active" : ""}" type="button" data-shot-id="${escapeAttr(shotId)}" data-shot-asset-tab="${escapeAttr(type)}">${escapeHtml(label)}</button>
  `).join("");
}

function filterShotAssets(assets = [], type = "all") {
  const normalized = normalizeShotAssetTab(type);
  if (normalized === "all") return assets;
  return assets.filter((asset) => normalizeAssetType(asset.type) === normalized);
}

function normalizeShotAssetTab(type) {
  const normalized = String(type || "all").toLowerCase();
  if (["all", "全部"].includes(normalized)) return "all";
  return normalizeAssetType(normalized);
}

function renderPromptSummary(pack, shot, assets = []) {
  const refs = promptPackageReferenceAssets(pack);
  const stale = promptPackageIsStale(pack);
  const summary = [
    pack.soundDesign ? `音效：${pack.soundDesign}` : "",
    (pack.dialogue || []).length ? `台词：${pack.dialogue.map((row) => `${row.speakerAssetId || "角色"}：${row.text}`).join(" / ")}` : "",
    pack.seedancePrompt || buildSeedancePreview(shot, refs)
  ].filter(Boolean).join("\n");
  return `
    <div class="prompt-summary-card">
      <div class="prompt-summary-top">
        <span class="tag">${escapeHtml(pack.durationSec || 15)}s</span>
        <span class="tag">${escapeHtml(pack.source || "local")}</span>
        ${stale ? `<span class="tag warning-tag">分镜已更新</span>` : ""}
        <strong>${escapeHtml(pack.title || `${pack.shotId} 提示词`)}</strong>
      </div>
      ${stale ? `<small class="prompt-summary-warning">当前提示词早于最新分镜脚本，建议重新生成。</small>` : ""}
      <p>${escapeHtml(clipText(summary, 190))}</p>
      ${renderAssetMentions(refs)}
    </div>
  `;
}

function renderPromptError(job = {}) {
  const message = job.serverError || job.label || "生成失败";
  return `
    <div class="pending-panel is-error">
      <strong>提示词生成失败</strong>
      <small>${escapeHtml(message)}</small>
    </div>
  `;
}

function renderPromptTextBlock(text, rows = [], assets = []) {
  if (!rows.length) return `<p>${escapeHtml(text)}</p>`;
  const summaryRefs = uniqueAssets(rows.flatMap((row) => row.assetRefs || [])).map((asset) => asset.id);
  return `<p>${renderInlineAssetMentions(text, summaryRefs, assets)}</p>${rows.map((row) => `<p><b>${escapeHtml(row.timeRange || "")}</b> ${renderInlineAssetMentions(row.content || "", row.assetRefs || [], assets)}</p>`).join("")}`;
}

function renderPromptDialogueBlock(rows = [], assets = []) {
  if (!rows.length) return `<p>暂无台词。</p>`;
  return rows.map((row) => `
    <p><b>${escapeHtml(row.timeRange || "")}</b> ${renderAssetMention(findAssetForMention(row.speakerAssetId, assets))} ${escapeHtml(row.voice || "")}：${escapeHtml(row.text || "")}</p>
  `).join("");
}

function renderPromptDetail(pack, shot = {}) {
  const subShots = pack.subShots || [];
  const refs = promptEditorReferenceAssets(pack);
  return `
    <section class="prompt-detail-section">
      <div class="prompt-editor-meta">
        <div>
          <h3>${escapeHtml(pack.shotId || shot.id || "分镜")} ${escapeHtml(pack.title || "")}</h3>
          <p>${escapeHtml(shot.action || "")}</p>
        </div>
        <span class="prompt-ref-counter ${refs.length > maxPromptReferenceAssets ? "is-over" : ""}" data-prompt-ref-counter>参考对象 ${escapeHtml(refs.length)}/${escapeHtml(maxPromptReferenceAssets)}</span>
      </div>
      ${refs.length > maxPromptReferenceAssets ? `<p class="warning-text">视频生成最多使用 ${escapeHtml(maxPromptReferenceAssets)} 个参考图，请优先保留角色、场景和关键道具。</p>` : ""}
    </section>
    <section class="prompt-detail-section">
      <h3>分镜音效</h3>
      ${renderPromptEditRow({
        key: "soundDesign",
        label: "整体音效",
        value: pack.soundDesign || "",
        refs: uniqueAssetIds((pack.audio || []).flatMap((row) => row.assetRefs || [])),
        multiline: true
      })}
      ${(pack.audio || []).map((row, index) => renderPromptEditRow({
        key: `audio:${index}`,
        label: row.timeRange || "音效",
        value: row.content || "",
        refs: row.assetRefs || [],
        multiline: true
      })).join("") || `<p class="muted-text">暂无音效时间轴。</p>`}
    </section>
    <section class="prompt-detail-section">
      <h3>分镜台词</h3>
      ${(pack.dialogue || []).map((row, index) => `
        <div class="prompt-dialogue-editor">
          <strong>${escapeHtml(row.timeRange || "台词")}</strong>
          ${renderPromptEditRow({
            key: `dialogueVoice:${index}`,
            label: "声音",
            value: row.voice || "",
            refs: row.speakerAssetId ? [row.speakerAssetId] : []
          })}
          ${renderPromptEditRow({
            key: `dialogueText:${index}`,
            label: "文案",
            value: row.text || "",
            refs: row.speakerAssetId ? [row.speakerAssetId] : [],
            multiline: true
          })}
        </div>
      `).join("") || `<p class="muted-text">暂无台词。</p>`}
    </section>
    <section class="prompt-detail-section">
      <h3>分镜提示词</h3>
      <div class="subshot-tab-row">
        ${subShots.map((subShot, index) => `<button type="button" class="${index === 0 ? "is-active" : ""}" data-subshot-tab="${escapeAttr(subShot.id)}">${escapeHtml(`细分镜头${index + 1} (${subShot.timeRange || ""})`)}</button>`).join("")}
      </div>
      <div class="prompt-detail-list">
        ${subShots.map((subShot, index) => `
          <article class="${index === 0 ? "is-active" : ""}" data-subshot-panel="${escapeAttr(subShot.id)}">
            <strong>${escapeHtml(subShot.id)} · ${escapeHtml(subShot.timeRange)}</strong>
            ${renderPromptEditRow({ key: `subShot:${index}:cameraLanguage`, label: "镜头语言", value: subShot.cameraLanguage || "", refs: subShot.assetRefs || [], multiline: true })}
            ${renderPromptEditRow({ key: `subShot:${index}:blocking`, label: "站位", value: subShot.blocking || "", refs: subShot.assetRefs || [], multiline: true })}
            ${renderPromptEditRow({ key: `subShot:${index}:composition`, label: "构图运镜", value: subShot.composition || "", refs: subShot.assetRefs || [], multiline: true })}
            ${renderPromptEditRow({ key: `subShot:${index}:action`, label: "动作", value: subShot.action || "", refs: subShot.assetRefs || [], multiline: true })}
          </article>
        `).join("") || `<article><p>暂无细分镜头。</p></article>`}
      </div>
    </section>
    <section class="prompt-detail-section prompt-request-preview">
      <button type="button" data-toggle-request-preview>查看实际提交内容</button>
      <pre class="is-hidden" data-request-preview-panel>${escapeHtml(buildFinalSeedancePrompt(
        { ...pack, seedancePrompt: "" },
        shot,
        refs,
        pack.audio || [],
        pack.dialogue || [],
        (pack.subShots || []).map((subShot) => ({ ...subShot, seedanceText: buildSubShotSeedanceText(subShot, refs) }))
      ))}</pre>
    </section>
  `;
}

function promptEditorReferenceAssets(pack = {}) {
  const refs = [
    ...(pack.assetRefs || []),
    ...(pack.audio || []).flatMap((row) => row.assetRefs || []),
    ...(pack.dialogue || []).map((row) => row.speakerAssetId).filter(Boolean),
    ...(pack.subShots || []).flatMap((subShot) => subShot.assetRefs || [])
  ];
  return uniqueAssets(refs.map((id) => findClientAsset(id)).filter(Boolean));
}

function renderPromptEditRowLegacy({ key, label, value, refs = [], multiline = false }) {
  const uniqueRefs = uniqueAssetIds(refs).filter((id) => findClientAsset(id));
  const editorValue = encodePromptEditorText(value || "", uniqueRefs);
  return `
    <div class="prompt-edit-row">
      <label>
        <span>${escapeHtml(label)}</span>
        <textarea class="prompt-mention-editor ${multiline ? "is-multiline" : ""}" data-prompt-field="${escapeAttr(key)}" data-prompt-editor="true" rows="${multiline ? 3 : 1}" placeholder="输入 @ 可从项目资产库插入参考对象">${escapeHtml(editorValue)}</textarea>
      </label>
      <button type="button" class="prompt-mention-preview" data-prompt-mention-preview>${renderPromptMentionPreview(editorValue)}</button>
    </div>
  `;
}

function renderPromptEditRow({ key, label, value, refs = [], multiline = false }) {
  const uniqueRefs = promptEditor?.manualEdited ? [] : uniqueAssetIds(refs).filter((id) => findClientAsset(id));
  const editorValue = encodePromptEditorText(value || "", uniqueRefs);
  return `
    <div class="prompt-edit-row">
      <label>
        <span>${escapeHtml(label)}</span>
        <textarea class="prompt-mention-editor ${multiline ? "is-multiline" : ""}" data-prompt-field="${escapeAttr(key)}" data-prompt-editor="true" rows="${multiline ? 3 : 1}" placeholder="输入 @ 可从项目资产库插入参考对象">${escapeHtml(editorValue)}</textarea>
      </label>
      <button type="button" class="prompt-mention-preview" data-prompt-mention-preview>${renderPromptMentionPreview(editorValue)}</button>
    </div>
  `;
}

function encodePromptEditorText(text = "", refs = []) {
  const source = String(text || "");
  const assets = uniqueAssetIds(refs).map(findClientAsset).filter(Boolean);
  if (!assets.length || !source) return source;
  const matches = findPromptAssetTextMatches(source, assets);
  if (!matches.length) return `${source}${source.trim() ? " " : ""}${assets.map(promptMentionMarkup).join(" ")}`;
  const pieces = [];
  let cursor = 0;
  const used = new Set();
  matches.forEach((match) => {
    if (match.index < cursor) return;
    pieces.push(source.slice(cursor, match.index));
    pieces.push(promptMentionMarkup(match.asset));
    used.add(match.asset.id);
    cursor = match.index + match.length;
  });
  pieces.push(source.slice(cursor));
  const missing = assets.filter((asset) => !used.has(asset.id));
  if (missing.length) {
    pieces.push(`${pieces.join("").trim() ? " " : ""}${missing.map(promptMentionMarkup).join(" ")}`);
  }
  return pieces.join("");
}

function findPromptAssetTextMatches(text = "", assets = []) {
  const source = String(text || "");
  const searchSource = source.toLowerCase();
  const candidates = [];
  for (const asset of assets) {
    for (const term of promptAssetMentionTerms(asset, assets)) {
      const searchTerm = term.toLowerCase();
      let start = 0;
      while (searchTerm && start < searchSource.length) {
        const index = searchSource.indexOf(searchTerm, start);
        if (index < 0) break;
        candidates.push({ index, length: term.length, asset });
        start = index + term.length;
      }
    }
  }
  const accepted = [];
  candidates.sort((a, b) => a.index - b.index || b.length - a.length);
  for (const candidate of candidates) {
    if (accepted.some((item) => rangesOverlap(candidate.index, candidate.index + candidate.length, item.index, item.index + item.length))) continue;
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.index - b.index);
}

function promptAssetMentionTerms(asset = {}, scopedAssets = []) {
  const id = String(asset.id || "").trim();
  const name = String(asset.name || "").trim();
  const aliases = Array.isArray(asset.aliases) ? asset.aliases : [];
  const aliasTerms = aliases.map((alias) => String(alias || "").trim()).filter((term) => term.length >= 2 || uniqueShortAliasForAsset(term, asset, scopedAssets));
  const bareTerms = uniqueAssetIds([id, name, ...aliasTerms]).filter(Boolean);
  const mentionTerms = bareTerms.map((term) => `@${term}`);
  if (id && name && id !== name) {
    mentionTerms.push(`@${id} ${name}`, `@${id}${name}`);
  }
  return uniqueAssetIds([...mentionTerms, ...bareTerms]).sort((a, b) => b.length - a.length);
}

function promptMentionParseTerms(asset = {}, scopedAssets = []) {
  return promptAssetMentionTerms(asset, scopedAssets)
    .map((term) => term.replace(/^@/, ""))
    .filter(Boolean);
}

function uniqueShortAliasForAsset(alias = "", asset = {}, scopedAssets = []) {
  const value = String(alias || "").trim();
  if (value.length !== 1) return false;
  const sameAliasAssets = scopedAssets.filter((item) => (item.aliases || []).map((name) => String(name || "").trim()).includes(value));
  return sameAliasAssets.length === 1 && sameAliasAssets[0]?.id === asset.id;
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function uniqueAssetIds(ids = []) {
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

function renderAssetMentions(assets = []) {
  const unique = uniqueAssets(assets);
  if (!unique.length) return "";
  return `
    <div class="asset-mention-row">
      ${unique.map(renderAssetMention).join("")}
    </div>
  `;
}

function renderInlineAssetMentions(text = "", refs = [], assets = []) {
  const refAssets = uniqueAssets(refs.map((id) => findAssetForMention(id, assets)));
  if (!refAssets.length) return escapeHtml(text || "");
  return inlineAssetsIntoText(text || "", refAssets);
}

function renderAssetMention(asset = {}) {
  const label = asset.name && asset.name !== asset.id ? `${asset.id} ${asset.name}` : asset.id || "资产";
  const kind = assetTypeLabel(asset.type || "asset");
  return `
    <span class="asset-mention" title="${escapeAttr(label)}" data-type="${escapeAttr(kind)}">
      ${asset.imageUrl ? `<img src="${escapeAttr(asset.imageUrl)}" alt="${escapeAttr(label)}">` : `<span>${escapeHtml((asset.name || asset.id || "@").slice(0, 1))}</span>`}
      <b>${escapeHtml(kind)}</b>${escapeHtml(asset.name || asset.id || "资产")}
    </span>
  `;
}

function inlineAssetsIntoText(text, assets = []) {
  const pieces = [];
  let cursor = 0;
  const matches = [];
  const used = new Set();
  for (const asset of assets) {
    const terms = [asset.name, asset.id].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of terms) {
      const index = text.indexOf(term);
      if (index >= 0) {
        matches.push({ index, length: term.length, asset });
        used.add(asset.id);
        break;
      }
    }
  }
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  for (const match of matches) {
    if (match.index < cursor) continue;
    pieces.push(escapeHtml(text.slice(cursor, match.index)));
    pieces.push(renderAssetMention(match.asset));
    cursor = match.index + match.length;
  }
  pieces.push(escapeHtml(text.slice(cursor)));
  return pieces.join("");
}

function uniqueAssets(assets = []) {
  const map = new Map();
  for (const asset of assets) {
    if (!asset) continue;
    const item = typeof asset === "string" ? findAssetForMention(asset, []) : asset;
    if (item?.id && !map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

function findAssetForMention(id, assets = []) {
  return assets.find((asset) => asset.id === id) || findClientAsset(id) || { id, name: id, type: "asset", imageUrl: "" };
}

function buildSeedancePreview(shot = {}, assets = []) {
  return [
    `Seedance 2.0 video prompt, ${shot.durationSec || 15}s.`,
    `Shot: ${shot.action || ""}`,
    shot.camera ? `Camera: ${shot.camera}` : "",
    assets.length ? `Asset references: ${assets.map((asset) => `${asset.id || ""} ${asset.name || ""}${asset.imageUrl ? ` (${asset.imageUrl})` : ""}`.trim()).join("; ")}` : "",
    shot.dialogue ? `Dialogue: ${shot.dialogue}` : ""
  ].filter(Boolean).join("\n");
}

function clipText(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function renderVideos(packages, shots) {
  const episode = getActiveEpisode();
  const videos = episode?.videos || [];
  const videoByShot = new Map(videos.map((video) => [video.shotId, video]));
  const rows = packages.length ? packages.map((pack, index) => {
    const shot = shots.find((item) => item.id === pack.shotId) || shots[index] || {};
    const video = videoByShot.get(pack.shotId) || {};
    return renderVideoClipCard(pack, shot, video);
  }).join("") : "";
  els.videosOutput.className = "prompt-package-list";
  els.videosOutput.innerHTML = `
    <article class="prompt-package prompt-relocated">
      <div class="prompt-head">
        <div>
          <h3>${videos.length ? "视频片段待剪辑" : "等待视频片段生成"}</h3>
          <p>这里用于提交 Seedance 2.0 任务、刷新生成状态，并预览已返回的视频片段。分镜提示词仍在「分镜制作」里查看和导出。</p>
        </div>
        <div class="button-row">
          <button type="button" data-view="shot-making">查看分镜提示词</button>
          <button type="button" data-refresh-video-task ${videos.some((video) => video.taskId) ? "" : "disabled"}>刷新任务状态</button>
          <button class="primary" type="button" data-generate-video-clip="all" ${packages.length ? "" : "disabled"}>批量生成视频片段</button>
        </div>
      </div>
      <div class="output-summary">
        <span><strong>${videos.length}</strong> 个视频片段</span>
        <span><strong>${shots.length}</strong> 个分镜</span>
        <span><strong>${packages.length}</strong> 个提示词包已在分镜制作中</span>
      </div>
    </article>
    ${rows || `<p class="empty">请先在分镜制作中生成 Seedance 提示词包。</p>`}
  `;
}

function renderVideoClipCard(pack = {}, shot = {}, video = {}) {
  const status = video.status || (video.taskId ? "submitted" : "not-started");
  const promptStale = promptPackageIsStale(pack);
  const stale = videoIsStale(video, pack);
  const pending = video.taskId && !["completed", "failed", "cancelled"].includes(String(status).toLowerCase());
  const jobKey = `video-clip:${pack.shotId || shot.id || pack.id}`;
  const disabled = promptStale || isJobRunning(jobKey);
  const buttonText = isJobRunning(jobKey) ? "提交中..." : promptStale ? "先重新生成提示词" : stale ? "按新提示重新提交" : video.taskId ? "重新提交" : "生成此片段";
  const refs = video.referenceImages?.length ? video.referenceImages : (pack.assetReferences || []).map((asset) => ({
    id: asset.id,
    name: asset.name,
    type: asset.type,
    url: asset.imageUrl
  }));
  return `
    <article class="video-clip-card ${pending ? "is-pending" : ""}">
      <div class="video-clip-preview">
            ${video.url ? `<video src="${escapeAttr(video.url)}" controls preload="metadata"></video>` : video.thumbnailUrl ? `<img src="${escapeAttr(video.thumbnailUrl)}" alt="${escapeAttr(pack.shotId || shot.id || "video")}">` : `<div class="video-placeholder">${pending ? `<span class="spinner"></span><strong>生成中</strong>` : "未生成"}</div>`}
      </div>
      <div class="video-clip-body">
        <div class="video-clip-title">
          <div>
            <span class="tag">${escapeHtml(pack.shotId || shot.id || "")}</span>
            <h4>${escapeHtml(pack.title || shot.action || "视频片段")}</h4>
          </div>
          <span class="video-status ${escapeAttr(stale ? "stale" : videoStatusTone(status))}">${escapeHtml(stale ? "提示词已更新" : videoStatusText(status))}${!stale && video.progress != null ? ` ${escapeHtml(video.progress)}%` : ""}</span>
        </div>
        <p>${escapeHtml(clipText(video.prompt || pack.seedancePrompt || shot.action || "", 220))}</p>
        ${promptStale ? `<p class="warning-text">分镜脚本已更新，请先回到分镜制作重新生成 Seedance 提示词。</p>` : ""}
        ${stale ? `<p class="warning-text">当前视频早于最新提示词包，请重新生成视频。</p>` : ""}
        ${video.taskId ? `<small class="task-id">task_id: ${escapeHtml(video.taskId)}</small>` : ""}
        ${video.adapterError ? `<p class="error-box">${escapeHtml(video.adapterError)}</p>` : ""}
        ${refs.length ? `<div class="video-ref-strip">${refs.map((asset) => `<span>${asset.url ? `<img src="${escapeAttr(asset.url)}" alt="${escapeAttr(asset.name || asset.id)}">` : ""}<b>@${escapeHtml(asset.id || "")}</b>${escapeHtml(asset.name || "")}</span>`).join("")}</div>` : ""}
        <div class="button-row prompt-export-row">
          <button type="button" data-generate-video-clip="${escapeAttr(pack.shotId || shot.id || "")}" data-job-key="${escapeAttr(jobKey)}" data-idle-text="${escapeAttr(buttonText)}" data-loading-text="提交中..." ${disabled ? "disabled" : ""}>${escapeHtml(buttonText)}</button>
          ${pending ? `<button type="button" data-refresh-video-task>刷新状态</button>` : ""}
          <button type="button" data-copy-prompt="${escapeAttr(pack.id || "")}">复制提示词包</button>
        </div>
      </div>
    </article>
  `;
}

function videoStatusText(status = "") {
  const value = String(status || "").toLowerCase();
  return {
    "not-started": "未生成",
    submitted: "已提交",
    pending: "排队中",
    processing: "生成中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[value] || status || "未生成";
}

function videoStatusTone(status = "") {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "ready";
  if (value === "failed" || value === "cancelled") return "failed";
  if (["submitted", "pending", "processing"].includes(value)) return "pending";
  return "";
}

function renderPackageAssetReferences(references) {
  if (!references.length) return "";
  return `
    <section>
      <h4>资产图参考</h4>
      <div class="asset-ref-grid">
        ${references.map((asset) => `
          <div class="asset-ref-card">
            ${isJobRunning(assetJobKey(asset.id)) ? `<div class="asset-ref-missing is-live"><span class="spinner"></span><strong>生成中</strong></div>` : asset.imageUrl ? `<img src="${escapeAttr(asset.imageUrl)}" alt="${escapeAttr(asset.name || asset.id)}">` : `<div class="asset-ref-missing">未生成参考图</div>`}
            <p><b>${escapeHtml(asset.id)}</b> ${escapeHtml(asset.name || "")}</p>
            <small>${escapeHtml(asset.type || "asset")}</small>
            ${asset.imageUrl ? "" : `<button class="mini-action" data-generate-asset="${escapeAttr(asset.id)}" data-job-key="${escapeAttr(assetJobKey(asset.id))}" data-idle-text="生成这张" data-loading-text="生成中..." ${isJobRunning(assetJobKey(asset.id)) ? "disabled" : ""}>${isJobRunning(assetJobKey(asset.id)) ? "生成中..." : "生成这张"}</button>`}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderOutputSummary(state, episode) {
  els.outputSummary.innerHTML = `
    <span><strong>${(episode?.shots || []).length}</strong> 个当前剧集分镜</span>
    <span><strong>${(state.assetImages || []).filter((item) => item.url).length}</strong> 张项目资产图</span>
    <span><strong>${(episode?.promptPackages || []).length}</strong> 个提示词包</span>
    <span><strong>${(episode?.videos || []).length}</strong> 个视频任务/片段</span>
  `;
}

function renderTimedRows(title, rows) {
  if (!rows.length) return "";
  return `<section><h4>${escapeHtml(title)}</h4>${rows.map((row) => `<p><b>${escapeHtml(row.timeRange)}</b> ${escapeHtml(row.content)} ${renderAssetRefs(row.assetRefs || [])}</p>`).join("")}</section>`;
}

function renderDialogueRows(rows) {
  if (!rows.length) return "";
  return `<section><h4>分镜台词</h4>${rows.map((row) => `<p><b>${escapeHtml(row.timeRange)}</b> <span class="tag">${escapeHtml(row.speakerAssetId || "speaker")}</span> ${escapeHtml(row.voice || "")}：${escapeHtml(row.text)}</p>`).join("")}</section>`;
}

function renderAssetRefs(refs) {
  if (!refs.length) return "";
  return `<span class="asset-ref-line">${refs.map((ref) => `<span class="tag">${escapeHtml(ref)}</span>`).join("")}</span>`;
}

function renderEvents(events) {
  if (!events.length) {
    els.eventLog.innerHTML = `<p class="empty">还没有运行记录。</p>`;
    return;
  }
  els.eventLog.innerHTML = events.map((event) => `
    <div class="event-row">
      <time>${escapeHtml(formatTime(event.time))}</time>
      <strong>${escapeHtml(event.message)}${event.detail ? `<small class="event-detail">${escapeHtml(event.detail)}</small>` : ""}</strong>
      <small>${escapeHtml(event.source || event.type)}</small>
    </div>
  `).join("");
}

function normalizeClientState(raw = {}) {
  const storyScript = raw.storyScript || raw.script || null;
  let episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  const hasLegacyEpisodeData = Boolean(raw.script || (Array.isArray(raw.shots) && raw.shots.length) || (Array.isArray(raw.promptPackages) && raw.promptPackages.length) || (Array.isArray(raw.images) && raw.images.length) || (Array.isArray(raw.videos) && raw.videos.length));
  if (!episodes.length && hasLegacyEpisodeData) {
    episodes = [{
      id: "EP01",
      title: "第 1 集",
      order: 1,
      script: raw.script || storyScript,
      synopsis: raw.script?.synopsis || storyScript?.synopsis || "",
      shots: raw.shots || [],
      promptPackages: raw.promptPackages || [],
      images: raw.images || [],
      videos: raw.videos || []
    }];
  }
  episodes = episodes.map((episode, index) => normalizeClientEpisode(episode, index + 1));
  return {
    ...raw,
    storyScript,
    cards: raw.cards || { characters: [], locations: [], props: [] },
    assetImages: Array.isArray(raw.assetImages) ? raw.assetImages : [],
    assetImageHistory: raw.assetImageHistory && typeof raw.assetImageHistory === "object" ? raw.assetImageHistory : {},
    episodes,
    activeEpisodeId: raw.activeEpisodeId || episodes[0]?.id || null,
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    events: Array.isArray(raw.events) ? raw.events : []
  };
}

function normalizeClientEpisode(raw = {}, fallbackOrder = 1) {
  const script = raw.script || null;
  const brief = String(raw.brief ?? raw.synopsis ?? script?.synopsis ?? "").trim();
  return {
    ...raw,
    id: raw.id || `EP${String(fallbackOrder).padStart(2, "0")}`,
    title: raw.title || `第 ${fallbackOrder} 集`,
    order: Number(raw.order || fallbackOrder),
    script,
    brief,
    synopsis: String(raw.synopsis ?? script?.synopsis ?? brief ?? "").trim(),
    briefUpdatedAt: raw.briefUpdatedAt || raw.brief_updated_at || raw.updatedAt || raw.createdAt || "",
    scriptStatus: raw.scriptStatus || raw.script_status || episodeScriptStatusFromClient({ ...raw, brief, script }),
    selectedBeats: normalizeClientStringList(raw.selectedBeats || raw.selected_beats),
    deferredBeats: normalizeClientStringList(raw.deferredBeats || raw.deferred_beats),
    capacityNote: String(raw.capacityNote || raw.capacity_note || "").trim(),
    scriptSourceMode: String(raw.scriptSourceMode || raw.script_source_mode || (script ? "manual" : "")).trim(),
    scriptStructuredAt: raw.scriptStructuredAt || raw.script_structured_at || "",
    scriptAdapterError: String(raw.scriptAdapterError || raw.script_adapter_error || "").trim(),
    shots: Array.isArray(raw.shots) ? raw.shots : [],
    promptPackages: Array.isArray(raw.promptPackages) ? raw.promptPackages : [],
    images: Array.isArray(raw.images) ? raw.images : [],
    videos: Array.isArray(raw.videos) ? raw.videos : []
  };
}

function getActiveEpisode() {
  const state = current.state || {};
  return (state.episodes || []).find((episode) => episode.id === state.activeEpisodeId) || null;
}

function projectReady(requireScript = true) {
  return requireScript ? projectSetupComplete() : projectAttributesReady();
}

function projectScriptInputReady() {
  const project = current.config?.project || {};
  return Boolean((els.projectScriptInput?.value || project.logline || current.state?.storyScript?.synopsis || "").trim());
}

function projectScriptReady() {
  return Boolean(current.state?.storyScript);
}

function projectAttributesInputReady() {
  const project = readConfigForm().project;
  return Boolean(project.visualStyle && project.aspectRatio && (project.videoLength || project.episodeDuration) && project.subtitles && (project.dialogueLanguage || project.language));
}

function projectAttributesReady() {
  const project = current.config?.project || {};
  return Boolean(project.visualStyle && project.aspectRatio && (project.videoLength || project.episodeDuration) && project.subtitles && (project.dialogueLanguage || project.language));
}

function projectAssetsReady() {
  return countCards(current.state?.cards || {}) > 0;
}

function projectSetupComplete() {
  return projectScriptReady() && projectAttributesReady() && projectAssetsReady();
}

function nextProjectSetupTab() {
  if (!projectScriptReady()) return "project-script-block";
  if (!projectAttributesReady()) return "project-attrs-block";
  return "project-assets-block";
}

function missingProjectScript() {
  const project = current.config?.project || {};
  return !String(els.projectScriptInput?.value || project.logline || current.state?.storyScript?.synopsis || "").trim();
}

function episodeStatusText(episode) {
  if (episode.promptPackages?.length) return `${episode.promptPackages.length} 个提示词包`;
  if (episode.shots?.length) return `${episode.shots.length} 个分镜`;
  if (episode.script) return "剧本已填";
  return "待写分集剧本";
}

function countCards(cards = {}) {
  return (cards.characters?.length || 0) + (cards.locations?.length || 0) + (cards.props?.length || 0);
}

function normalizeAssetType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["character", "characters", "角色"].includes(normalized)) return "character";
  if (["location", "locations", "scene", "场景"].includes(normalized)) return "location";
  if (["prop", "props", "道具"].includes(normalized)) return "prop";
  return "prop";
}

function assetTypeLabel(type) {
  return {
    character: "角色",
    location: "场景",
    prop: "道具"
  }[normalizeAssetType(type)] || "资产";
}

function assetCardsByType(cards = {}, type = "prop") {
  return {
    character: cards.characters || [],
    location: cards.locations || [],
    prop: cards.props || []
  }[normalizeAssetType(type)] || [];
}

function clientAssetCatalog(cards = current.state?.cards || {}) {
  const imageByAssetId = new Map((current.state?.assetImages || []).map((image) => [image.assetId, image.url]));
  return [
    ...(cards.characters || []).map((card) => ({
      ...card,
      type: "character",
      description: [card.role, card.appearance, card.personality].filter(Boolean).join(" "),
      imageUrl: imageByAssetId.get(card.id) || ""
    })),
    ...(cards.locations || []).map((card) => ({
      ...card,
      type: "location",
      description: [card.atmosphere, card.layout].filter(Boolean).join(" "),
      imageUrl: imageByAssetId.get(card.id) || ""
    })),
    ...(cards.props || []).map((card) => ({
      ...card,
      type: "prop",
      description: [card.function, card.look].filter(Boolean).join(" "),
      imageUrl: imageByAssetId.get(card.id) || ""
    }))
  ];
}

function findClientAsset(id) {
  return clientAssetCatalog().find((asset) => asset.id === id) || null;
}

function assetUsageSummary(assetId) {
  const episodes = current.state?.episodes || [];
  const historyCount = (current.state?.assetImageHistory?.[assetId] || []).length;
  let shots = 0;
  let packages = 0;
  let videos = 0;
  for (const episode of episodes) {
    shots += (episode.shots || []).filter((shot) => (shot.assetRefs || []).includes(assetId)).length;
    packages += (episode.promptPackages || []).filter((pack) => promptPackageUsesAsset(pack, assetId)).length;
    videos += (episode.videos || []).filter((video) => videoUsesAsset(video, assetId)).length;
  }
  return { historyCount, shots, packages, videos };
}

function promptPackageUsesAsset(pack = {}, assetId = "") {
  return (pack.assetRefs || []).includes(assetId)
    || (pack.assetReferences || []).some((asset) => asset.id === assetId)
    || (pack.audio || []).some((row) => (row.assetRefs || []).includes(assetId))
    || (pack.dialogue || []).some((row) => row.speakerAssetId === assetId)
    || (pack.subShots || []).some((subShot) => (subShot.assetRefs || []).includes(assetId));
}

function videoUsesAsset(video = {}, assetId = "") {
  return (video.referenceImages || []).some((image) => image.id === assetId)
    || String(video.prompt || "").includes(assetId);
}

function projectStyleOptions(project = {}) {
  const parsed = parseProjectStyles(project.projectStyles);
  const styles = parsed.length ? parsed : [];
  if (project.visualStyle && !styles.some((style) => style.prompt === project.visualStyle)) {
    styles.unshift({
      id: "current-style",
      name: "当前风格",
      imageUrl: "",
      prompt: project.visualStyle
    });
  }
  return styles;
}

function currentProjectStyleOptions() {
  const project = current.config?.project || {};
  return projectStyleOptions({
    ...project,
    projectStyles: els.configForm?.elements.projectStyles?.value || project.projectStyles,
    activeStyleId: activeStyleId(),
    visualStyle: els.configForm?.elements.visualStyle?.value || project.visualStyle
  });
}

function parseProjectStyles(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeStyle).filter((style) => style.name && style.prompt);
  }
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(normalizeStyle).filter((style) => style.name && style.prompt) : [];
  } catch {
    return [];
  }
}

function normalizeStyle(style = {}) {
  const name = String(style.name || "").trim();
  const prompt = String(style.prompt || "").trim();
  return {
    id: String(style.id || styleIdFromName(name)).trim(),
    name,
    imageUrl: String(style.imageUrl || style.referenceImage || "").trim(),
    prompt
  };
}

function setProjectStyles(styles) {
  els.configForm.elements.projectStyles.value = JSON.stringify(styles.map(normalizeStyle));
}

function activeStyleId() {
  return els.configForm?.elements.activeStyleId?.value || current.config?.project?.activeStyleId || "";
}

function setActiveStyleId(styleId) {
  els.configForm.elements.activeStyleId.value = styleId || "";
}

function inferActiveStyleId(project = {}) {
  const styles = projectStyleOptions(project);
  const style = styles.find((item) => item.prompt === project.visualStyle) || styles[0];
  return style?.id || "";
}

function styleIdFromName(name) {
  const base = String(name || "style").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
  return `style-${base || Date.now()}`;
}

function uniqueStyleId(baseId, styles = []) {
  const used = new Set(styles.map((style) => style.id));
  if (!used.has(baseId)) return baseId;
  for (let index = 2; index < 1000; index += 1) {
    const id = `${baseId}-${index}`;
    if (!used.has(id)) return id;
  }
  return `${baseId}-${Date.now()}`;
}

function stageName(stage) {
  return {
    script: "项目剧本",
    shots: "15s 分镜",
    cards: "资产卡",
    images: "资产参考图重生成",
    videos: "分镜提示词",
    "video-clips": "视频片段"
  }[stage] || stage;
}

function sourceSuffix(data) {
  if (!data?.source) return "";
  return `：${data.source}`;
}

function languageName(value) {
  return {
    "zh-CN": "中文",
    en: "英文",
    ja: "日文"
  }[value] || value || "未设置";
}

function dialogueLanguageNameForPrompt(value) {
  return {
    "zh-CN": "Chinese",
    en: "English",
    ja: "Japanese"
  }[value] || value || "Chinese";
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

// Tagify mixed-mode editor overrides for inline asset chips in Seedance prompt fields.
function promptFieldRefs(field) {
  const source = promptTagifyFieldValue(field);
  return uniqueAssetIds([
    ...parsePromptTagifyMentions(source).map((item) => item.id),
    ...parsePromptMentions(decodePromptTagifyText(source)).map((item) => item.id)
  ]);
}

function promptFieldText(field) {
  if (!field) return "";
  return decodePromptMentionText(decodePromptTagifyText(promptTagifyFieldValue(field))).trim();
}

function promptTagifyFieldValue(field) {
  const entry = promptTagifyEntryForField(field);
  if (entry?.tagify) {
    entry.tagify.updateValueByDOMTags();
    entry.tagify.update({ withoutChangeEvent: true });
  }
  return String(field?.value || "");
}

function promptTagifyEntryForField(field) {
  if (!field) return null;
  return (promptEditor?.tagifyFields || []).find((entry) => entry.field === field) || null;
}

function syncPromptTagifyEditors() {
  (promptEditor?.tagifyFields || []).forEach(({ tagify }) => {
    tagify.updateValueByDOMTags();
    tagify.update({ withoutChangeEvent: true });
  });
}

function attachPromptMentionEditors() {
  if (!promptEditor) return;
  const fields = [...els.promptDetailBody.querySelectorAll("[data-prompt-editor]")];
  promptEditor.attachedFields = fields;
  if (typeof Tagify === "undefined") {
    toast("提示词 @ 标签编辑器未加载");
    return;
  }
  promptEditor.tagifyFields = fields.map((field) => {
    const tagify = new Tagify(field, {
      mode: "mix",
      pattern: /@/,
      tagTextProp: "name",
      enforceWhitelist: true,
      duplicates: true,
      whitelist: promptMentionValues(),
      dropdown: {
        enabled: 0,
        position: "text",
        highlightFirst: true,
        maxItems: 20,
        classname: "prompt-tagify-dropdown",
        searchKeys: ["value", "name", "id", "aliasesText"]
      },
      templates: {
        tag: tagifyAssetTagTemplate,
        dropdownItem: tagifyAssetDropdownTemplate
      },
      transformTag(tagData) {
        const asset = findClientAsset(tagData.id || tagData.value) || tagData;
        tagData.id = asset.id || tagData.id || tagData.value;
        tagData.value = asset.id || tagData.value;
        tagData.name = asset.name || tagData.name || tagData.value;
        tagData.type = normalizeAssetType(asset.type || tagData.type);
        tagData.imageUrl = asset.imageUrl || tagData.imageUrl || "";
        tagData.aliasesText = Array.isArray(asset.aliases) ? asset.aliases.join(" ") : tagData.aliasesText || "";
      }
    });
    tagify.on("add", schedulePromptReferenceCounter);
    tagify.on("remove", schedulePromptReferenceCounter);
    tagify.on("input", schedulePromptReferenceCounter);
    tagify.on("change", schedulePromptReferenceCounter);
    return { field, tagify };
  });
  schedulePromptReferenceCounter();
}

function detachPromptMentionEditors() {
  (promptEditor?.tagifyFields || []).forEach(({ tagify }) => tagify.destroy());
}

function schedulePromptReferenceCounter() {
  window.setTimeout(updatePromptReferenceCounter, 120);
}

function promptMentionValues() {
  return (promptEditor?.assetCatalog || []).map((asset) => {
    const name = asset.name || asset.id;
    return {
      value: asset.id,
      id: asset.id,
      name,
      type: normalizeAssetType(asset.type),
      imageUrl: asset.imageUrl || "",
      aliasesText: uniqueAssetIds([...(asset.aliases || []), asset.id, name]).join(" ")
    };
  });
}

function tagifyAssetTagTemplate(tagData) {
  const asset = findClientAsset(tagData.id || tagData.value) || tagData;
  const typeLabel = assetTypeLabel(asset.type || tagData.type);
  const name = asset.name || tagData.name || tagData.value || "参考对象";
  const imageUrl = asset.imageUrl || tagData.imageUrl || "";
  return `
    <tag title="${escapeAttr(`${typeLabel} ${name}`)}" contenteditable="false" spellcheck="false" tabindex="-1" class="${this.settings.classNames.tag} prompt-asset-mix-chip" ${this.getAttributes(tagData)}>
      <div>
        ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(name)}">` : `<i>${escapeHtml(String(name).slice(0, 1))}</i>`}
        <b>${escapeHtml(typeLabel)}</b>
        <span class="${this.settings.classNames.tagText}">${escapeHtml(name)}</span>
      </div>
    </tag>
  `;
}

function tagifyAssetDropdownTemplate(tagData) {
  const typeLabel = assetTypeLabel(tagData.type);
  const name = tagData.name || tagData.value || "参考对象";
  return `
    <div ${this.getAttributes(tagData)} class="${this.settings.classNames.dropdownItem} prompt-tagify-option" tabindex="0" role="option">
      ${tagData.imageUrl ? `<img src="${escapeAttr(tagData.imageUrl)}" alt="${escapeAttr(name)}">` : `<i>${escapeHtml(String(name).slice(0, 1))}</i>`}
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(typeLabel)}</small>
    </div>
  `;
}

function parsePromptTagifyMentions(text = "") {
  return parsePromptTagifyFragments(text).flatMap((fragment) => fragment.items.map((item) => ({
    ...item,
    index: fragment.index,
    raw: fragment.raw,
    length: fragment.length
  })));
}

function parsePromptTagifyFragments(text = "") {
  const source = String(text || "");
  const fragments = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("[[", index)) {
      const end = source.indexOf("]]", index + 2);
      if (end >= 0) {
        const raw = source.slice(index, end + 2);
        const items = parsePromptTagifyDataItems(source.slice(index + 2, end));
        if (items.length) {
          fragments.push({ index, raw, length: raw.length, items });
          index = end + 2;
          continue;
        }
      }
    }
    if (source[index] === "[" || source[index] === "{") {
      const end = findPromptJsonFragmentEnd(source, index);
      if (end > index) {
        const raw = source.slice(index, end);
        const items = parsePromptTagifyDataItems(raw);
        if (items.length) {
          fragments.push({ index, raw, length: raw.length, items });
          index = end;
          continue;
        }
      }
    }
    index += 1;
  }
  return fragments;
}

function parsePromptTagifyData(value = "") {
  const source = String(value || "");
  try {
    const data = JSON.parse(source);
    return data && typeof data === "object" ? data : null;
  } catch {
    const unescaped = source.replace(/\\"/g, "\"");
    if (unescaped === source) return null;
    try {
      const data = JSON.parse(unescaped);
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  }
}

function parsePromptTagifyDataItems(value = "") {
  const data = parsePromptTagifyData(value);
  const rows = Array.isArray(data) ? data : [data];
  return rows.map(normalizePromptTagifyData).filter(Boolean);
}

function normalizePromptTagifyData(data = {}) {
  if (!data || typeof data !== "object") return null;
  const id = String(data.id || data.value || "").trim();
  if (!id) return null;
  const asset = findClientAsset(id);
  if (!asset && !data.name && !data.type && !data.imageUrl) return null;
  return {
    id,
    name: asset?.name || data.name || id,
    type: normalizeAssetType(asset?.type || data.type),
    imageUrl: asset?.imageUrl || data.imageUrl || ""
  };
}

function findPromptJsonFragmentEnd(source = "", start = 0) {
  const opener = source[start];
  if (opener !== "[" && opener !== "{") return -1;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char !== "]" && char !== "}") continue;
    const expected = char === "]" ? "[" : "{";
    if (stack.pop() !== expected) return -1;
    if (!stack.length) return index + 1;
  }
  return -1;
}

function decodePromptTagifyText(text = "") {
  const source = String(text || "");
  const fragments = parsePromptTagifyFragments(source);
  if (!fragments.length) return source;
  const pieces = [];
  let cursor = 0;
  fragments.forEach((fragment) => {
    if (fragment.index < cursor) return;
    pieces.push(source.slice(cursor, fragment.index));
    pieces.push(fragment.items.map((item) => `@${item.id} ${item.name}`).join(" "));
    cursor = fragment.index + fragment.length;
  });
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

function renderPromptEditRow({ key, label, value, refs = [], multiline = false }) {
  const uniqueRefs = uniqueAssetIds(refs).filter((id) => findClientAsset(id));
  const editorValue = encodePromptEditorText(value || "", uniqueRefs);
  return `
    <div class="prompt-edit-row">
      <label>
        <span>${escapeHtml(label)}</span>
        <textarea class="prompt-mention-editor ${multiline ? "is-multiline" : ""}" data-prompt-field="${escapeAttr(key)}" data-prompt-editor="true" rows="${multiline ? 3 : 1}" placeholder="输入 @ 可从项目资产库插入参考对象">${escapeHtml(encodePromptTagifyText(editorValue))}</textarea>
      </label>
    </div>
  `;
}

function encodePromptTagifyText(text = "") {
  const source = String(text || "");
  const mentions = parsePromptMentions(source);
  if (!mentions.length) return source;
  const pieces = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.index < cursor) continue;
    pieces.push(source.slice(cursor, mention.index));
    const asset = findClientAsset(mention.id) || { id: mention.id, name: mention.name, type: "prop", imageUrl: "" };
    pieces.push(`[[${JSON.stringify({
      value: asset.id,
      id: asset.id,
      name: asset.name || asset.id,
      type: normalizeAssetType(asset.type),
      imageUrl: asset.imageUrl || ""
    })}]]`);
    cursor = mention.index + mention.raw.length;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

// Final prompt draft editor implementation: current visible Tagify content is the source of truth.
function attachPromptMentionEditors() {
  if (!promptEditor) return;
  const fields = [...els.promptDetailBody.querySelectorAll("[data-prompt-editor]")];
  promptEditor.attachedFields = fields;
  promptEditor.tagifyFields = [];
  if (typeof Tagify === "undefined") {
    toast("提示词 @ 标签编辑器未加载");
    return;
  }
  fields.forEach((field) => {
    const tagify = new Tagify(field, {
      mode: "mix",
      pattern: /@/,
      tagTextProp: "name",
      enforceWhitelist: true,
      duplicates: true,
      whitelist: promptMentionValues(),
      dropdown: {
        enabled: 0,
        position: "text",
        highlightFirst: true,
        maxItems: 20,
        classname: "prompt-tagify-dropdown",
        searchKeys: ["value", "name", "id", "aliasesText"]
      },
      templates: {
        tag: tagifyAssetTagTemplate,
        dropdownItem: tagifyAssetDropdownTemplate
      },
      transformTag(tagData) {
        const asset = findClientAsset(tagData.id || tagData.value) || tagData;
        tagData.id = asset.id || tagData.id || tagData.value;
        tagData.value = asset.id || tagData.value;
        tagData.name = asset.name || tagData.name || tagData.value;
        tagData.type = normalizeAssetType(asset.type || tagData.type);
        tagData.imageUrl = asset.imageUrl || tagData.imageUrl || "";
        tagData.aliasesText = Array.isArray(asset.aliases) ? asset.aliases.join(" ") : tagData.aliasesText || "";
      }
    });
    tagify.on("add", schedulePromptReferenceCounter);
    tagify.on("remove", schedulePromptReferenceCounter);
    tagify.on("input", schedulePromptReferenceCounter);
    tagify.on("change", schedulePromptReferenceCounter);
    promptEditor.tagifyFields.push({ field, tagify });
  });
  updatePromptReferenceCounter();
}

function detachPromptMentionEditors() {
  (promptEditor?.tagifyFields || []).forEach(({ tagify }) => tagify.destroy());
  if (promptEditor) promptEditor.tagifyFields = [];
}

function renderPromptEditRow({ key, label, value, refs = [], multiline = false }) {
  const editorValue = promptEditorInitialValue(value || "", refs);
  return `
    <div class="prompt-edit-row">
      <label>
        <span>${escapeHtml(label)}</span>
        <textarea class="prompt-mention-editor ${multiline ? "is-multiline" : ""}" data-prompt-field="${escapeAttr(key)}" data-prompt-editor="true" rows="${multiline ? 3 : 1}" placeholder="输入 @ 可从项目资产库插入参考对象">${escapeHtml(encodePromptTagifyText(editorValue))}</textarea>
      </label>
    </div>
  `;
}

function promptEditorInitialValue(text = "", refs = []) {
  const source = decodePromptMentionText(decodePromptTagifyText(text || ""));
  if (!source.trim()) return "";
  const visibleMentions = parsePromptMentions(source);
  if (visibleMentions.length) return source;
  if (promptEditor?.manualEdited) return source;
  return insertPromptRefsIntoExistingText(source, refs);
}

function insertPromptRefsIntoExistingText(text = "", refs = []) {
  const source = String(text || "");
  const assets = uniqueAssetIds(refs).map(findClientAsset).filter(Boolean);
  if (!assets.length) return source;
  const matches = findPromptAssetTextMatches(source, assets);
  if (!matches.length) return source;
  const pieces = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    pieces.push(source.slice(cursor, match.index));
    pieces.push(promptMentionDisplay(match.asset));
    cursor = match.index + match.length;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

function promptFieldRefs(field) {
  return promptDraftField(field).refs;
}

function promptFieldText(field) {
  return promptDraftField(field).text;
}

function promptDraftField(field) {
  const raw = promptTagifyFieldValue(field);
  const text = decodePromptMentionText(decodePromptTagifyText(raw));
  const refs = [
    ...parsePromptTagifyMentions(raw).map((item) => item.id),
    ...parsePromptMentions(text).map((item) => item.id)
  ];
  return {
    refs: uniqueAssetIds(refs),
    text: text.trim()
  };
}

function promptTagifyFieldValue(field) {
  const entry = promptTagifyEntryForField(field);
  if (entry?.tagify) return promptTagifyValueFromDom(entry.tagify);
  return String(field?.value || "");
}

function promptTagifyValueFromDom(tagify) {
  const input = tagify?.DOM?.input;
  if (!input) return "";
  return promptTagifySerializeNode(input).trim();
}

function promptTagifySerializeNode(root) {
  const pieces = [];
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "BR") {
      pieces.push("\n");
      return;
    }
    if (node.matches?.(".tagify__tag")) {
      const data = node.__tagifyTagData || {};
      const id = data.id || data.value || "";
      const asset = findClientAsset(id) || data;
      if (id) {
        pieces.push(`[[${JSON.stringify({
          value: id,
          id,
          name: asset.name || data.name || id,
          type: normalizeAssetType(asset.type || data.type),
          imageUrl: asset.imageUrl || data.imageUrl || ""
        })}]]`);
      }
      return;
    }
    pieces.push(promptTagifySerializeNode(node));
  });
  return pieces.join("");
}

function syncPromptTagifyEditors() {
  (promptEditor?.tagifyFields || []).forEach(({ field, tagify }) => {
    const value = promptTagifyValueFromDom(tagify);
    field.value = value;
    if (tagify.DOM?.originalInput) tagify.DOM.originalInput.value = value;
  });
}

function encodePromptTagifyText(text = "") {
  const source = decodePromptTagifyText(text || "");
  const mentions = parsePromptMentions(source);
  if (!mentions.length) return source;
  const pieces = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.index < cursor) continue;
    pieces.push(source.slice(cursor, mention.index));
    const asset = findClientAsset(mention.id) || { id: mention.id, name: mention.name, type: "prop", imageUrl: "" };
    pieces.push(`[[${JSON.stringify({
      value: asset.id,
      id: asset.id,
      name: asset.name || asset.id,
      type: normalizeAssetType(asset.type),
      imageUrl: asset.imageUrl || ""
    })}]]`);
    cursor = mention.index + mention.raw.length;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}
