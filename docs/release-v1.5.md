# v1.5 Release Notes

Released: 2026-06-03

## Updates

- Stabilized project cards on the project list so uploaded/generated covers no longer stretch the card layout.
- Project cover images now display fully with `object-fit: contain`, using a blurred background layer to fill empty space cleanly.
- Removed obsolete top-level workflow shortcuts:
  - Reset current pipeline
  - Generate current episode prompt package
  - Global refresh
  - Prompt-card level Export JSON
- Kept focused module-level actions, including prompt detail export, full prompt package export, video task refresh, and run log refresh.
- Improved frontend job failure notification behavior so stale server job errors no longer reappear as current-operation toasts.
- Asset image generation responses that fail through the adapter are no longer shown as successful local completions.

## Verification

- `node --check public/app.js`
- `node --check server.js`
- `git diff --check`

