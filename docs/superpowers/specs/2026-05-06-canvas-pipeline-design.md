# Canvas Pipeline Page — Design Spec

**Date:** 2026-05-06  
**Status:** Approved  
**Replaces:** `ui/frontend/app/pipeline/page.tsx`  
**New route:** `/canvas`

---

## Goal

Replace the existing `/pipeline` page with a modern, canvas-based pipeline editor built on React Flow. The new page must achieve full feature parity with `/pipeline` while delivering a significantly better editing and monitoring experience. If good enough, `/pipeline` is deprecated and redirected to `/canvas`.

---

## Layout

Option C was selected: **icon rail + pipeline list + canvas + bottom log strip**.

```
┌─────────────────────────────────────────────────────────────────┐
│  ContextTopBar — agent | customer | call date (unchanged)       │
├────┬──────────┬────────────────────────────────────┬────────────┤
│ 📁 │ Pipeline │                                    │ Inspector  │
│rail│  list    │         ReactFlow Canvas           │  panel     │
│    │  panel   │   (dot grid, nodes, edges,         │  (slides   │
│48px│  180px   │    floating toolbar, minimap)       │   in on    │
│    │          │                                    │ node click)│
├────┴──────────┴────────────────────────────────────┴────────────┤
│  Bottom log strip (collapsible, always visible)                 │
└─────────────────────────────────────────────────────────────────┘
```

### Left icon rail (48px)
- One icon per pipeline folder; active folder highlighted with indigo border
- Bottom: `+` button to create a new folder
- Right-click folder icon → context menu: Rename, Delete

### Pipeline list panel (180px)
- Shows pipelines in the active folder
- Active pipeline highlighted with indigo background + dot
- Right-click pipeline item → context menu: Rename, Duplicate, Delete, Export Bundle
- Bottom: `+ New Pipeline` button

### Canvas
- `ReactFlowProvider` wrapper with dark dot-grid background
- Floating toolbar (centered, pill shape): undo, redo | + Node, delete | zoom−, zoom%, zoom+, fit | ▶ Run
- Minimap (bottom-left corner, 90×60px, interactive)
- Rubber-band multi-select by dragging on empty canvas
- Space+drag to pan; scroll to zoom (cursor-centered)
- Right-click canvas background → context menu: Add Node, Paste, Select All, Fit to Screen

### Right inspector panel (220px, slides in)
- Appears when a node is selected; closes with ✕ or by clicking empty canvas
- Stays open if you switch selection to another node (content updates instantly)
- Shows full node config: agent selector, model, input source, output format
- "Last Output" preview section with "View Full Output" button → modal
- CRM push action on output nodes

### Bottom log strip
- Always visible (single row of latest log lines)
- `expand ↑` button → tall panel showing full run history + all log lines
- Color-coded: green (done), amber (running), gray (idle/info)

---

## File Structure

```
ui/frontend/app/canvas/
  page.tsx                        ← layout shell only (~80 lines)
  types.ts                        ← all TS interfaces
  components/
    CanvasSidebar.tsx             ← icon rail + pipeline list
    CanvasToolbar.tsx             ← floating toolbar
    CanvasBoard.tsx               ← ReactFlow wrapper
    BottomLogPanel.tsx            ← log strip + expanded view
    RunLaunchModal.tsx            ← launch options modal
    node-types/
      InputNode.tsx               ← transcript/merged/manual
      AgentNode.tsx               ← rich inline agent card
      OutputNode.tsx              ← artifact output card
    inspector/
      NodeInspector.tsx           ← right panel, full config
  hooks/
    useCanvasState.ts             ← nodes/edges, undo/redo, clipboard
    useRunExecution.ts            ← launch, poll, live step state
    usePipelineData.ts            ← SWR: pipelines, folders, agents, history
```

**Unchanged / reused:**
- `components/shared/ContextTopBar.tsx` — zero modifications
- `lib/app-context.tsx` — zero modifications
- `components/shared/TranscriptViewer.tsx`
- `components/shared/SectionCards.tsx`
- All existing backend API endpoints

---

## Node Design

**Rich inline card** (Option C) for all node types.

### Structure (AgentNode example)
```
┌─────────────────────────────────────┐  ← border color = node type
│ 🤖  Persona Agent      ● done 1.2s  │  ← header: icon, name, status badge
│     agent · persona class           │
├─────────────────────────────────────┤
│ model    [claude-sonnet         ▼]  │  ← config fields (editable dropdowns)
│ input    [transcript            ▼]  │
│ output   [markdown              ▼]  │
├─────────────────────────────────────┤
│ Customer: high-value prospect...    │  ← last output preview (truncated)
├─────────────────────────────────────┤
│ [▶ Run] [👁 View] [⋯]      1.2s   │  ← footer actions
└─────────────────────────────────────┘
  ●                               ●     ← left/right handles
```

### Node status badges
| Status | Color | Indicator |
|--------|-------|-----------|
| idle/pending | gray | gray dot |
| running | amber | animated pulsing dot + progress bar |
| done | green | green dot + execution time |
| error | red | red dot + error message in footer |
| cached | amber | amber dot |
| cancelled | slate | slate dot |

