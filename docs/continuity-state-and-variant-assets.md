# Continuity State And Variant Assets

## Background

Short drama generation is not only a linear flow of:

```text
script -> shots -> assets -> prompt package -> video
```

Many production problems come from missing continuity state:

```text
Benson has already put on armor.
The story is inside a large world, but this shot is at a small blacksmith shop.
The dragon egg is carried under Benson's left arm, not lying on the ground.
The blacksmith door was broken open in the previous shot.
The small dragon lizard is still cautious, not fully loyal yet.
```

If these states are not stored explicitly, every downstream model has to infer them again from text. That makes generation unstable: sometimes the result is correct, sometimes the character, scene, prop, or relationship drifts.

The recommended solution is a hybrid foundation:

```text
base asset + continuity state layer + variant asset
```

This is stronger than using only prompt text, and more controllable than generating a new asset for every temporary state.

## Core Principle

Use this rule across the whole pipeline:

```text
inherit by default, change only by explicit event
```

Examples:

- If Benson puts on armor, later shots inherit the armored state until the script says he removes it, changes outfit, or the armor is destroyed.
- If the camera enters the blacksmith shop, later continuous shots stay in that local space until the script exits or cuts elsewhere.
- If a door is broken open, the door remains broken.
- If a creature is cautious, it should not become fully loyal without a trust-building event.

The system should not ask the LLM to re-guess these states every time. The LLM may propose state changes, but the backend should store, inherit, validate, and expose them.

## Asset Types

### Base Asset

A stable identity asset.

Examples:

```text
CHAR01 Benson
LOC01 Three Kingdoms border world
PROP01 Purple dragon egg
```

Base assets answer:

```text
What is this thing's identity?
What does it look like in its default form?
How should it stay recognizable across the project?
```

### Variant Asset

A persistent alternate form of a base asset.

Examples:

```text
CHAR01-V01 Benson beginner armor form
CHAR01-V02 Benson injured armor form
LOC04-V01 Abandoned blacksmith shop after door is smashed
PROP01-V01 Purple dragon egg cracked state
```

Variant assets answer:

```text
What does the same entity look like after a lasting visual change?
Should this form be used for multiple shots or episodes?
```

Variant assets are especially useful for video generation because the video model understands a complete reference image better than separate objects that must be assembled by text.

### Temporary State

A short-lived condition that should not become a new reference asset by default.

Examples:

```text
Benson holding a sword
Benson looking scared
Benson crouching
Dragon egg glowing strongly
Dust in the air
Small dragon lizard looking cautious
```

Temporary states answer:

```text
What is happening in this shot?
How should the model describe the action, relation, pose, emotion, or prop position?
```

They should live in the continuity state layer and prompt package, not necessarily as new assets.

## When To Create A Variant

Create a variant asset when the visual change is persistent and important for identity.

Recommended create-variant cases:

- Costume or armor change.
- Transformation, upgrade, corruption, blackening, disguise.
- Major injury that lasts across multiple shots.
- Character age/form change.
- Vehicle or creature upgraded with a new skin or structure.
- Location damage or rearrangement that remains important.
- Prop state that changes recognizably and persists, such as cracked egg, powered core, opened box.

Do not create a variant for:

- One-off pose or action.
- Normal emotion.
- Short-lived lighting, smoke, rain, dust, or sparks.
- A prop held only briefly.
- A camera angle.
- A background crowd or temporary clutter.

Rule of thumb:

```text
If the state must remain visually consistent for multiple shots, consider a variant.
If it only describes the current action, keep it as shot state.
```

## Variant Generation Flow

For a persistent visual change, generate and approve a variant reference image.

Example: Benson wearing beginner armor.

```text
CHAR01 Benson base reference
+ PROP05 beginner armor reference
+ project style reference
+ variant generation prompt
-> CHAR01-V01 Benson beginner armor form reference sheet
-> user review
-> approved variant becomes the preferred character asset for later armored shots
```

Suggested variant record:

