const audio = document.querySelector("[data-audio]");
const playButton = document.querySelector("[data-play]");
const waveform = document.querySelector("[data-waveform]");
const seek = document.querySelector("[data-seek]");
const currentTime = document.querySelector("[data-current]");
const duration = document.querySelector("[data-duration]");
const menuButton = document.querySelector(".menu-toggle");
const menu = document.querySelector(".site-nav");
const menuLabel = menuButton.querySelector(".sr-only");

const shineTargets = document.querySelectorAll(
  ".site-nav a, .social-nav a, .hero-logo, .play-button, .celestial-button, .book-button, .about-copy .text-link, .event-body a, .contact-details a, footer a",
);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

shineTargets.forEach((target) => {
  const clearShine = () => {
    if (target.classList.contains("hero-logo")) {
      target.style.setProperty("--shine-visible", "0");
      return;
    }

    target.style.removeProperty("--shine-x");
    target.style.removeProperty("--shine-y");
    target.style.removeProperty("--shine-visible");
  };

  const moveShine = (event) => {
    if (prefersReducedMotion.matches || !["mouse", "pen"].includes(event.pointerType)) return;

    const bounds = target.getBoundingClientRect();
    target.style.setProperty("--shine-x", `${event.clientX - bounds.left}px`);
    target.style.setProperty("--shine-y", `${event.clientY - bounds.top}px`);
    target.style.setProperty("--shine-visible", "1");
  };

  target.addEventListener("pointerenter", moveShine);
  target.addEventListener("pointermove", moveShine);
  target.addEventListener("pointerleave", clearShine);
  target.addEventListener("focus", () => {
    target.style.setProperty("--shine-x", "50%");
    target.style.setProperty("--shine-y", "50%");
    target.style.setProperty("--shine-visible", "1");
  });
  target.addEventListener("blur", clearShine);
});

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—:—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const clock = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours ? `${hours}:${clock}` : clock;
};

const bars = Array.from({ length: 58 }, (_, index) => {
  const bar = document.createElement("i");
  const wave = Math.abs(Math.sin(index * 0.73) * Math.cos(index * 0.19));
  bar.style.setProperty("--bar-height", `${25 + wave * 75}%`);
  waveform.append(bar);
  return bar;
});

const paintProgress = () => {
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  bars.forEach((bar, index) => bar.classList.toggle("played", index / bars.length <= progress));
  currentTime.textContent = formatTime(audio.currentTime);
  seek.value = String(Math.round(progress * 1000));
  seek.setAttribute("aria-valuetext", `${formatTime(audio.currentTime)} of ${formatTime(audio.duration)}`);
};

const setMenuOpen = (open) => {
  menuButton.setAttribute("aria-expanded", String(open));
  menuLabel.textContent = open ? "Close menu" : "Open menu";
  menu.classList.toggle("is-open", open);
};

audio.addEventListener("loadedmetadata", () => {
  duration.textContent = formatTime(audio.duration);
  paintProgress();
});

audio.addEventListener("timeupdate", paintProgress);
audio.addEventListener("ended", () => {
  playButton.classList.remove("is-playing");
  playButton.setAttribute("aria-label", "Play Crystal Fortress");
});

playButton.addEventListener("click", async () => {
  if (audio.paused) {
    try {
      await audio.play();
      playButton.classList.add("is-playing");
      playButton.setAttribute("aria-label", "Pause Crystal Fortress");
    } catch {
      playButton.classList.remove("is-playing");
      playButton.setAttribute("aria-label", "Crystal Fortress is unavailable");
    }
  } else {
    audio.pause();
    playButton.classList.remove("is-playing");
    playButton.setAttribute("aria-label", "Play Crystal Fortress");
  }
});

seek.addEventListener("input", () => {
  if (!audio.duration) return;
  audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
});

menuButton.addEventListener("click", () => {
  const willOpen = menuButton.getAttribute("aria-expanded") !== "true";
  setMenuOpen(willOpen);
});

menu.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return;
  setMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !menu.classList.contains("is-open")) return;
  setMenuOpen(false);
  menuButton.focus();
});
