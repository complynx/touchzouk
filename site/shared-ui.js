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

  function createLocationLink(item, className = "") {
    const label = [item.city, item.country].filter(Boolean).join(" · ") || "Location";
    if (!item.location_url) return null;
    const link = document.createElement("a");
    link.className = `location-link ${className}`.trim();
    link.href = item.location_url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.setAttribute("aria-label", `Open ${label} in Google Maps`);
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 20"><path d="M8 1.25a6 6 0 0 0-6 6c0 4.5 6 11.5 6 11.5s6-7 6-11.5a6 6 0 0 0-6-6Zm0 8.35a2.35 2.35 0 1 1 0-4.7 2.35 2.35 0 0 1 0 4.7Z"/></svg>';
    const text = document.createElement("span");
    text.textContent = label;
    link.append(text);
    return link;
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

  function bindSeeker({ input, surface, onSeek, onSeekStart, onSeekEnd }) {
    let activePointerId = null;
    const seekFromPointer = (event) => onSeek(pointerRatio(event, surface));
    input.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || activePointerId !== null) return;
      activePointerId = event.pointerId;
      onSeekStart?.();
      input.setPointerCapture(event.pointerId);
      seekFromPointer(event);
    });
    input.addEventListener("pointermove", (event) => {
      if (event.pointerId === activePointerId) seekFromPointer(event);
    });
    input.addEventListener("pointerup", (event) => {
      if (event.pointerId !== activePointerId) return;
      seekFromPointer(event);
      activePointerId = null;
      onSeekEnd?.();
    });
    input.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      onSeekEnd?.();
    });
    input.addEventListener("input", () => { if (activePointerId === null) onSeek(Number(input.value) / 1000); });
  }

  function playbackRequest(search = window.location.search) {
    const parameters = new URLSearchParams(search);
    const trackID = (parameters.get("track") || "").trim();
    const parsedTime = Number(parameters.get("t"));
    const seconds = Number.isFinite(parsedTime) && parsedTime > 0 ? Math.floor(parsedTime) : 0;
    return { trackID, seconds };
  }

  function trackURL(trackID, seconds = 0) {
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set("track", trackID);
    const wholeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    if (wholeSeconds) url.searchParams.set("t", String(wholeSeconds));
    return url.href;
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  function bindTrackSharing({
    button,
    seeker,
    seekSurface = seeker,
    status,
    getTrackID,
    getCurrentTime,
    getDuration,
    formatTime,
  }) {
    const menu = document.createElement("div");
    const linkButton = document.createElement("button");
    const timeButton = document.createElement("button");
    const toast = document.createElement("div");
    let menuSeconds = 0;
    let closeTimer = 0;
    let toastTimer = 0;

    menu.className = "track-share-menu";
    menu.hidden = true;
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Share options");
    linkButton.type = "button";
    linkButton.textContent = "Copy link";
    timeButton.type = "button";
    menu.append(linkButton, timeButton);
    toast.className = "track-share-toast";
    toast.hidden = true;
    toast.textContent = "link copied";
    toast.setAttribute("aria-hidden", "true");
    document.body.append(menu, toast);
    button.setAttribute("aria-expanded", "false");

    const setStatus = (message) => {
      if (status) status.textContent = message;
    };
    const closeMenu = () => {
      const menuHadFocus = menu.contains(document.activeElement);
      window.clearTimeout(closeTimer);
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (menuHadFocus) button.focus({ preventScroll: true });
    };
    const positionMenu = (left, top) => requestAnimationFrame(() => {
      const edge = 8;
      const boundedLeft = Math.max(edge, Math.min(left, window.innerWidth - menu.offsetWidth - edge));
      const boundedTop = Math.max(edge, Math.min(top, window.innerHeight - menu.offsetHeight - edge));
      menu.style.left = `${boundedLeft}px`;
      menu.style.top = `${boundedTop}px`;
    });
    const showToast = (action) => {
      const bounds = action.getBoundingClientRect();
      toast.hidden = false;
      window.clearTimeout(toastTimer);
      requestAnimationFrame(() => {
        const edge = 8;
        const gap = 8;
        const centeredLeft = bounds.left + (bounds.width - toast.offsetWidth) / 2;
        const above = bounds.top - toast.offsetHeight - gap;
        const top = above >= edge ? above : bounds.bottom + gap;
        toast.style.left = `${Math.max(edge, Math.min(centeredLeft, window.innerWidth - toast.offsetWidth - edge))}px`;
        toast.style.top = `${Math.min(top, window.innerHeight - toast.offsetHeight - edge)}px`;
      });
      toastTimer = window.setTimeout(() => { toast.hidden = true; }, 1800);
    };
    const openMenu = (seconds, left, top, includeLink) => {
      menuSeconds = Math.max(0, Math.floor(seconds));
      linkButton.hidden = !includeLink;
      timeButton.hidden = menuSeconds < 1;
      timeButton.textContent = `Copy link from ${formatTime(menuSeconds)}`;
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      positionMenu(left, top);
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(closeMenu, 10000);
      (includeLink ? linkButton : timeButton).focus({ preventScroll: true });
    };
    const copyAt = async (seconds, action) => {
      const trackID = getTrackID();
      if (!trackID) return false;
      try {
        await copyText(trackURL(trackID, seconds));
        setStatus(seconds ? `Link from ${formatTime(seconds)} copied` : "Track link copied");
        showToast(action);
        return true;
      } catch (error) {
        setStatus("Could not copy link");
        console.error(error);
        return false;
      }
    };

    button.addEventListener("click", async () => {
      if (!await copyAt(0, button)) return;
      const seconds = Math.floor(getCurrentTime());
      if (seconds < 1) {
        closeMenu();
        return;
      }
      const bounds = button.getBoundingClientRect();
      openMenu(seconds, bounds.left, bounds.bottom + 6, false);
    });
    linkButton.addEventListener("click", async () => {
      await copyAt(0, linkButton);
      closeMenu();
    });
    timeButton.addEventListener("click", async () => {
      await copyAt(menuSeconds, timeButton);
      closeMenu();
    });
    seeker.addEventListener("contextmenu", (event) => {
      if (!getTrackID()) return;
      const duration = getDuration();
      const seconds = Number.isFinite(duration) && duration > 0
        ? Math.floor(pointerRatio(event, seekSurface) * duration)
        : 0;
      event.preventDefault();
      openMenu(seconds, event.clientX, event.clientY, true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (menu.hidden || menu.contains(event.target) || button.contains(event.target)) return;
      closeMenu();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menu.hidden) return;
      closeMenu();
    });
  }

  window.TouchzoukUI = {
    applyCoverCrop,
    bindPointerShine,
    bindSeeker,
    bindTrackSharing,
    coverValues,
    createLocationLink,
    playbackRequest,
    pointerRatio,
    rebinWaveform,
    trackURL,
    waveformHoverStyle,
  };
})();