### Color scheme by type
| Type | Border | Header bg |
|------|--------|-----------|
| Input | `border-blue-600` | `bg-blue-950` |
| Agent | `border-indigo-500` | `bg-indigo-950` |
| Output | `border-violet-600` | `bg-violet-950` |

### Running animation
- Thin progress bar below header: gradient `indigo → violet`, width animates
- Status badge background pulses amber
- Edge connecting to this node animates (dashed stroke-dashoffset)

---

## Canvas Interactions

### Adding nodes
- Toolbar `+ Node` → picker modal (list of types: Input / Agent / Output)
- Right-click canvas → "Add Node" → same picker modal
- New node placed at canvas center (or near cursor for right-click)

### Connecting nodes
- Drag from a handle → animated connector follows cursor
- Drop on target handle → edge created
- Invalid connections rejected via `isValidConnection` callback (e.g., Output → Input blocked)

### Selection
- Click node → select (highlights with indigo ring + 3px glow)
- Click empty canvas → deselect all
- Drag on empty canvas → rubber-band selection (blue translucent rect)
- Ctrl+A → select all
- Multi-select: Ctrl+Click to add/remove individual nodes

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| Delete / Backspace | Delete selected nodes/edges |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+C | Copy selected nodes |
| Ctrl+V | Paste nodes (offset +20px) |
| Ctrl+A | Select all |

### Context menus
**Node right-click:** Duplicate, Cut, Copy, Copy ID, Disable/Enable, Delete  
**Edge right-click:** Delete  
**Canvas right-click:** Add Node, Paste, Select All, Fit to Screen

---

## Data Flow

### State layers
```
AppCtx (global)          salesAgent, customer, callId, activePipelineId
usePipelineData (SWR)    pipelines, folders, agents, run history
useCanvasState           nodes[], edges[], undoStack[], clipboard[]
useRunExecution          runId, liveState (step→node badges), logs[]
```

### Save flow
User edits node config → `onNodeDataChange(id, patch)` → merge into nodes[] → debounced 500ms → `PUT /api/pipelines/{id}` with `{ canvas: { nodes, edges }, steps: derived[] }`.

The `steps[]` array fed to the backend is derived from nodes/edges on save — identical shape to today, zero backend changes.

### RunLaunchModal contents
Small modal (300px wide) over dimmed canvas. Fields:
- **Force re-run** toggle — bypass cache for all steps
- **Failed steps only** toggle — re-run only errored steps (mutually exclusive with force)
- **Resume run** toggle + run-id selector — continue a partial run
- **Launch** button (green) + **Cancel**

### Execution flow
1. `▶ Run` toolbar button → `RunLaunchModal` opens
2. User selects options (force, partial, resume) → confirms
3. `useRunExecution.launch()` → `POST /api/runs/`
4. Poll `GET /api/runs/{runId}` every 2s while active
5. Each poll maps `steps_json` step statuses → node status badges via `runtimeStatusFromToken()`
6. Logs appended to `BottomLogPanel`
7. On terminal status → poll stops, final badges rendered

---

## Feature Scope

### Full parity with `/pipeline`
- Folder CRUD (create, rename, delete)
- Pipeline CRUD (create, rename, delete, duplicate)
- Node add/remove/connect
- Agent config (model, prompt, input, output format, output contract)
- Run execution with force/partial/resume options
- Live execution state on nodes
- View step output / artifact content (modal)
- CRM note push from output nodes
- Run history log
- Bundle export / import
- Transcript viewer modal
- Undo / redo

### New in `/canvas`
- Rubber-band multi-select + bulk delete
- Copy/paste nodes (Ctrl+C / Ctrl+V)
- Minimap navigation
- Context menus (node, edge, canvas)
- Animated edges during execution
- Debounced auto-save of canvas layout positions
- Always-visible bottom log strip (expandable)

### Explicitly out of scope (v1)
- Auto-layout algorithm (dagre/elk)
- Subflow / group nodes
- Comments / sticky notes on canvas
- Multi-user collaboration
- Mobile / touch support

---

## Migration

1. Build `/canvas` to full feature parity
2. Add nav link alongside existing `/pipeline` link for testing
3. Once validated, redirect `/pipeline` → `/canvas`
4. Remove old `pipeline/page.tsx` in a follow-up cleanup commit

---

## Technical Notes

- Library: `@xyflow/react` v12 (already installed)
- Undo/redo: snapshot-based deep-copy on every `useNodesState` change (not command pattern — simpler and sufficient)
- Auto-save: 500ms debounce on node data changes; canvas position changes (drag) save on `onNodeDragStop`
- TypeScript: strict — `tsc --noEmit` must pass before every commit
- The existing `/pipeline` page's run-status normalization functions (`runtimeStatusFromToken`, `isRunningLike`, etc.) are copied verbatim to `types.ts` then deleted from the old page on migration
