# Pipeline Input Viewer Scroll Validation

This repo currently has no dedicated frontend test framework wired for UI interaction tests. Use the lightweight checks below.

## 1) Static contract check (fast, no browser)

Run:

```bash
node ui/frontend/scripts/validate-pipeline-input-scroll.mjs
```

Expected result:
- Every line is `[PASS] ...`
- Final line: `All pipeline input scroll validation checks passed.`

This verifies the key scroll-containment contract in code:
- Input result viewport keeps local `overflow-y-auto` scroller
- Transcript and merged-transcript input previews both use the deterministic raw viewport path
- `TranscriptViewer` external scroll mode does not create nested internal scrolling
- `TranscriptViewer` keeps `onWheelCapture` guards in its own raw/bubble render modes
- Input Data panel preserves full-height layout for deterministic scroll ownership

## 2) Runtime behavior probe (manual, reproducible)

1. Start frontend:

```bash
cd ui/frontend
npm run dev
```

2. Open `http://localhost:3000/pipeline`.
3. Select an **Input** node with long enough preview content so the input viewer overflows.
4. Open browser DevTools Console and run:

```js
await import('/qa/pipeline-input-scroll-probe.js');
const probe = window.setupPipelineInputScrollProbe();
```

5. While the probe is armed, place the cursor over the input preview and use the mouse wheel / trackpad scroll several times.
6. Run:

```js
const result = probe.report();
probe.stop();
result;
```

Expected pass criteria:
- `result.pass === true`
- `result.viewportDelta !== 0`
- `result.ancestorDeltas` are all near `0` (no outer scroll movement)
- `result.wheelCounts` is informational only (event bubbling can vary by browser/framework internals)

If the probe cannot detect the viewport automatically, rerun with a specific scroller element selected in Elements panel as `$0`:

```js
const probe = window.setupPipelineInputScrollProbe($0);
```