```json
{
  "id": "CHAR01-V01",
  "type": "character_variant",
  "name": "Benson beginner armor form",
  "parentAssetId": "CHAR01",
  "appliedAssetIds": ["PROP05"],
  "stateKey": "armored",
  "status": "approved",
  "prompt": "Benson wearing the beginner warrior armor set, preserving Benson's face, hair, square body proportions, novice identity, and project voxel style.",
  "imageUrl": "/cache/images/char01-v01.png",
  "createdFrom": {
    "baseAssetId": "CHAR01",
    "stateAssetIds": ["PROP05"],
    "sourceShotId": "SH02"
  }
}
```

The variant should preserve the base identity. It must not redesign the character unless the story explicitly requires transformation.

## Continuity State Layer

The continuity state layer connects:

```text
assets -> shots -> prompt packages -> video requests
```

It should store what is true at a given shot, not only what assets exist.

Suggested shot-level state:

```json
{
  "shotId": "SH02",
  "state": {
    "characters": [
      {
        "assetId": "CHAR01",
        "activeVariantId": "CHAR01-V01",
        "wearing": ["PROP05"],
        "holding": ["PROP06"],
        "carrying": [
          {
            "assetId": "PROP01",
            "position": "left arm"
          }
        ],
        "emotion": "cautious",
        "pose": "lowering sword tip",
        "injury": "",
        "trustState": {
          "CHAR04": "not yet trusted"
        }
      }
    ],
    "location": {
      "primaryAssetId": "LOC04",
      "parentAssetIds": ["LOC01"],
      "zone": "side rubble grass near the blacksmith shop",
      "damageState": "door already smashed open"
    },
    "props": [
      {
        "assetId": "PROP01",
        "ownerAssetId": "CHAR01",
        "position": "under left arm",
        "state": "intact, pulsing purple light"
      }
    ],
    "relations": [
      {
        "fromAssetId": "CHAR01",
        "toAssetId": "CHAR04",
        "type": "trust",
        "state": "building, cautious"
      }
    ],
    "continuity": {
      "fromPrevious": "Benson recovers after being pushed sideways.",
      "toNext": "The small dragon lizard hesitates near the food while battle noise grows."
    }
  }
}
```

## Common Continuity Problems To Handle

### Character State

Examples:

- Wearing armor, coat, school uniform, helmet, mask.
- Holding sword, carrying egg, wearing backpack.
- Injured, tired, wet, poisoned, stunned, tied up.
- Transformed, upgraded, corrupted, disguised.
- Emotional state: cautious, angry, afraid, trusting, suspicious.
- Position state: outside door, inside room, behind wall, on vehicle, at cave bottom.

Recommended handling:

- Persistent appearance changes become variant candidates.
- Temporary actions become shot state.
- The prompt generator should compile relationships into natural text:

```text
@Benson beginner armor form lowers @new sword while holding @purple dragon egg under his left arm.
```

Not:

```text
@Benson, @beginner armor, @new sword, @purple dragon egg appear.
```

### Scene Hierarchy

Examples:

```text
large world -> mine entrance -> blacksmith shop -> side rubble grass
city -> school -> classroom -> window corner
castle -> throne room -> broken staircase
```

Recommended handling:

- Store parent and primary location separately.
- Use the most specific current location as the primary reference.
- Parent/global locations provide geography and style, not default visual reference.
- A broad map asset should only be used for establishing shots, travel shots, or when no specific location exists.

### Scene State

Examples:

- Door opened or smashed.
- Roof collapsed.
- Furnace lit.
- Bridge broken.
- Room flooded.
- Trap already triggered.

Recommended handling:

- Persistent changes to a location may become a location variant.
- Temporary atmosphere remains state text.
- Prompt packages must mention important state changes when they affect the current image.

### Prop Ownership And Position

Examples:

- Dragon egg under Benson's left arm.
- Sword in right hand, lowered.
- Key inside backpack.
- Map on table.
- Phone screen cracked.

Recommended handling:

- Store owner, position, and state.
- Do not rely on assetRefs alone.
- The prompt generator must express ownership and position clearly.

### Relationship State

Examples:

- Creature is cautious, not loyal yet.
- Enemy has seen Benson.
- Boss is aware but not physically present.
- Two characters are separated.
- A character is pretending to cooperate.

