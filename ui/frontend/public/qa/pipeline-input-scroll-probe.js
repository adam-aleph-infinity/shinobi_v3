(function registerPipelineInputScrollProbe() {
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isScrollable(el) {
    if (!el || !isVisible(el)) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    const allowsScroll = oy === "auto" || oy === "scroll" || oy === "overlay";
    return allowsScroll && el.scrollHeight > el.clientHeight + 4;
  }

  function scoreViewportCandidate(el) {
    const rect = el.getBoundingClientRect();
    let score = rect.width * rect.height;
    const classText = String(el.className || "");
    if (classText.includes("nowheel")) score += 250000;
    if (el.querySelector("pre")) score += 180000;
    if (el.querySelector(".border-l-2")) score += 120000;
    return score;
  }

  function findInputDataPanel() {
    const headers = Array.from(document.querySelectorAll("h1,h2,h3,h4,p,span,div"))
      .filter((el) => isVisible(el) && (el.textContent || "").trim() === "Input Data");

    if (!headers.length) return null;

    headers.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    let root = headers[0].parentElement;
    while (root && root !== document.body) {
      const scrollables = Array.from(root.querySelectorAll("*")).filter(isScrollable);
      if (scrollables.length > 0) return root;
      root = root.parentElement;
    }

    return headers[0].parentElement;
  }

  function findViewportWithin(root) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll("*")).filter(isScrollable);
    if (!candidates.length) return null;
    candidates.sort((a, b) => scoreViewportCandidate(b) - scoreViewportCandidate(a));
    return candidates[0];
  }

  function findScrollableAncestors(el) {
    const ancestors = [];
    let node = el ? el.parentElement : null;
    while (node && node !== document.body) {
      if (isScrollable(node)) ancestors.push(node);
      node = node.parentElement;
    }
    const pageScroll = document.scrollingElement;
    if (pageScroll && pageScroll !== el && !ancestors.includes(pageScroll)) {
      ancestors.push(pageScroll);
    }
    return ancestors;
  }

  function attachWheelCounter(target, label, counters, teardown) {
    if (!target) return;
    const handler = () => {
      counters[label] = (counters[label] || 0) + 1;
    };
    target.addEventListener("wheel", handler, { passive: true });
    teardown.push(() => target.removeEventListener("wheel", handler));
  }

  window.setupPipelineInputScrollProbe = function setupPipelineInputScrollProbe(targetEl) {
    const panel = targetEl ? targetEl.closest("section,article,div") : findInputDataPanel();
    if (!panel) {
      console.error("Input Data panel not found. Select an input node first.");
      return null;
    }

    const viewport = targetEl && isScrollable(targetEl) ? targetEl : findViewportWithin(panel);
    if (!viewport) {
      console.error("No scrollable viewport found in Input Data panel. Ensure input preview content is long enough to overflow.");
      return null;
    }

    const ancestors = findScrollableAncestors(viewport);
    const counters = {};
    const teardown = [];

    const before = {
      viewportScrollTop: viewport.scrollTop,
      ancestors: ancestors.map((node) => node.scrollTop),
    };

    attachWheelCounter(viewport, "viewport", counters, teardown);
    ancestors.forEach((node, index) => {
      attachWheelCounter(node, `ancestor_${index + 1}`, counters, teardown);
    });

    const startedAt = Date.now();

    console.log("Probe armed. Scroll inside the input viewer, then run probe.report().");

    return {
      viewport,
      ancestors,
      stop() {
        teardown.forEach((fn) => fn());
        console.log("Probe listeners removed.");
      },
      report() {
        const ancestorDeltas = ancestors.map((node, index) => ({
          id: `ancestor_${index + 1}`,
          delta: Math.round((node.scrollTop - before.ancestors[index]) * 100) / 100,
          overflowY: window.getComputedStyle(node).overflowY,
        }));

        const viewportDelta = Math.round((viewport.scrollTop - before.viewportScrollTop) * 100) / 100;
        const wheelCounts = Object.assign({}, counters);
        const ancestorScrollLeak = ancestorDeltas.some((entry) => Math.abs(entry.delta) > 1);

        const pass = viewportDelta !== 0 && !ancestorScrollLeak;

        const result = {
          pass,
          elapsedMs: Date.now() - startedAt,
          viewportDelta,
          wheelCounts,
          ancestorDeltas,
        };

        console.table(ancestorDeltas);
        console.log(pass
          ? "PASS: input viewport scroll stayed isolated from ancestor scrolling."
          : "FAIL: ancestor containers also scrolled while interacting with input viewport.");

        return result;
      },
    };
  };

  console.log("setupPipelineInputScrollProbe() is available on window.");
})();
