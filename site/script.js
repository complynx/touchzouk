const audio = document.querySelector("[data-audio]");
const playButton = document.querySelector("[data-play]");
const waveform = document.querySelector("[data-waveform]");
const seek = document.querySelector("[data-seek]");
const currentTime = document.querySelector("[data-current]");
const duration = document.querySelector("[data-duration]");
const volume = document.querySelector("[data-featured-volume]");
const menuButton = document.querySelector(".menu-toggle");
const menu = document.querySelector(".site-nav");
const menuLabel = menuButton.querySelector(".sr-only");
let featuredTitle = "featured set";
let playRequested = false;
let startingPlayback = false;
let playIntent = 0;
let waveformSource = [];
let hoverWaveformRatio = null;
let waveformPaintFrame = 0;

const setVolume = (value) => {
  audio.volume = Number(value);
  volume.value = value;
  volume.style.setProperty("--volume-percent", `${Math.round(Number(value) * 100)}%`);
  volume.setAttribute("aria-valuetext", `${Math.round(Number(value) * 100)} percent`);
};
setVolume(volume.value);
volume.addEventListener("input", () => setVolume(volume.value));

TouchzoukUI.bindPointerShine(document.querySelectorAll(
  ".site-nav a, .social-nav a, .hero-logo, .play-button, .celestial-button, .book-button, .about-copy .text-link, .event-body a, .contact-details a, footer a",
));

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "—:—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const clock = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours ? `${hours}:${clock}` : clock;
};

let bars = [];
const paintWaveform = () => {
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  const hoverIndex = hoverWaveformRatio == null ? -10 : Math.min(bars.length - 1, Math.floor(hoverWaveformRatio * bars.length));
  bars.forEach((bar, index) => {
    const played = progress > 0 && (index + .5) / bars.length <= progress;
    const hover = TouchzoukUI.waveformHoverStyle(Math.abs(index - hoverIndex), played);
    bar.classList.toggle("played", played);
    bar.classList.toggle("is-hovered", Boolean(hover));
    if (!hover) return;
    bar.style.setProperty("--hover-scale", hover.scale);
    bar.style.setProperty("--hover-fill", hover.fill);
    bar.style.setProperty("--hover-shadow", hover.shadow);
    bar.style.setProperty("--hover-blur", `${hover.blur}px`);
  });
};

const requestWaveformPaint = () => {
  if (waveformPaintFrame) return;
  waveformPaintFrame = requestAnimationFrame(() => {
    waveformPaintFrame = 0;
    paintWaveform();
  });
};

const renderWaveform = (source = waveformSource) => {
  waveformSource = source;
  const availableWidth = waveform.getBoundingClientRect().width;
  const target = Math.max(18, Math.min(58, Math.floor((availableWidth || 260) / 4.5)));
  const fallback = Array.from({ length: 180 }, (_, index) => Math.abs(Math.sin(index * .73) * Math.cos(index * .19)));
  const points = TouchzoukUI.rebinWaveform(source.length ? source : fallback, target);
  waveform.replaceChildren();
  bars = points.map((point) => {
    const bar = document.createElement("i");
    bar.style.setProperty("--bar-height", `${25 + point * 75}%`);
    waveform.append(bar);
    return bar;
  });
  paintWaveform();
};
renderWaveform();

const loadFeatured = async () => {
  try {
    const response = await fetch("/api/featured");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const item = await response.json();
    featuredTitle = item.title;
    audio.src = item.audio_url;
    const cover = document.querySelector("[data-featured-cover]");
    cover.src = item.cover_url;
    cover.alt = `${item.title} cover`;
    TouchzoukUI.applyCoverCrop(cover, item);
    document.querySelector("[data-featured-title]").textContent = item.title;
    document.querySelector("[data-featured-kicker]").textContent = item.event_name ? `Featured set · ${item.event_name}` : "Featured set";
    document.querySelector("[data-featured-subtitle]").textContent = item.subtitle || item.played_at || "Sound Atlas";
    playButton.setAttribute("aria-label", `Play ${item.title}`);
    seek.setAttribute("aria-label", `Seek through ${item.title}`);
    try {
      const waveResponse = await fetch(item.waveform_url, { cache: "no-cache" });
      if (waveResponse.ok) renderWaveform((await waveResponse.json()).points || []);
    } catch (error) {
      console.error("Could not load featured waveform", error);
    }
  } catch (error) {
    document.querySelector("[data-featured-title]").textContent = "No featured set";
    document.querySelector("[data-featured-subtitle]").textContent = "Open Sound Atlas to explore the catalog";
    playButton.disabled = true;
    console.error(error);
  }
};

const paintProgress = () => {
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  paintWaveform();
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
  playRequested = false;
  updatePlayState();
});

function updatePlayState(unavailable = false) {
  playButton.classList.toggle("is-playing", playRequested);
  playButton.setAttribute("aria-label", unavailable ? `${featuredTitle} is unavailable` : `${playRequested ? "Pause" : "Play"} ${featuredTitle}`);
}

async function requestPlay() {
  const intent = ++playIntent;
  playRequested = true;
  startingPlayback = true;
  updatePlayState();
  try {
    await audio.play();
    if (intent !== playIntent) {
      if (!playRequested) audio.pause();
      return;
    }
    startingPlayback = false;
    if (!playRequested) audio.pause();
  } catch {
    if (intent !== playIntent) return;
    startingPlayback = false;
    if (!playRequested) return;
    playRequested = false;
    updatePlayState(true);
  }
}

function requestPause() {
  playIntent += 1;
  startingPlayback = false;
  playRequested = false;
  audio.pause();
  updatePlayState();
}

playButton.addEventListener("click", () => {
  if (playRequested) requestPause();
  else void requestPlay();
});

audio.addEventListener("play", () => {
  if (!playRequested) {
    audio.pause();
    return;
  }
  updatePlayState();
});
audio.addEventListener("pause", () => { if (!startingPlayback) playRequested = false; updatePlayState(); });

TouchzoukUI.bindSeeker({ input: seek, surface: waveform, onSeek: (progress) => {
  if (!audio.duration) return;
  seek.value = String(Math.round(progress * 1000));
  audio.currentTime = progress * audio.duration;
  requestWaveformPaint();
} });

seek.parentElement.addEventListener("pointermove", (event) => {
  hoverWaveformRatio = TouchzoukUI.pointerRatio(event, waveform);
  requestWaveformPaint();
});
seek.parentElement.addEventListener("pointerleave", () => {
  hoverWaveformRatio = null;
  requestWaveformPaint();
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

window.addEventListener("resize", () => renderWaveform());

loadFeatured();