Recommended handling:

- Store relationship type and current state.
- Relationship changes should be events.
- Do not let later shots skip trust-building or conflict transitions.

### Editing Continuity

Examples:

- Previous shot ends with a fall; next shot should start with recovery.
- Previous shot reveals purple light; next shot should show reaction before action.
- A montage skips time; the new state must be explained.

Recommended handling:

- Keep `entryBeat`, `mainBeat`, `exitBeat`, `cutRelation`, `ellipsis`.
- State layer should inherit the previous exit state unless a cut explicitly changes it.

## Pipeline Integration

### 1. Episode Script

The episode script should identify durable story changes:

```text
Benson puts on armor.
The dragon egg starts pulsing.
The blacksmith door is smashed.
The small dragon lizard starts trusting Benson.
```

LLM responsibility:

- Propose state events.
- Identify persistent visual changes.
- Suggest variant candidates.

Backend responsibility:

- Store events.
- Attach events to episode or shot order.
- Avoid duplicate or contradictory events.

### 2. Shot Script Generation

Shot generation should output not only action text but also state transition hints.

Suggested fields:

```json
{
  "stateIn": {
    "CHAR01": "armored, carrying dragon egg, holding sword",
    "LOC04": "door smashed, side rubble visible"
  },
  "stateChange": [
    {
      "entityId": "CHAR04",
      "change": "trust begins but remains cautious"
    }
  ],
  "stateOut": {
    "CHAR04": "hesitating near the food"
  }
}
```

LLM responsibility:

- Infer state transitions from the story.
- Explain what changes during the shot.

Backend responsibility:

- Merge with previous state.
- Reject impossible jumps or ask for regeneration.

### 3. Asset Extraction

Asset extraction should not only select assets, but also explain their role in state.

Example output:

```json
{
  "shotId": "SH02",
  "selectedAssets": [
    {
      "assetId": "CHAR01-V01",
      "role": "primary character variant",
      "reason": "Benson is currently armored"
    },
    {
      "assetId": "PROP06",
      "role": "held prop",
      "ownerAssetId": "CHAR01",
      "relation": "right hand, sword tip lowered"
    }
  ],
  "variantCandidates": [
    {
      "parentAssetId": "CHAR01",
      "appliedAssetIds": ["PROP05"],
      "reason": "Armor state persists across multiple shots"
    }
  ]
}
```

LLM responsibility:

- Detect visually persistent changes.
- Suggest whether a variant is needed.
- Choose important reference assets.

Backend responsibility:

- Keep `shot.assetRefs` as the selected visual reference list.
- Store state relations separately.
- Mark prompt packages stale when state or asset refs change.

### 4. Variant Asset Generation

Variant generation should be a controlled step, not an invisible side effect.

Recommended UX:

```text
System detects: Benson appears armored for multiple shots.
Show suggestion: Generate "Benson beginner armor form"?
User can approve, skip, or manually upload.
After approval, future relevant shots use the variant by default.
```

Why user review matters:

- Main character variants affect many future shots.
- A wrong variant can damage continuity more than a missing prop.
- The user should approve important identity changes once.

### 5. Prompt Package Generation

Prompt package generation should compile state into executable model language.

Input:

```text
shot script
shot.assetRefs
continuity state
active variants
project style
video model profile
```

Output should express relationships:

```text
@Benson beginner armor form lowers @new sword in his right hand while holding @purple dragon egg under his left arm.
```

Avoid flat asset lists:

```text
@Benson, @beginner armor, @new sword, @purple dragon egg.
```

Backend should validate:

- Prompt package does not reference assets outside `shot.assetRefs`.
- If a required active variant exists, use it instead of base asset plus clothing prop.
- If state changed after prompt package generation, mark prompt package stale.

### 6. Video Generation

Video request should use:

```text
prompt = compiled shot prompt with state relationships
image_urls = reference images for selected shot assets and variants
```

Rules:

- Variants should replace their base asset when the variant is the current visual identity.
- Temporary held props may still be separate reference images if visually important.
- Parent/global locations should not replace the specific current location.
- If a required variant has no image, warn the user before video generation.

## Model vs Backend Responsibility

