# Prompt Mention Editor Standard

This document records the accepted implementation standard for prompt fields that contain inline project assets, such as characters, locations, props, or future business objects.

## Scope

Use this pattern when a text field must support both human-readable writing and structured references:

- Seedance prompt package editing.
- Dialogue, sound, camera language, blocking, composition, and action fields that mention project assets.
- Future fields where users need to type natural text and insert objects with `@`.

Do not build this interaction with a custom `contenteditable` implementation unless the product requirement grows into rich document editing. For the current workbench, use Tagify mixed mode.

## User Experience Standard

The user edits human-readable text. Asset references appear inline as chips at the exact text position.

Example:

```text
@CHAR01 林舟 抱着 @PROP02 银色收银铃 跑向 @LOC01 异世界便利店
```

Interaction rules:

- Typing `@` opens the project asset dropdown.
- Dropdown items show thumbnail, asset name, and asset type.
- Selecting an asset inserts a chip at the cursor position.
- Chips are part of the sentence, not a detached reference list.
- Users can delete chips like deleting text.
- The same asset may appear multiple times in one field.
- The visible editor state is the source of truth for saving.

## Frontend Control

Use Tagify in mixed mode.

Required configuration:

```js
new Tagify(field, {
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
    searchKeys: ["value", "name", "id", "aliasesText"]
  }
});
```

Important notes:

- `duplicates: true` is required because one character or prop can be mentioned several times in the same prompt segment.
- `enforceWhitelist: true` keeps references tied to real project assets.
- `tagTextProp: "name"` keeps chips readable while still preserving the asset id internally.

## Save Contract

When saving a prompt package, the frontend must read the current visible Tagify DOM and rebuild:

- Clean text fields.
- `assetRefs` per field or segment.
- Package-level `assetRefs`.

Do not restore deleted assets from old saved refs. If the visible editor no longer contains a reference, the saved package should no longer include that reference.

For dialogue, if no speaker asset is present after editing, do not silently fall back to the old speaker asset. This keeps delete behavior predictable.

## Text Normalization

The editor must normalize historical or leaked internal values before rendering and before saving.

Supported dirty forms:

```text
[[{"value":"CHAR01","id":"CHAR01","name":"林舟"}]]
[{"value":"CHAR01","id":"CHAR01","name":"林舟"}]
[[{\"value\":\"CHAR01\",\"id\":\"CHAR01\",\"name\":\"林舟\"}]]
```

Expected normalized text:

```text
@CHAR01 林舟
```

Frontend responsibilities:

- Decode Tagify mixed-mode JSON before initializing the editor.
- Decode escaped Tagify JSON.
- Convert known asset ids or names into valid Tagify chips.
- Read the visible editor DOM when saving.

Backend responsibilities:

- Clean serialized Tagify fragments again before writing JSON state.
- Treat backend cleaning as a safety net, not the primary source of truth.

## Video Request Consistency

Seedance video generation should use the saved prompt package after normalization.

The request builder should use:

- Current prompt package text.
- Current package `assetRefs`.
- Current reference asset images.

It should not send the whole workbench JSON package directly to Seedance. It should build the model-facing prompt and reference image list from the saved package.

When prompt text or refs change, existing videos for the same shot should be marked stale so users know the generated video may no longer match the current prompt.

## Validation Checklist

Before accepting a prompt mention editor change:

- A user can add an asset with `@`.
- A user can delete a chip and save; the deleted asset does not come back after refresh.
- The same asset can appear multiple times in one field.
- No `[[{"value":...}]]`, `[{"value":...}]`, or `[[{\"value\":...}]]` text appears in the editor.
- Saving and reopening preserves the visible content.
- Exported prompt package matches the visible editor content.
- Video generation uses the saved refs, not stale refs.
- Existing video records are marked stale after prompt edits.

## Files In Current Implementation

- `public/app.js`: prompt detail modal, Tagify mixed-mode editor, prompt field serialization, dirty text normalization.
- `public/styles.css`: inline asset chip styling, dropdown styling, prompt edit layout.
- `public/index.html`: local Tagify assets.
- `public/vendor/tagify.min.js` and `public/vendor/tagify.css`: local zero-runtime-dependency vendor copy.
- `server.js`: prompt package save merge, backend dirty text cleanup, saved refs for Seedance request building.

## Known Pitfalls

- Tagify has an internal mixed-mode value format. Never show that raw value directly to users.
- Tagify defaults to rejecting duplicate tags. Prompt text needs repeated assets, so always enable `duplicates: true`.
- The project has legacy prompt editor functions. Confirm that changes are applied to the final active implementation.
- Browser cache can keep old `/app.js`; use a hard refresh when validating frontend behavior after a server restart.
