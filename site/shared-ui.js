(() => {
  const shineBound = new WeakSet();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function bindPointerShine(targets) {
    targets.forEach((target) => {
      if (shineBound.has(target)) return;
      shineBound.add(target);
      const clear = () => {
        target.style.removeProperty("--shine-x");
        target.style.removeProperty("--shine-y");
        target.style.setProperty("--shine-visible", "0");
      };
      const move = (event) => {
        if (reducedMotion.matches || !["mouse", "pen"].includes(event.pointerType)) return;
        const bounds = target.getBoundingClientRect();
        target.style.setProperty("--shine-x", `${event.clientX - bounds.left}px`);
        target.style.setProperty("--shine-y", `${event.clientY - bounds.top}px`);
        target.style.setProperty("--shine-visible", "1");
      };
      target.addEventListener("pointerenter", move);
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerleave", clear);
      target.addEventListener("focus", () => {
        target.style.setProperty("--shine-x", "50%");
        target.style.setProperty("--shine-y", "50%");
        target.style.setProperty("--shine-visible", "1");
      });
      target.addEventListener("blur", clear);
    });
  }

  function coverValues(item = {}) {
    const match = /^(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(item.cover_position || "");
    return {
      x: Math.max(0, Math.min(100, Number(match?.[1] ?? 50))),
      y: Math.max(0, Math.min(100, Number(match?.[2] ?? 50))),
      zoom: Math.max(1, Math.min(3, Number(item.cover_zoom) || 1)),
    };
  }

  function applyCoverCrop(image, item) {
    if (!image) return;
    const { x, y, zoom } = coverValues(item);
    image.style.objectPosition = `${x}% ${y}%`;
    image.style.transformOrigin = `${x}% ${y}%`;
    image.style.setProperty("--cover-zoom", zoom);
    image.style.removeProperty("transform");
  }

  function pointerRatio(event, surface) {
    const bounds = surface.getBoundingClientRect();
    if (!bounds.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  }

  function rebinWaveform(source, targetCount) {
    if (source.length <= targetCount) return source;
    return Array.from({ length: targetCount }, (_, index) => {
      const start = Math.floor(index * source.length / targetCount);
      const end = Math.max(start + 1, Math.floor((index + 1) * source.length / targetCount));
      return Math.max(...source.slice(start, end));
    });
  }

  function waveformHoverStyle(distance, played) {
    if (distance > 2) return null;
    const strength = [1, .78, .58][distance];
    return {
      scale: [1.38, 1.2, 1.08][distance],
      fill: played ? ["#fffdf4", "#fbf5e6", "#f7edda"][distance] : `rgba(210, 178, 112, ${strength * .72})`,
      shadow: played ? "rgba(255, 241, 203, .82)" : "rgba(210, 178, 112, .48)",
      blur: distance === 0 ? (played ? 11 : 7) : (played ? 6 : 4),
    };
  }

  function bindSeeker({ input, surface, onSeek }) {
    let pointerSeeking = false;
    const seekFromPointer = (event) => onSeek(pointerRatio(event, surface));
    input.addEventListener("pointerdown", (event) => {
      pointerSeeking = true;
      input.setPointerCapture(event.pointerId);
      seekFromPointer(event);
    });
    input.addEventListener("pointermove", (event) => { if (pointerSeeking) seekFromPointer(event); });
    input.addEventListener("pointerup", (event) => { seekFromPointer(event); pointerSeeking = false; });
    input.addEventListener("pointercancel", () => { pointerSeeking = false; });
    input.addEventListener("input", () => { if (!pointerSeeking) onSeek(Number(input.value) / 1000); });
  }

  window.TouchzoukUI = { applyCoverCrop, bindPointerShine, bindSeeker, coverValues, pointerRatio, rebinWaveform, waveformHoverStyle };
})();