### LLM Should Decide

- Whether a story event changes persistent state.
- Whether a character form looks meaningfully different.
- Which state changes matter for the current shot.
- Which assets are visually important.
- How to word state relationships in natural prompt language.

### Backend Should Enforce

- State inheritance.
- Shot order and event order.
- Asset ID validity.
- Variant parent-child relationship.
- Prompt package staleness when assets or state change.
- Video staleness when prompt package changes.
- Reference limits and model-specific constraints.
- No prompt package may invent unknown asset IDs.

### User Should Review

- Main character variants.
- Major costume or transformation states.
- Important location damage variants.
- Core prop state variants.
- Any generated reference image that will influence many later shots.

## Suggested Data Model

### Entity State Event

```json
{
  "id": "EVT-001",
  "episodeId": "EP03",
  "shotId": "SH01",
  "entityId": "CHAR01",
  "eventType": "wearing_changed",
  "value": {
    "wearing": ["PROP05"],
    "activeVariantId": "CHAR01-V01"
  },
  "persistence": "until_changed",
  "source": "llm",
  "reviewStatus": "accepted"
}
```

### Shot Continuity State

```json
{
  "shotId": "SH02",
  "stateIn": {},
  "stateChange": [],
  "stateOut": {},
  "warnings": []
}
```

### Variant Asset

```json
{
  "id": "CHAR01-V01",
  "type": "character_variant",
  "parentAssetId": "CHAR01",
  "appliedAssetIds": ["PROP05"],
  "name": "Benson beginner armor form",
  "imageUrl": "",
  "reviewStatus": "pending | approved | rejected",
  "usagePolicy": "preferred_when_state_matches"
}
```

## Frontend Requirements

Recommended UI additions:

### Shot State Panel

Shown beside or inside shot editing:

```text
Current character state
Current location state
Current prop ownership
State inherited from previous shot
State changed in this shot
Warnings
```

### Variant Suggestions

When the system detects a persistent state:

```text
Suggested variant: Benson beginner armor form
Reason: Benson wears armor across 4 shots.
Actions: generate reference / upload reference / skip / merge with base
```

### Prompt Preview

Show how state compiles into final prompt text:

```text
@Benson beginner armor form holds @purple dragon egg under his left arm...
```

This helps the user verify whether the system treats armor as a worn state or a separate object.

## Acceptance Criteria

1. If a character puts on armor, later shots inherit that state until changed.
2. If an approved armored variant exists, later prompts prefer the variant over base character plus armor prop.
3. If no variant exists, prompts must still express the relationship as "Benson wearing armor", not flat asset listing.
4. A specific local scene has priority over a parent/global scene for current shot references.
5. Persistent location damage can become a location variant when it affects multiple shots.
6. Props should store owner and position when they matter to the shot.
7. Prompt package generation must compile state relationships into natural model instructions.
8. Video generation should be blocked or warned when a required variant or key reference image is missing.
9. User review is required before a main character variant becomes the default.
10. Existing API request structure should not change; state is compiled into the prompt and reference image selection.

## Not In Initial Scope

- Fully automatic variant approval.
- Generating variants for every pose or emotion.
- Full physics or spatial simulation.
- Replacing the existing asset library.
- Changing Seedance/APIMart request fields.

## Recommended Implementation Phases

### Phase 1: State Documentation And Display

- Add continuity state schema.
- Display state in shot editing.
- Let the user see inherited state and state changes.

### Phase 2: Prompt Compiler

- Use state data when generating prompt packages.
- Compile wearing, holding, carrying, location hierarchy, and prop ownership into natural prompt text.
- Keep existing video API payload unchanged.

### Phase 3: Variant Candidate Detection

- Detect persistent character/location/prop changes.
- Show variant suggestions to the user.
- Do not auto-generate without review for main characters.

### Phase 4: Variant Asset Generation

- Generate variant reference sheets from base asset + applied asset + style reference.
- Store parent-child relationship.
- Add approval flow.

### Phase 5: Validation And Warnings

- Warn when state and assets conflict.
- Warn when prompt package ignores active state.
- Warn when video was generated before state/prompt changes.

