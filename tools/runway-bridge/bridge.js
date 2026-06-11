const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exec } = require("node:child_process");
const detectPort = require("detect-port");
const puppeteer = require("puppeteer-core");

const WORKBENCH_URL = normalizeBaseUrl(process.env.WORKBENCH_URL || "http://127.0.0.1:8800");
const RUNWAY_URL = "https://app.runwayml.com/";
const GENERATE_URL_KEYWORD = "ai-tools/generate";
const WORKER_ID = process.env.RUNWAY_BRIDGE_WORKER_ID || `runway-bridge-${os.hostname()}-${Date.now()}`;
const POLL_INTERVAL_MS = Number(process.env.RUNWAY_BRIDGE_POLL_MS || 15000);
const CLAIM_LIMIT = clampInt(process.env.RUNWAY_BRIDGE_LIMIT, 1, 2, 1);
const RUNWAY_MAX_ACTIVE_TASKS = clampInt(process.env.RUNWAY_MAX_ACTIVE_TASKS, 1, 2, 2);
const CHROME_PORT_DEFAULT = clampInt(process.env.RUNWAY_CHROME_PORT, 1024, 65535, 9222);
const PAGE_READY_TIMEOUT = clampInt(process.env.RUNWAY_PAGE_TIMEOUT_MS, 10000, 300000, 60000);
const ACTION_TIMEOUT = clampInt(process.env.RUNWAY_ACTION_TIMEOUT_MS, 5000, 180000, 30000);
const UPLOAD_TIMEOUT = clampInt(process.env.RUNWAY_UPLOAD_TIMEOUT_MS, 5000, 300000, 90000);
const STEP_TIMEOUT = clampInt(process.env.RUNWAY_STEP_TIMEOUT_MS, 10000, 600000, 180000);
const SUBMIT_RETRY_MS = clampInt(process.env.RUNWAY_SUBMIT_RETRY_MS, 1000, 120000, 60000);
const SUBMIT_CONFIRM_TIMEOUT_MS = clampInt(process.env.RUNWAY_SUBMIT_CONFIRM_TIMEOUT_MS, 5000, 120000, 45000);
const POST_SUBMIT_SETTLE_MS = clampInt(process.env.RUNWAY_POST_SUBMIT_SETTLE_MS, 0, 60000, 5000);
const QUEUE_RETRY_MS = clampInt(process.env.RUNWAY_QUEUE_RETRY_MS, 1000, 120000, 60000);
const CUSTOM_SWITCH_WAIT_MS = clampInt(process.env.RUNWAY_CUSTOM_SWITCH_WAIT_MS, 0, 60000, 10000);
const MAX_REFERENCE_IMAGES = clampInt(process.env.RUNWAY_MAX_REFERENCE_IMAGES, 1, 9, 6);
const PREPARE_FORM_ATTEMPTS = clampInt(process.env.RUNWAY_PREPARE_FORM_ATTEMPTS, 1, 5, 3);
const TASK_RETRY_LIMIT = clampInt(process.env.RUNWAY_TASK_RETRY_LIMIT, 0, 5, 1);
const RUNWAY_MODEL_LABEL = process.env.RUNWAY_MODEL_LABEL || "Seedance 2.0";
const TEMP_DIR = path.join(__dirname, "tmp");
const LOG_FILE = process.env.RUNWAY_BRIDGE_LOG_FILE || path.join(__dirname, "runway-bridge-runtime.log");
const PROTOCOL_VERSION = "runway-bridge-provider-submission-v3";

const state = {
  browser: null,
  chromeProcess: null,
  chromePort: CHROME_PORT_DEFAULT,
  page: null,
  customPanelInitialized: false,
  stopping: false
};

