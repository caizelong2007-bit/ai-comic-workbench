# Runway Bridge

Optional browser bridge for sending AI Comic Workbench video tasks to the Runway web UI.

This tool is an extension. It does not replace the existing APIMart Seedance API adapter. The workbench only uses this bridge when the selected video model provider is `runway-bridge`.

## What It Does

1. Polls the workbench for queued `runway-bridge` video tasks.
2. Claims one task at a time, while respecting the Runway page concurrency limit.
3. Opens Chrome with remote debugging enabled.
4. Uses Puppeteer to operate the Runway web page:
   - switch to Custom / Video
   - select Seedance 2.0
   - copy reference images to semantic temporary upload names
   - upload reference images from the workbench cache in the workbench order
   - fill the Runway-only derived prompt with an image-number / @asset map
   - set aspect ratio, resolution, and duration
   - submit generation
5. Reports progress, failure, or external submission back to the workbench.

The first version reliably submits tasks to Runway. Automatic video URL capture is intentionally left as a future enhancement because Runway page structure and result URLs may change often.

## Setup

Run from this folder:

```bat
npm install
npm start
```

Or double-click:

```bat
start-runway-bridge.bat
```

From the workspace root, you can also double-click:

```bat
start-workbench-runway.bat
```

This starts the normal workbench and a separate Runway Bridge worker window. Use this launcher when the selected video provider is `runway-bridge`.

The workbench should already be running, normally at:

```text
http://127.0.0.1:8800
```

If the workbench uses another address:

```bat
set WORKBENCH_URL=http://127.0.0.1:8801
npm start
```

## Login

The bridge opens Chrome and navigates to Runway. Log into Runway manually in that Chrome window when needed. The default Chrome profile is stored in the system temp directory so the login can persist between bridge runs.

Keep the bridge terminal open while tasks are being submitted. The workbench only creates local `runway-bridge` tasks; this script is the worker that claims those tasks and operates Runway. If the terminal is closed during a task, the workbench will eventually release or fail the claim rather than keeping the UI silently stuck.

Useful environment variables:

```text
WORKBENCH_URL=http://127.0.0.1:8800
RUNWAY_CHROME_PORT=9222
RUNWAY_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
RUNWAY_CHROME_PROFILE=C:\Users\123\AppData\Local\Temp\ai-comic-workbench-runway-profile
RUNWAY_BRIDGE_LIMIT=1
RUNWAY_MAX_ACTIVE_TASKS=2
RUNWAY_MAX_REFERENCE_IMAGES=6
RUNWAY_STEP_TIMEOUT_MS=180000
RUNWAY_UPLOAD_TIMEOUT_MS=90000
RUNWAY_MODEL_LABEL=Seedance 2.0
```

`RUNWAY_BRIDGE_LIMIT` controls how many queued workbench tasks the script claims in one polling round. Keep it at `1` so the bridge only operates one browser form at a time. `RUNWAY_MAX_ACTIVE_TASKS` controls how many active Runway generations may exist on the Runway page before the bridge pauses claiming new work.

`RUNWAY_STEP_TIMEOUT_MS` and `RUNWAY_UPLOAD_TIMEOUT_MS` prevent silent infinite loading. If Runway's web UI stops responding during a step or file upload, the bridge reports `failed` back to the workbench with diagnostics instead of leaving the task in `processing`.

Runtime logs are also written to:

```text
tools\runway-bridge\runway-bridge-runtime.log
```

## Prompt And Reference Mapping

The workbench keeps the canonical Seedance API prompt unchanged. For this browser bridge only, it also sends a `providerSubmission` package. The bridge uses that package to:

- rename temporary uploads like `01_CHAR01_Benson.png`
- upload images in the exact order shown in the prompt
- prepend a reference map so Runway can understand which image belongs to each `@asset`

Temporary upload files are stored under:

```text
tools\runway-bridge\tmp
```

They are ignored by Git and can be deleted at any time.

The bridge detects uploaded references from Runway's visible prompt chips such as `View IMG_1 larger` / `Remove IMG_1`. This is more reliable than counting plain image nodes because Runway's media selector and prompt editor use virtualized DOM elements.

Runway receives a compact browser-only prompt capped for the web UI. The canonical workbench Seedance prompt package and the direct APIMart request payload are not rewritten.

## Browser Automation Notes

- Reference upload is retried once and then validated against the visible `IMG_n` chips.
- Aspect ratio, resolution, and duration are set through the Runway UI before submission.
- Duration is written with synchronous DOM events and checked from outside the page context. This avoids Runway SPA promise collection issues seen with long in-page waits.
- Submission clicks the visible `Generate` button by coordinates after checking that it is not disabled.
- The bridge resets the Runway form after a successful submission so the next task starts from a clean prompt/reference state.

Verified smoke test:

```text
EP04-70726097 / SH04
5 reference images
16:9
480p
15s
status: runway-submitted
```

## Status Mapping

- `queued`: task created in the workbench and waiting for the bridge
- `processing`: bridge has claimed the task and is operating Runway
- `runway-submitted`: task was submitted to Runway; external result is not synced yet
- `completed`: bridge or another sync tool has written a final video URL or local video file
- `failed`: bridge failed and wrote an error back to the workbench

## Current Limitation

Runway web UI automation is not as stable as an API. This bridge is designed as a cost-saving extension, not as the canonical production path.

Current first-version limits:

- final video download / URL capture is not guaranteed
- selectors may need updates if Runway changes its UI
- the workbench direct APIMart Seedance flow remains the stable API path

## Remove This Extension

To stop using it:

1. In the workbench model settings, select the normal `apimart-seedance` video model instead of `runway-bridge`.
2. Stop the bridge terminal.
3. Delete this folder:

```text
tools/runway-bridge
```

Optional code cleanup if the extension is permanently removed:

- remove `runway-bridge` from the video provider select in `public/index.html`
- remove Runway Bridge routes and helper functions in `server.js`
- remove the `runway-submitted` status label in `public/app.js`

The existing API-key Seedance flow does not depend on this folder.