process.on("SIGINT", () => {
  state.stopping = true;
  log("warn", "Stopping Runway bridge...");
  cleanup().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  state.stopping = true;
  cleanup().finally(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
  log("error", `Uncaught exception: ${error?.stack || error?.message || error}`);
});

process.on("unhandledRejection", (error) => {
  log("error", `Unhandled rejection: ${error?.stack || error?.message || error}`);
});

process.on("exit", (code) => {
  log("info", `Runway bridge process exit: ${code}`);
});

main().catch(async (error) => {
  log("error", `Runway bridge exited: ${error.message || error}`);
  await cleanup();
  process.exit(1);
});

async function main() {
  log("info", `Workbench: ${WORKBENCH_URL}`);
  log("info", `Worker: ${WORKER_ID}, claim limit: ${CLAIM_LIMIT}, Runway active limit: ${RUNWAY_MAX_ACTIVE_TASKS}`);
  await ensureBrowser();
  await ensurePage();
  log("info", "Bridge is ready. Log into Runway in the opened Chrome window if needed.");

  while (!state.stopping) {
    try {
      const tasks = await claimTasks();
      if (!tasks.length) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      for (const task of tasks) {
        await runWorkbenchTask(task);
      }
    } catch (error) {
      log("error", `Polling loop error: ${error.message || error}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function runWorkbenchTask(task) {
  const taskId = task.taskId || task.id;
  const label = `${task.shotId || task.id || taskId}`;
  const submission = normalizeProviderSubmission(task);
  let submitEvidence = null;
  log("info", `Start task ${label} (${taskId})`);
  try {
    const preparedReferences = await prepareRunwayReferences(submission.references, taskId);
    await reportProgress(taskId, 5, "Runway bridge picked up the task");
    await runStep(taskId, "prepare Runway page", 8, async () => {
      log("info", "Runway prepare wrapper: prepare fresh form");
      await prepareFreshGenerationForm(state.page);
    });
    await runStep(taskId, "wait Runway concurrency", 12, async () => waitRunwayQueueAvailable(state.page));
    await runStep(taskId, "select model", 24, async () => selectModel(state.page, RUNWAY_MODEL_LABEL));
    await runStep(taskId, "upload references", 34, async () => uploadReferenceImages(state.page, preparedReferences));
    await runStep(taskId, "fill prompt", 48, async () => {
      await closeMediaSelector(state.page);
      await clearPolicyNotice(state.page);
      await fillPrompt(state.page, submission.prompt);
    });
    await runStep(taskId, "set aspect ratio", 56, async () => selectAspectRatio(state.page, submission.size));
    await runStep(taskId, "set resolution", 62, async () => selectResolution(state.page, submission.resolution));
    await runStep(taskId, "set duration", 68, async () => selectDuration(state.page, submission.duration));
    await runStep(taskId, "submit to Runway", 78, async () => {
      const activeBeforeSubmit = await waitRunwayQueueAvailable(state.page);
      await assertReferenceUploadCount(state.page, preparedReferences.length);
      submitEvidence = await submitVideo(state.page, activeBeforeSubmit);
    });
    await postTask(taskId, "submitted", {
      progress: 85,
      message: "Submitted to Runway. The workbench is waiting for external completion or manual result sync.",
      runwayTaskUrl: state.page.url(),
      raw: {
        providerSubmission: {
          schemaVersion: submission.schemaVersion,
          referenceCount: preparedReferences.length,
          size: submission.size,
          resolution: submission.resolution,
          duration: submission.duration,
          submitEvidence
        }
      }
    });
    await resetSettings(state.page).catch((error) => {
      log("warn", `Reset after submit failed: ${error.message || error}`);
    });
    log("info", `Task ${label} submitted to Runway`);
  } catch (error) {
    log("error", `Task ${label} failed: ${error.message || error}`);
    const action = shouldRetryTask(error, task) ? "retry" : "fail";
    await postTask(taskId, action, { error: publicRunwayError(error) }).catch((reportError) => {
      log("error", `Failed to report task failure: ${reportError.message || reportError}`);
    });
    await recoverRunwayPageAfterTask(state.page, action).catch((recoverError) => {
      log("warn", `Runway page recovery after ${action} failed: ${recoverError.message || recoverError}`);
    });
  }
}

function isRetryableSubmitError(error) {
  const message = error?.message || String(error);
  if (/usage policy|policy|violate|refunded|not allowed|blocked/i.test(message)) return false;
  return /Submit button stayed disabled|wait Runway concurrency failed|Video mode did not become selected|prompt editor|page reload timed out|generate URL|upload references|Reference image upload|empty reference slot|file input/i.test(message);
}

function shouldRetryTask(error, task = {}) {
  if (!isRetryableSubmitError(error)) return false;
  const attempts = Number(task.bridge?.attempts || 0);
  return attempts <= TASK_RETRY_LIMIT;
}

function publicRunwayError(error) {
  const message = error?.message || String(error);
  if (/usage policy|policy|violate|refunded/i.test(message)) {
    return "Runway rejected this prompt due to its usage policy. Please edit or regenerate this shot prompt, then submit it again.";
  }
  if (/Runway did not confirm a new generation/i.test(message)) {
    return "Runway did not confirm the Generate click. The Bridge treated this as a failed submission so the next queued task can continue.";
  }
  if (/upload references|Reference image upload|empty reference slot|file input/i.test(message)) {
    return "Runway reference upload failed. The Bridge reset the Runway page and will keep the queue moving.";
  }
  return message;
}

async function assertReferenceUploadCount(page, expectedCount) {
  if (!expectedCount) return;
  await installReferenceCounter(page);
  const actual = await page.evaluate(() => window.__runwayBridgeReferenceCount?.() || 0);
  if (actual < expectedCount) {
    throw new Error(`Runway reference slots incomplete: expected ${expectedCount}, got ${actual}`);
  }
}

async function runStep(taskId, label, progress, handler) {
  log("info", `${taskId}: ${label}`);
  await reportProgress(taskId, progress, label);
  try {
    await handler();
  } catch (error) {
    const diagnostics = await runwayDiagnostics(state.page).catch((diagError) => ({ error: diagError.message }));
    throw new Error(`${label} failed: ${error.message || error}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
}

async function ensureBrowser() {
  state.chromePort = await detectPort(CHROME_PORT_DEFAULT);
  const webSocketUrl = await existingWebSocketUrl(state.chromePort).catch(() => "");
  if (!webSocketUrl) {
    const chromePath = findChromePath();
    if (!chromePath) {
      throw new Error("Chrome was not found. Install Chrome or set RUNWAY_CHROME_PATH.");
    }
    const profileDir = process.env.RUNWAY_CHROME_PROFILE || path.join(os.tmpdir(), "ai-comic-workbench-runway-profile");
    const command = `"${chromePath}" --remote-debugging-port=${state.chromePort} --start-maximized --no-first-run --no-default-browser-check --disable-notifications --user-data-dir="${profileDir}" --new-tab "${RUNWAY_URL}"`;
    log("info", `Opening Chrome on debugging port ${state.chromePort}`);
    state.chromeProcess = exec(command);
    state.chromeProcess.on("exit", (code, signal) => {
      log("warn", `Chrome process exited: code=${code}, signal=${signal || "none"}`);
    });
    await waitForChrome(state.chromePort);
  }
  const wsUrl = await existingWebSocketUrl(state.chromePort);
  state.browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
}

async function ensurePage() {
  const pages = await state.browser.pages();
  state.page = pages.find((page) => page.url().startsWith(RUNWAY_URL)) || pages[0] || await state.browser.newPage();
  state.page.on("pageerror", (error) => log("error", `Runway page error: ${error.message || error}`));
  state.page.on("close", () => log("warn", "Runway page closed"));
  state.page.on("error", (error) => log("error", `Runway page crashed: ${error.message || error}`));
  state.page.on("framenavigated", (frame) => {
    if (frame === state.page.mainFrame()) log("info", `Runway navigation: ${frame.url()}`);
  });
  await ensureRunwayPageReady(state.page);
}

async function ensureRunwayPageReady(page, options = {}) {
  log("info", "Runway page ready: check url");
  if (options.freshSession && page.url()?.startsWith(RUNWAY_URL) && page.url().includes(GENERATE_URL_KEYWORD)) {
    await navigateToFreshGenerateSession(page, "fresh Runway session requested");
  }
  if (!page.url() || !page.url().startsWith(RUNWAY_URL)) {
    await page.goto(RUNWAY_URL, { waitUntil: "domcontentloaded", timeout: PAGE_READY_TIMEOUT });
  }
  log("info", "Runway page ready: bring to front");
  await withTimeout(() => page.bringToFront(), ACTION_TIMEOUT, "bringToFront timed out").catch((error) => {
    log("warn", `Runway page bringToFront skipped: ${error.message || error}`);
  });
  log("info", "Runway page ready: wait generate url");
  await waitForPagePredicate(page, (keyword) => window.location.href.includes(keyword), GENERATE_URL_KEYWORD, PAGE_READY_TIMEOUT, "Runway generate URL");
  await ensureCustomPanelSelected(page);
  await waitForGeneratorShell(page);
  await sleep(800);
  log("info", "Runway page ready: done");
}

async function waitForGeneratorShell(page) {
  await waitForPagePredicate(page, () => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const hasPrompt = Boolean(document.querySelector('div[aria-label="Prompt"]'));
    const hasGenerate = Array.from(document.querySelectorAll("button")).some((button) => {
      return visible(button) && /^Generate$/i.test(String(button.textContent || "").trim());
    });
    const labels = Array.from(document.querySelectorAll("label,[role='tab']")).filter(visible);
    const hasVideoMode = labels.some((label) => /^Video$/i.test(String(label.textContent || "").trim()));
    return hasPrompt || (hasGenerate && hasVideoMode);
  }, null, PAGE_READY_TIMEOUT, "Runway generator shell");
}

async function waitForPagePredicate(page, predicate, arg, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await withTimeout(() => page.evaluate(predicate, arg), Math.min(ACTION_TIMEOUT, 5000), `${label} check timed out`)) {
        return true;
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
    await sleep(500);
  }
  throw new Error(`${label} was not ready within ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${lastError}` : ""}`);
}

async function ensureCustomPanelSelected(page) {
  await page.waitForFunction(() => Boolean(document.querySelector('button[aria-label="Custom"]')), { timeout: PAGE_READY_TIMEOUT });
  const result = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Custom"]');
    if (!button) return "Custom button not found";
    button.click();
    return true;
  });
  if (result !== true) throw new Error(result);
  await sleep(CUSTOM_SWITCH_WAIT_MS);
  await page.waitForFunction(() => document.querySelectorAll('div[class^="generateImageContainer-"] header label').length >= 2, { timeout: PAGE_READY_TIMEOUT });
}

async function ensureVideoMode(page) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const result = await withTimeout(() => page.evaluate(() => {
      const visible = (item) => {
        const rect = item?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const tabs = Array.from(document.querySelectorAll('div[class^="generateImageContainer-"] header label, label, [role="tab"]')).filter(visible);
      const videoTab = tabs.find((item) => /^Video$/i.test(String(item.textContent || "").trim())) || tabs[1];
      if (!videoTab) return { ok: false, message: "Video tab not found", selected: false, count: tabs.length };
      const selected = videoTab.dataset.selected === "true"
        || videoTab.getAttribute("aria-selected") === "true"
        || videoTab.getAttribute("aria-checked") === "true";
      if (!selected) {
        videoTab.scrollIntoView({ block: "center", inline: "center" });
        videoTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true, selected, count: tabs.length };
    }), 5000, "Video mode check timed out").catch((error) => ({ ok: false, message: error.message || String(error), selected: false, count: 0 }));
    if (result.ok && result.selected) return;
    log("warn", `Video mode not ready, retry ${attempt}: ${result.message || "not selected"}`);
    await sleep(700);
  }
  throw new Error("Video mode did not become selected");
}

async function prepareFreshGenerationForm(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= PREPARE_FORM_ATTEMPTS; attempt += 1) {
    try {
      await ensureRunwayPageReady(page, { freshSession: attempt > 1 });
      await optionalPageStep("close media selector", () => closeMediaSelector(page));
      await optionalPageStep("reset settings", () => resetSettings(page));
      log("info", "Runway prepare: checking dirty form");
      const dirtyState = await withTimeout(() => generationFormState(page), ACTION_TIMEOUT, "Dirty form check timed out").catch(() => ({ dirty: false }));
      if (dirtyState.dirty) {
        log("warn", `Runway form is dirty before task (prompt=${dirtyState.promptLength || 0}, references=${dirtyState.referenceCount || 0}, policy=${Boolean(dirtyState.policyNotice)}); opening a fresh generation session`);
        await navigateToFreshGenerateSession(page, "dirty form before task");
        continue;
      }
      log("info", "Runway prepare: ensure video mode");
      await ensureVideoMode(page);
      log("info", "Runway prepare: wait prompt editor");
      await waitForPagePredicate(page, () => Boolean(document.querySelector('div[aria-label="Prompt"]')), null, ACTION_TIMEOUT, "Runway prompt editor");
      log("info", "Runway prepare: install reference counter");
      await installReferenceCounter(page);
      const finalState = await generationFormState(page).catch(() => ({ dirty: false, referenceCount: 0 }));
      if (finalState.policyNotice || finalState.referenceCount) {
        log("warn", `Runway form is still not clean (references=${finalState.referenceCount || 0}, policy=${Boolean(finalState.policyNotice)}); retrying with a fresh session`);
        await navigateToFreshGenerateSession(page, "unclean form after prepare");
        continue;
      }
      log("info", "Runway prepare: ready");
      return;
    } catch (error) {
      lastError = error;
      log("warn", `Runway prepare attempt ${attempt}/${PREPARE_FORM_ATTEMPTS} failed: ${error.message || error}`);
      if (attempt < PREPARE_FORM_ATTEMPTS) {
        await navigateToFreshGenerateSession(page, "prepare retry").catch((navError) => {
          log("warn", `Fresh session navigation failed during prepare retry: ${navError.message || navError}`);
        });
      }
    }
  }
  throw lastError || new Error("Runway form could not be prepared");
}

async function optionalPageStep(label, handler) {
  log("info", `Runway prepare: ${label}`);
  try {
    await withTimeout(handler, Math.min(ACTION_TIMEOUT, 5000), `${label} timed out`);
  } catch (error) {
    log("warn", `Runway prepare optional step skipped: ${label}: ${error.message || error}`);
  }
}

async function hasDirtyGenerationForm(page) {
  return generationFormState(page).then((state) => Boolean(state.dirty));
}

async function generationFormState(page) {
  await installReferenceCounter(page).catch(() => {});
  return page.evaluate(() => {
    const text = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
    const prompt = document.querySelector('div[aria-label="Prompt"]');
    const formText = text(prompt?.closest("form") || prompt?.parentElement || prompt);
    const pageText = text(document.body);
    const promptText = text(prompt);
    const referenceCount = window.__runwayBridgeReferenceCount?.() || 0;
    const policyNotice = /usage policy|credits refunded|violate/i.test(`${formText} ${pageText}`);
    return {
      dirty: Boolean(referenceCount || promptText || policyNotice),
      hasPrompt: Boolean(prompt),
      promptLength: promptText.length,
      referenceCount,
      policyNotice
    };
  });
}

async function navigateToFreshGenerateSession(page, reason = "") {
  const target = freshGenerateUrl(page.url());
  log("info", `Runway fresh session${reason ? ` (${reason})` : ""}: ${target}`);
  await withTimeout(() => page.goto(target, { waitUntil: "domcontentloaded", timeout: PAGE_READY_TIMEOUT }), PAGE_READY_TIMEOUT, "Runway fresh session navigation timed out").catch(async (error) => {
    log("warn", `Fresh generate navigation failed: ${error.message || error}; fallback to Runway home`);
    await page.goto(RUNWAY_URL, { waitUntil: "domcontentloaded", timeout: PAGE_READY_TIMEOUT });
  });
  await sleep(1200);
}

function freshGenerateUrl(value = "") {
  try {
    const parsed = new URL(String(value || RUNWAY_URL));
    if (!parsed.href.startsWith(RUNWAY_URL) || !parsed.href.includes(GENERATE_URL_KEYWORD)) return RUNWAY_URL;
    parsed.searchParams.delete("sessionId");
    if (!parsed.searchParams.has("mode")) parsed.searchParams.set("mode", "tools");
    return parsed.toString();
  } catch {
    return RUNWAY_URL;
  }
}

async function recoverRunwayPageAfterTask(page, action = "") {
  if (!page || page.isClosed?.()) return;
  await closeMediaSelector(page).catch(() => {});
  await clearPolicyNotice(page).catch(() => {});
  await navigateToFreshGenerateSession(page, `recover after ${action}`);
  await ensureRunwayPageReady(page).catch((error) => {
    log("warn", `Runway page not fully ready after recovery: ${error.message || error}`);
  });
}

async function selectModel(page, label) {
  const result = await page.evaluate(async (target) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const trigger = document.querySelector('button[aria-label="Video models"]');
    if (!trigger) return "Video models button not found";
    if ((trigger.textContent || "").trim() === target) return true;
    trigger.click();
    await wait(600);
    const option = document.querySelector('div[aria-label="Video models"][role="listbox"] div[data-testid="seedance-2"]')
      || Array.from(document.querySelectorAll('div[role="option"], div[data-testid]')).find((item) => (item.textContent || "").trim() === target);
    if (!option) return `${target} option not found`;
    option.click();
    return true;
  }, label);
  if (result !== true) throw new Error(result);
  await page.waitForFunction((target) => {
    const trigger = document.querySelector('button[aria-label="Video models"]');
    return (trigger?.textContent || "").trim() === target;
  }, { timeout: ACTION_TIMEOUT }, label);
}

async function uploadReferenceImages(page, references) {
  const items = references.filter((item) => item?.localPath).slice(0, MAX_REFERENCE_IMAGES);
  if (!items.length) return;
  await installReferenceCounter(page);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const filePath = item.uploadPath || item.localPath;
    if (!fs.existsSync(filePath)) throw new Error(`Reference image not found: ${filePath}`);
    const expectedCount = index + 1;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      log("info", `Upload reference ${expectedCount}/${items.length}, attempt ${attempt}: ${path.basename(filePath)}`);
      if (await hasReferenceSlotCount(page, expectedCount)) break;
      try {
        await uploadOneReferenceImage(page, filePath, index, item);
        break;
      } catch (error) {
        if (await hasReferenceSlotCount(page, expectedCount)) {
          log("warn", `Reference ${expectedCount} appears uploaded despite error: ${error.message || error}`);
          await dismissUploadPopup(page).catch(() => {});
          break;
        }
        if (attempt >= 2) throw error;
        log("warn", `Reference ${expectedCount} upload attempt ${attempt} failed, retry once: ${error.message || error}`);
        await dismissUploadPopup(page).catch(() => {});
        await sleep(1200);
      }
    }
  }
  await closeMediaSelector(page).catch(() => {});
}

async function installReferenceCounter(page) {
  await page.evaluate(() => {
    window.__runwayBridgeReferenceSnapshot = () => {
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const prompt = document.querySelector('div[aria-label="Prompt"]');
      const container = prompt?.closest('div[class^="textEditorContainer-"]') || prompt?.parentElement || prompt;
      if (!container) return { count: 0, labels: [] };
      const mediaSelector = document.querySelector('[data-testid="media-selector"]');
      const labels = new Set();
      for (const match of String(container.textContent || "").matchAll(/\bIMG_\d+\b/gi)) {
        labels.add(match[0].toUpperCase());
      }
      Array.from(container.querySelectorAll('button,[role="button"],img')).forEach((node) => {
        if (mediaSelector?.contains(node) || !visible(node)) return;
        const aria = String(node.getAttribute?.("aria-label") || "");
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
        const className = String(node.className || "");
        const label = aria || text;
        const viewMatch = label.match(/\b(?:View|Remove|Edit)\s+(IMG_\d+)\b/i);
        if (viewMatch) {
          labels.add(viewMatch[1].toUpperCase());
          return;
        }
        if ((node.tagName === "IMG" || node.querySelector?.("img")) && /slot/i.test(className) && !/empty/i.test(className)) {
          const index = labels.size + 1;
          labels.add(`IMG_${index}`);
        }
      });
      return { count: labels.size, labels: Array.from(labels) };
    };
    window.__runwayBridgeReferenceCount = () => {
      return window.__runwayBridgeReferenceSnapshot?.().count || 0;
    };
  });
}

async function uploadOneReferenceImage(page, filePath, index, reference = {}) {
  await dismissUploadPopup(page).catch(() => {});
  const expectedCount = index + 1;
  log("info", `Reference ${expectedCount}: click empty reference slot`);
  await withTimeout(() => clickAddImageReference(page), ACTION_TIMEOUT, `Reference ${expectedCount} click slot timed out`);
  log("info", `Reference ${expectedCount}: wait file input`);
  const input = await withTimeout(() => page.waitForSelector('div[data-testid="virtuoso-item-list"] input[type="file"], input[type="file"]', { timeout: ACTION_TIMEOUT }), ACTION_TIMEOUT, `Reference ${expectedCount} file input not found`);
  log("info", `Reference ${expectedCount}: upload file`);
  await withTimeout(() => input.uploadFile(filePath), UPLOAD_TIMEOUT, `Runway file input did not accept ${path.basename(filePath)} within ${Math.round(UPLOAD_TIMEOUT / 1000)}s`);
  log("info", `Reference ${expectedCount}: wait direct slot fill`);
  if (await waitForReferenceSlotCount(page, expectedCount, reference.label || filePath, Math.min(UPLOAD_TIMEOUT, 30000)).catch(() => false)) {
    await dismissUploadPopup(page).catch(() => {});
    await sleep(500);
    return;
  }
  await dismissUploadPopup(page).catch(() => {});
  if (await waitForReferenceSlotCount(page, expectedCount, reference.label || filePath, 5000).catch(() => false)) {
    await sleep(500);
    return;
  }
  log("info", `Reference ${expectedCount}: choose uploaded media`);
  await chooseUploadedMedia(page, reference, filePath);
  log("info", `Reference ${expectedCount}: wait chosen media slot fill`);
  await waitForReferenceSlotCount(page, expectedCount, reference.label || filePath, UPLOAD_TIMEOUT);
  await closeMediaSelector(page).catch(() => {});
  await sleep(800);
}

async function clickAddImageReference(page) {
  const findEmptySlot = async () => page.evaluate(() => {
    const visible = (item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const prompt = document.querySelector('div[aria-label="Prompt"]');
    const container = prompt?.closest('div[class^="textEditorContainer-"]') || prompt?.parentElement || document;
    const buttons = Array.from(container.querySelectorAll('button,[role="button"]')).filter((item) => {
      if (!visible(item)) return false;
      const text = String(item.textContent || "").replace(/\s+/g, " ").trim();
      const className = String(item.className || "");
      const aria = String(item.getAttribute("aria-label") || "");
      const hasImage = Boolean(item.querySelector("img"));
      if (hasImage || /^View\s+IMG_\d+\s+larger/i.test(aria)) return false;
      return text === "Reference" && !/references/i.test(aria);
    });
    const button = buttons[0];
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  });
  const slot = await withTimeout(findEmptySlot, 5000, "Runway empty reference slot lookup timed out");
  if (!slot) throw new Error("Runway empty reference slot not found");
  await page.mouse.click(slot.x, slot.y);
  await withTimeout(() => page.waitForSelector('[data-testid="media-selector"] input[type="file"], input[type="file"]', { timeout: ACTION_TIMEOUT }), ACTION_TIMEOUT, "Runway media selector file input not found");
}

async function chooseUploadedMedia(page, reference = {}, filePath = "") {
  const fileName = reference.uploadFileName || path.basename(filePath);
  const stem = path.basename(fileName, path.extname(fileName));
  const searchTerms = [fileName, stem, reference.id, reference.name]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  await page.waitForFunction(() => {
    const list = Array.from(document.querySelectorAll('[data-testid="media-selector"] [role="button"], [data-testid="virtuoso-item-list"] [role="button"], [data-testid="virtuoso-item-list"] div'));
    return list.some((item) => item.offsetParent !== null && (item.getAttribute("role") === "button" || item.querySelector("img,video,canvas")));
  }, { timeout: Math.min(UPLOAD_TIMEOUT, 20000) });
  const result = await page.evaluate((terms) => {
    const normalizedTerms = terms.map((term) => String(term || "").toLowerCase()).filter(Boolean);
    const visible = (item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('[data-testid="media-selector"] [role="button"], [data-testid="virtuoso-item-list"] [role="button"], [data-testid="virtuoso-item-list"] div'))
      .filter((item) => visible(item) && (item.getAttribute("role") === "button" || item.querySelector("img,video,canvas")));
    const scored = candidates.map((item, order) => {
      const text = String(item.textContent || item.getAttribute("aria-label") || item.getAttribute("title") || "").toLowerCase();
      const score = normalizedTerms.reduce((total, term) => total + (text.includes(term) ? term.length : 0), 0);
      return { item, order, score, text };
    });
    const exact = scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.order - b.order)[0];
    const fallback = scored[0];
    const target = exact?.item || fallback?.item;
    if (!target) return { ok: false, message: "Uploaded media selector has no selectable item" };
    target.scrollIntoView({ block: "center", inline: "center" });
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { ok: true, matched: Boolean(exact), text: exact?.text || fallback?.text || "" };
  }, searchTerms);
  if (!result.ok) throw new Error(result.message || `Uploaded media not found: ${fileName}`);
  if (!result.matched) {
    log("warn", `Uploaded media did not expose expected name (${fileName}); selected the first visible media item instead.`);
  }
}

async function waitForReferenceSlotCount(page, minCount, filePath, timeout = UPLOAD_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let snapshot = { count: 0, labels: [] };
  while (Date.now() < deadline) {
    snapshot = await referenceSnapshot(page);
    if (snapshot.count >= minCount) return true;
    await sleep(500);
  }
  await dismissUploadPopup(page).catch(() => {});
  throw new Error(`Reference image upload did not finish: ${filePath}; current references=${snapshot.count} ${snapshot.labels.join(",")}`);
}

async function hasReferenceSlotCount(page, minCount) {
  return referenceSnapshot(page).then((snapshot) => snapshot.count >= minCount).catch(() => false);
}

async function referenceSnapshot(page) {
  return page.evaluate(() => window.__runwayBridgeReferenceSnapshot?.() || { count: 0, labels: [] }).catch(() => ({ count: 0, labels: [] }));
}

async function dismissUploadPopup(page) {
  await page.keyboard.press("Escape");
  await sleep(300);
}

async function closeMediaSelector(page) {
  for (let round = 0; round < 6; round += 1) {
    const open = await page.evaluate(() => Boolean(document.querySelector('[data-testid="media-selector"]')));
    if (!open) return;
    await page.evaluate(() => {
      const selector = document.querySelector('[data-testid="media-selector"]');
      const buttons = Array.from(selector?.querySelectorAll("button,[role='button']") || []);
      const close = buttons.find((button) => {
        const label = String(button.textContent || button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
        return /^(close|done|apply|select|cancel)$/i.test(label) || /close|dismiss/i.test(label);
      });
      close?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }).catch(() => {});
    await page.keyboard.press("Escape");
    await sleep(500);
  }
  await page.evaluate(() => {
    const selector = document.querySelector('[data-testid="media-selector"]');
    selector?.remove();
  }).catch(() => {});
  await sleep(300);
}

async function clearPolicyNotice(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const button of buttons) {
      const label = String(button.textContent || button.getAttribute("aria-label") || "").trim().toLowerCase();
      if (["close", "dismiss", "ok", "got it"].includes(label) || label.includes("close")) {
        button.click();
      }
    }
  }).catch(() => {});
  await sleep(300);
}

async function fillPrompt(page, promptText) {
  const value = String(promptText || "").trim();
  if (!value) throw new Error("Prompt is empty");
  let result = await writePromptText(page, value);
  if (!result.ok || await hasBlockingPolicyNotice(page)) {
    await clearPolicyNotice(page);
    result = await writePromptText(page, buildFallbackPrompt(value));
  }
  if (!result.ok) throw new Error(result.message || "Prompt fill failed");
  if (await hasBlockingPolicyNotice(page)) {
    throw new Error("Runway policy notice appeared after filling prompt");
  }
  await assertPromptReadyForSubmit(page, result.textLength || value.length);
}

async function writePromptText(page, value) {
  const editor = await page.$('div[aria-label="Prompt"][contenteditable="true"], div[aria-label="Prompt"] [contenteditable="true"]');
  if (!editor) return { ok: false, message: "Prompt editor not found" };
  await editor.click({ delay: 20 });
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(150);

  const client = await page.target().createCDPSession();
  try {
    await client.send("Input.insertText", { text: String(value || "") });
  } finally {
    await client.detach().catch(() => {});
  }
  await sleep(600);

  let current = await promptEditorText(page);
  if (!current.trim()) {
    await editor.click({ delay: 20 });
    await page.keyboard.type(String(value || ""), { delay: 0 });
    await sleep(600);
    current = await promptEditorText(page);
  }
  return {
    ok: current.trim().length > 0,
    textLength: current.trim().length,
    value: current.slice(0, 500)
  };
}

async function promptEditorText(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('div[aria-label="Prompt"][contenteditable="true"], div[aria-label="Prompt"] [contenteditable="true"], div[aria-label="Prompt"]');
    return String(editor?.innerText || editor?.textContent || "");
  }).catch(() => "");
}

async function assertPromptReadyForSubmit(page, expectedLength = 0) {
  const deadline = Date.now() + ACTION_TIMEOUT;
  let last = {};
  while (Date.now() < deadline) {
    const [text, button] = await Promise.all([
      promptEditorText(page),
      waitForGenerateButtonState(page).catch((error) => ({ exists: false, error: error.message || String(error) }))
    ]);
    last = {
      textLength: text.trim().length,
      buttonText: button.text || "",
      disabled: Boolean(button.disabled),
      softDisabled: button.softDisabled || "",
      error: button.error || ""
    };
    const enoughText = text.trim().length >= Math.min(20, Math.max(1, Math.floor(Number(expectedLength || 0) * 0.2)));
    if (enoughText && button.exists && !button.disabled && button.softDisabled !== "true") return;
    if (await hasBlockingPolicyNotice(page)) {
      throw new Error("Runway rejected this prompt before submit: usage policy notice is visible");
    }
    await sleep(500);
  }
  throw new Error(`Runway did not enable Generate after prompt input; state=${JSON.stringify(last)}`);
}

async function hasBlockingPolicyNotice(page) {
  return page.evaluate(() => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const submit = Array.from(document.querySelectorAll("button")).find((button) => {
      const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
      return visible(button) && /^Generate$/i.test(text);
    });
    const submitUsable = Boolean(submit && !submit.disabled && submit.getAttribute("data-soft-disabled") !== "true");
    if (submitUsable) return false;
    const promptContainer = document.querySelector('div[aria-label="Prompt"]');
    const nearby = String(promptContainer?.closest("form")?.innerText || promptContainer?.parentElement?.innerText || "");
    return /usage policy|credits refunded|violate/i.test(nearby);
  }).catch(() => false);
}

function buildFallbackPrompt(promptText = "") {
  const refs = [...String(promptText || "").matchAll(/Image\s+(\d+)\s*=\s*@([A-Z]+[0-9]+)(?:\s*\(([^)]+)\))?/g)]
    .map((match) => `Image ${match[1]} = @${match[2]}${match[3] ? ` (${match[3]})` : ""}`);
  const subShots = String(promptText || "").split("\n")
    .filter((line) => /^\[\d/.test(line.trim()) || line.includes("@"))
    .slice(0, 8)
    .join("\n");
  const text = [
    "Create a continuous cinematic short video using the uploaded reference images.",
    refs.length ? refs.join("\n") : "Use all uploaded reference images in order.",
    "Keep the same character identity, scene layout, prop shape, scale, lighting, and materials from the matching reference image.",
    subShots || "Show a tense character action sequence in a dark blocky fantasy environment with clear camera movement and continuity.",
    "No text, no subtitles, no watermark."
  ].filter(Boolean).join("\n");
  return text.length > 3000 ? text.slice(0, 2970) + "\nNo text or watermark." : text;
}

async function selectAspectRatio(page, size) {
  const value = normalizeAspectRatio(size);
  await selectOptionByButton(page, {
    buttonSelector: 'button[aria-label="Aspect ratio"]',
    expectedText: value,
    optionDataKey: value,
    optionText: value
  });
}

async function selectResolution(page, resolution) {
  const value = normalizeResolution(resolution);
  await selectOptionByButton(page, {
    buttonSelector: 'button[aria-label="Resolution"]',
    expectedText: value,
    optionDataKey: value,
    optionText: value
  });
}

async function selectOptionByButton(page, config) {
  const current = await page.evaluate(({ buttonSelector }) => {
    const trigger = document.querySelector(buttonSelector);
    return trigger ? String(trigger.textContent || "").trim() : "";
  }, config);
  if (current === config.expectedText) return;
  const openResult = await page.evaluate(({ buttonSelector }) => {
    const trigger = document.querySelector(buttonSelector);
    if (!trigger) return `Selector button not found: ${buttonSelector}`;
    trigger.scrollIntoView({ block: "center", inline: "center" });
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, config);
  if (openResult !== true) throw new Error(openResult);
  await sleep(600);
  const result = await page.evaluate(({ expectedText, optionDataKey, optionText }) => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const exactKey = document.querySelector(`div[role="option"][data-key="${optionDataKey}"], [role="option"][data-key="${optionDataKey}"]`);
    const options = Array.from(document.querySelectorAll('[role="option"], label, button, [data-key]')).filter(visible);
    const option = (exactKey && visible(exactKey) ? exactKey : null)
      || options.find((item) => normalize(item.textContent || item.getAttribute("aria-label")) === optionText)
      || options.find((item) => normalize(item.textContent || item.getAttribute("aria-label")) === expectedText);
    if (!option) return `Option not found: ${expectedText}`;
    option.scrollIntoView({ block: "center", inline: "center" });
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, config);
  if (result !== true) throw new Error(result);
  await sleep(400);
  await page.waitForFunction((selector, text) => {
    const trigger = document.querySelector(selector);
    return (trigger?.textContent || "").trim() === text;
  }, { timeout: ACTION_TIMEOUT }, config.buttonSelector, config.expectedText);
}

async function selectDuration(page, duration) {
  const value = String(clampInt(duration, 5, 15, 15));
  const current = await getDurationState(page).catch(() => ({ buttonText: "", inputValue: "" }));
  if (current.buttonText.includes(`${value}s`) || current.inputValue === value) return;
  const openResult = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Duration"]');
    if (!button) return "Duration button not found";
    button.scrollIntoView({ block: "center", inline: "center" });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  });
  if (openResult !== true) throw new Error(openResult);
  await sleep(500);
  const result = await page.evaluate((target) => {
    const input = document.querySelector('div[class^="durationSliderContent-"] input[type="number"], input[type="number"]');
    if (!input) return "Duration input not found";
    input.focus();
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, target);
    } else {
      input.value = target;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    return true;
  }, value);
  if (result !== true) throw new Error(result);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(300);
  await page.keyboard.press("Escape").catch(() => {});
  await waitForDurationValue(page, value);
}

async function getDurationState(page) {
  return page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Duration"]');
    const input = document.querySelector('div[class^="durationSliderContent-"] input[type="number"], input[type="number"]');
    return {
      buttonText: String(button?.textContent || ""),
      inputValue: String(input?.value || "")
    };
  });
}

async function waitForDurationValue(page, value) {
  const deadline = Date.now() + ACTION_TIMEOUT;
  let lastState = {};
  while (Date.now() < deadline) {
    lastState = await getDurationState(page).catch((error) => ({ error: error.message || String(error) }));
    if (String(lastState.buttonText || "").includes(`${value}s`) || String(lastState.inputValue || "") === value) return;
    await sleep(500);
  }
  const diagnostics = await runwayDiagnostics(page).catch(() => ({}));
  throw new Error(`Duration did not update to ${value}s; state=${JSON.stringify(lastState)}; diagnostics=${JSON.stringify(diagnostics)}`);
}

async function submitVideo(page, activeBeforeSubmit = null) {
  const beforeCount = Number.isFinite(Number(activeBeforeSubmit))
    ? Number(activeBeforeSubmit)
    : await runwayActiveGenerationCount(page).catch(() => null);
  let round = 0;
  while (round < 10) {
    if (await hasBlockingPolicyNotice(page)) {
      throw new Error("Runway rejected this prompt before submit: usage policy notice is visible");
    }
    const state = await waitForGenerateButtonState(page);
    if (state.exists && !state.disabled && state.softDisabled !== "true") {
      log("info", `Submit button ready at ${Math.round(state.x)},${Math.round(state.y)}`);
      await clickGenerateButton(page, state);
      const evidence = await waitForSubmitAccepted(page, beforeCount);
      const afterClick = await waitForGenerateButtonState(page).catch(() => ({ exists: false, text: "" }));
      log("info", `Submit click result: button=${afterClick.text || "missing"}, disabled=${Boolean(afterClick.disabled)}, softDisabled=${afterClick.softDisabled || ""}, activeBefore=${beforeCount ?? "unknown"}, activeAfter=${evidence.activeAfter ?? "unknown"}, accepted=${evidence.accepted}`);
      if (!evidence.accepted) {
        const diagnostics = await runwayDiagnostics(page).catch(() => ({}));
        throw new Error(`Runway did not confirm a new generation after clicking Generate; evidence=${JSON.stringify(evidence)}; diagnostics=${JSON.stringify(diagnostics)}`);
      }
      if (POST_SUBMIT_SETTLE_MS > 0) {
        await sleep(POST_SUBMIT_SETTLE_MS);
      }
      return evidence;
    }
    round += 1;
    if (state.softDisabled === "true" && await hasBlockingPolicyNotice(page)) {
      throw new Error("Runway rejected this prompt before submit: Generate is soft-disabled by a usage policy notice");
    }
    log("warn", `Submit button disabled (${state.text || "empty"}), retry ${round}`);
    await sleep(SUBMIT_RETRY_MS);
  }
  throw new Error("Submit button stayed disabled for too long");
}

async function clickGenerateButton(page, buttonState = {}) {
  if (Number.isFinite(Number(buttonState.x)) && Number.isFinite(Number(buttonState.y))) {
    await page.mouse.click(buttonState.x, buttonState.y).catch((error) => {
      log("warn", `Mouse Generate click failed: ${error.message || error}`);
    });
    await sleep(800);
    if (await hasQuickSubmitSignal(page)) return;
  }
  const domClick = await page.evaluate(() => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const text = (item) => String(item?.textContent || "").replace(/\s+/g, " ").trim();
    const button = Array.from(document.querySelectorAll("button")).find((item) => visible(item) && /^Generate$/i.test(text(item)));
    if (!button) return { ok: false, message: "Generate button not found" };
    button.scrollIntoView({ block: "center", inline: "center" });
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    button.click();
    return { ok: true };
  }).catch((error) => ({ ok: false, message: error.message || String(error) }));
  if (!domClick.ok) {
    log("warn", `DOM Generate click failed: ${domClick.message || "unknown error"}`);
  }
  await sleep(500);
}

async function hasQuickSubmitSignal(page) {
  const [buttonState, indicators, activeCount] = await Promise.all([
    waitForGenerateButtonState(page).catch(() => ({ exists: false, disabled: false, softDisabled: "" })),
    runwaySubmitIndicators(page).catch(() => ({ busy: false, text: "" })),
    runwayActiveGenerationCount(page).catch(() => 0)
  ]);
  return Boolean(indicators.busy)
    || /Cancel generation|Stop generating|Generating|Queued|Processing/i.test(indicators.text || "")
    || (buttonState.exists && (buttonState.disabled || buttonState.softDisabled === "true"))
    || Number(activeCount || 0) > 0;
}

async function waitForSubmitAccepted(page, activeBeforeSubmit = null) {
  const deadline = Date.now() + SUBMIT_CONFIRM_TIMEOUT_MS;
  let last = { accepted: false, activeBefore: activeBeforeSubmit, activeAfter: null, generateButton: "" };
  while (Date.now() < deadline) {
    const [activeAfter, buttonState, indicators] = await Promise.all([
      runwayActiveGenerationCount(page).catch(() => null),
      waitForGenerateButtonState(page).catch(() => ({ exists: false, text: "", disabled: false, softDisabled: "" })),
      runwaySubmitIndicators(page).catch(() => ({ busy: false, text: "" }))
    ]);
    last = {
      accepted: false,
      activeBefore: activeBeforeSubmit,
      activeAfter,
      generateButton: buttonState.text || "",
      buttonDisabled: Boolean(buttonState.disabled),
      softDisabled: buttonState.softDisabled || "",
      busy: Boolean(indicators.busy),
      indicatorText: indicators.text || ""
    };
    if (/usage policy|credits refunded|violate/i.test(indicators.text || "")) {
      return { ...last, accepted: false, reason: "usage-policy-notice" };
    }
    if (buttonState.exists && (buttonState.disabled || buttonState.softDisabled === "true") && indicators.busy) {
      return { ...last, accepted: true, reason: "generate-button-busy" };
    }
    if (/Cancel generation|Stop generating|Generating|Queued|Processing/i.test(indicators.text || "")) {
      return { ...last, accepted: true, reason: "submit-indicator-busy" };
    }
    if (Number.isFinite(Number(activeBeforeSubmit)) && Number.isFinite(Number(activeAfter)) && Number(activeAfter) > Number(activeBeforeSubmit)) {
      return { ...last, accepted: true, reason: "active-count-increased" };
    }
    if (!Number.isFinite(Number(activeBeforeSubmit)) && Number.isFinite(Number(activeAfter)) && Number(activeAfter) > 0) {
      return { ...last, accepted: true, reason: "active-count-visible" };
    }
    await sleep(1000);
  }
  return last;
}

async function waitForGenerateButtonState(page) {
  await page.waitForFunction(() => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    return Array.from(document.querySelectorAll("button")).some((button) => visible(button) && /^Generate$/i.test(String(button.textContent || "").trim()));
  }, { timeout: ACTION_TIMEOUT });
  return page.evaluate(() => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const button = Array.from(document.querySelectorAll("button")).find((item) => {
      return visible(item) && /^Generate$/i.test(String(item.textContent || "").trim());
    });
    if (!button) return { exists: false, disabled: false, softDisabled: "", text: "", x: 0, y: 0 };
    const rect = button.getBoundingClientRect();
    return {
      exists: true,
      disabled: Boolean(button.disabled),
      softDisabled: button.getAttribute("data-soft-disabled") || "",
      text: String(button.textContent || "").replace(/\s+/g, " ").trim(),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  });
}

async function resetSettings(page) {
  const result = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Reset settings"]');
    if (!button) return "Reset settings button not found";
    button.click();
    return true;
  });
  if (result !== true) throw new Error(result);
  await sleep(1000);
}

async function waitRunwayQueueAvailable(page) {
  while (true) {
    const count = await runwayActiveGenerationCount(page);
    if (count < RUNWAY_MAX_ACTIVE_TASKS) return count;
    log("info", `Runway has ${count} active tasks; wait for concurrency slot`);
    await sleep(QUEUE_RETRY_MS);
  }
}

async function runwayActiveGenerationCount(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('div[data-testid="virtuoso-item-list"] div[data-index]'));
    return items.filter((item) => {
      const text = String(item.textContent || "");
      return /Generating|Queued|Processing/i.test(text)
        || Boolean(item.querySelector('span[class^="progressText"], svg[aria-label="loading animation"], [aria-label*="loading" i], [class*="progress" i], [class*="shimmer" i]'));
    }).length;
  });
}

async function runwaySubmitIndicators(page) {
  return page.evaluate(() => {
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const text = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll('div[data-testid="virtuoso-item-list"] div[data-index], [role="status"], [aria-live], button'))
      .filter(visible)
      .map(text)
      .filter(Boolean)
      .slice(0, 50);
    const joined = candidates.join(" | ");
    return {
      busy: /Generating|Queued|Processing|Cancel generation|Stop generating/i.test(joined),
      text: joined.slice(0, 800)
    };
  });
}

async function runwayDiagnostics(page) {
  return page.evaluate(() => {
    const text = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (item) => {
      const rect = item?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const submit = Array.from(document.querySelectorAll("button")).find((button) => visible(button) && /^Generate$/i.test(text(button)));
    const mediaItems = Array.from(document.querySelectorAll('[data-testid="media-selector"] [role="button"], [data-testid="virtuoso-item-list"] [role="button"]'));
    return {
      href: window.location.href,
      readyState: document.readyState,
      hasPrompt: Boolean(document.querySelector('div[aria-label="Prompt"]')),
      model: text(document.querySelector('button[aria-label="Video models"]')),
      hasSubmit: Boolean(submit),
      submitText: text(submit),
      references: window.__runwayBridgeReferenceCount?.() || 0,
      activeGenerations: Array.from(document.querySelectorAll('div[data-testid="virtuoso-item-list"] div[data-index]')).filter((item) => /Generating|Queued|Processing/i.test(text(item))).length,
      mediaSelectorOpen: Boolean(document.querySelector('[data-testid="media-selector"]')),
      mediaItems: mediaItems.length,
      mediaItemSamples: mediaItems.slice(0, 5).map((item) => text(item)).filter(Boolean)
    };
  });
}

function normalizeProviderSubmission(task = {}) {
  const providerSubmission = task.providerSubmission || {};
  const requestPayload = providerSubmission.requestPayload || task.requestPayload || {};
  const references = Array.isArray(providerSubmission.referenceImages) && providerSubmission.referenceImages.length
    ? providerSubmission.referenceImages
    : (task.referenceImages || []);
  return {
    schemaVersion: providerSubmission.schemaVersion || "legacy-runway-bridge-submission",
    prompt: String(providerSubmission.prompt || requestPayload.prompt || task.prompt || task.requestPayload?.prompt || "").trim(),
    size: providerSubmission.size || requestPayload.size || task.requestPayload?.size || "9:16",
    resolution: providerSubmission.resolution || requestPayload.resolution || task.requestPayload?.resolution || "720p",
    duration: providerSubmission.duration || requestPayload.duration || task.requestPayload?.duration || 15,
    references: references.map((image, index) => ({
      index: Number(image.index || index + 1),
      id: image.id || "",
      type: image.type || "",
      name: image.name || "",
      uploadFileName: image.uploadFileName || semanticUploadFileName(image, index),
      localPath: image.localPath || "",
      originalUrl: image.originalUrl || image.url || ""
    })).filter((image) => image.localPath).slice(0, MAX_REFERENCE_IMAGES)
  };
}

async function prepareRunwayReferences(references, taskId) {
  const items = (references || []).filter((image) => image.localPath).slice(0, MAX_REFERENCE_IMAGES);
  if (!items.length) return [];
  const taskDir = path.join(TEMP_DIR, safePathSegment(taskId || `task-${Date.now()}`));
  await fs.promises.mkdir(taskDir, { recursive: true });
  const prepared = [];
  for (const item of items) {
    const source = item.localPath;
    if (!fs.existsSync(source)) throw new Error(`Reference image not found: ${source}`);
    const uploadFileName = item.uploadFileName || semanticUploadFileName(item, item.index - 1);
    const uploadPath = path.join(taskDir, uploadFileName);
    await fs.promises.copyFile(source, uploadPath);
    prepared.push({
      ...item,
      uploadFileName,
      uploadPath,
      label: `Image ${item.index || prepared.length + 1} @${item.id || "asset"} ${item.name || ""}`.trim()
    });
  }
  return prepared;
}

function semanticUploadFileName(image = {}, index = 0) {
  const ext = path.extname(image.localPath || image.originalUrl || image.url || "").toLowerCase() || ".png";
  const id = safePathSegment(image.id || `REF${index + 1}`);
  const name = safePathSegment(uploadLabel(image, index));
  return `${String(index + 1).padStart(2, "0")}_${id}_${name}${ext}`;
}

function uploadLabel(image = {}, index = 0) {
  const type = String(image.type || "").toLowerCase();
  if (type === "character") return "character";
  if (type === "location") return "location";
  if (type === "prop") return "prop";
  return image.type || `asset-${index + 1}`;
}

function safePathSegment(value) {
  return String(value || "asset")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

async function claimTasks() {
  if (state.page) {
    const activeCount = await runwayActiveGenerationCount(state.page).catch(() => 0);
    const freeSlots = Math.min(CLAIM_LIMIT, Math.max(0, RUNWAY_MAX_ACTIVE_TASKS - activeCount));
    if (freeSlots <= 0) {
      log("info", `Runway has ${activeCount} active tasks; wait before claiming workbench tasks`);
      return [];
    }
    const data = await workbenchPost("/api/bridge/runway/tasks/claim", {
      workerId: WORKER_ID,
      limit: freeSlots,
      protocolVersion: PROTOCOL_VERSION
    });
    if (data.rejected) {
      log("warn", data.reason || "Runway bridge claim rejected by workbench");
    }
    return Array.isArray(data.tasks) ? data.tasks : [];
  }
  const data = await workbenchPost("/api/bridge/runway/tasks/claim", {
    workerId: WORKER_ID,
    limit: CLAIM_LIMIT,
    protocolVersion: PROTOCOL_VERSION
  });
  if (data.rejected) {
    log("warn", data.reason || "Runway bridge claim rejected by workbench");
  }
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function reportProgress(taskId, progress, message) {
  return postTask(taskId, "progress", { progress, message });
}

async function postTask(taskId, action, payload) {
  return workbenchPost(`/api/bridge/runway/tasks/${encodeURIComponent(taskId)}/${action}`, payload);
}

async function workbenchPost(pathname, payload) {
  const response = await fetch(`${WORKBENCH_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || text || `Workbench HTTP ${response.status}`);
  }
  return data;
}

async function existingWebSocketUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`Chrome debug port HTTP ${response.status}`);
  const data = await response.json();
  if (!data.webSocketDebuggerUrl) throw new Error("Chrome debug websocket not found");
  return data.webSocketDebuggerUrl;
}

async function waitForChrome(port) {
  const deadline = Date.now() + PAGE_READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      await existingWebSocketUrl(port);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Chrome did not open debugging port ${port}`);
}

function findChromePath() {
  if (process.env.RUNWAY_CHROME_PATH && fs.existsSync(process.env.RUNWAY_CHROME_PATH)) {
    return process.env.RUNWAY_CHROME_PATH;
  }
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : ""
    ];
    return candidates.find((item) => item && fs.existsSync(item)) || "";
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

async function cleanup() {
  try {
    await state.page?.close();
  } catch {}
  try {
    state.browser?.disconnect();
  } catch {}
  try {
    state.chromeProcess?.kill?.();
  } catch {}
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeAspectRatio(value) {
  const normalized = String(value || "").trim();
  return ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(normalized) ? normalized : "9:16";
}

function normalizeResolution(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["480p", "720p", "1080p"].includes(normalized) ? normalized : "720p";
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(handler, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || `Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    let promise;
    try {
      promise = typeof handler === "function" ? handler() : handler;
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function log(level, message) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const line = `${prefix} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
}
