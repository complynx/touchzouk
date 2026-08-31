const state = {
  audioUpload: null,
  coverUpload: null,
  editing: null,
  libraryKind: "set",
  editorGeneration: 0,
  catalog: { set: [], song: [] },
  settings: { featured_set_id: "", set_order: [], song_order: [] },
  audioSequence: 0,
  coverSequence: 0,
  coverReplacementStarted: false,
  autoTitle: "",
  kindDirty: false,
  coverTransform: { x: 50, y: 50, zoom: 1 },
  waveformPreviewController: null,
  previewWaveform: [],
  previewHoverRatio: null,
  previewSource: "",
  previewTitle: "audio preview",
  previewPlayRequested: false,
  previewStarting: false,
  previewSeeking: false,
  previewSeekWasPlaying: false,
  previewIntent: 0,
  previewView: { start: 0, end: 1 },
  previewSticky: false,
  timedContent: { entries: [], text: "", markers: [], pauses: [] },
  lyricsCursor: 0,
  lyricsCursorPauseCount: 0,
  lyricsSelection: { start: 0, end: 0 },
  lyricsPlaybackOffset: -1,
  lyricsPlaybackPauseCount: 0,
  selectedLyricMarker: null,
};

const form = document.querySelector("#media-form");
const submit = document.querySelector("[data-submit-media]");
const message = document.querySelector("[data-form-message]");
const audioDrop = document.querySelector('[data-file-drop="audio"]');
const audioInput = audioDrop.querySelector('input[type="file"]');
const coverDrop = document.querySelector('[data-file-drop="cover"]');
const audioReady = document.querySelector("[data-audio-ready]");
const audioStatus = document.querySelector("[data-audio-status]");
const coverStatus = document.querySelector("[data-cover-status]");
const audioProgress = document.querySelector("[data-audio-progress]");
const coverProgress = document.querySelector("[data-cover-progress]");
const coverPreview = document.querySelector("[data-cover-preview]");
const coverInput = document.querySelector("[data-cover-input]");
const coverTools = document.querySelector("[data-cover-tools]");
const coverUpload = document.querySelector("[data-cover-upload]");
const setFields = document.querySelector("[data-set-fields]");
const cancelEdit = document.querySelector("[data-cancel-edit]");
const editorTitle = document.querySelector("#editor-title");
const editorContext = document.querySelector("[data-editor-context]");
const uploadWaveform = document.querySelector("[data-upload-waveform]");
const rebuildWave = document.querySelector("[data-rebuild-wave]");
const previewAudio = document.querySelector("[data-preview-audio]");
const previewPlay = document.querySelector("[data-preview-play]");
const previewSeek = document.querySelector("[data-preview-seek]");
const previewVolume = document.querySelector("[data-preview-volume]");
const previewCurrent = document.querySelector("[data-preview-current]");
const previewDuration = document.querySelector("[data-preview-duration]");
const deleteDialog = document.querySelector("[data-delete-dialog]");
const tagSuggestions = document.querySelector("[data-tag-suggestions]");
const previewCues = document.querySelector("[data-preview-cues]");
const previewNavigator = document.querySelector("[data-preview-navigator]");
const timelineWindow = document.querySelector("[data-timeline-window]");
const setTimedFields = document.querySelector("[data-set-timed-fields]");
const songTimedFields = document.querySelector("[data-song-timed-fields]");
const timedHeading = document.querySelector("[data-timed-heading]");
const shiftFollowing = document.querySelector("[data-shift-following]");
const liveLyricsCursor = document.querySelector("[data-live-lyrics-cursor]");
const liveLyricsCursorToggle = document.querySelector("[data-live-lyrics-toggle]");
const songListInput = document.querySelector("[data-song-list-input]");
const timedList = document.querySelector("[data-timed-list]");
const clearSongs = document.querySelector("[data-clear-songs]");
const lyricsEditor = document.querySelector("[data-lyrics-editor]");
const playlistDrop = document.querySelector("[data-playlist-drop]");
const playlistInput = document.querySelector("[data-playlist-input]");
const timelineFollow = document.querySelector("[data-timeline-follow]");
const PAUSE_SYMBOL = "𝄺";
const LYRICS_CLIPBOARD_TYPE = "application/x-touchzouk-lyrics";
const LYRIC_MARKER_MOVE_DIRECTIONS = { ArrowLeft: -1, ArrowRight: 1, Comma: -1, Period: 1 };
const LYRIC_NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
let mutationQueue = Promise.resolve();
let catalogLoadSequence = 0;
let editorSavePending = false;
let catalogOrderPending = false;
let previewWaveformFrame = 0;
let previewPlaybackFrame = 0;
let lyricsComposing = false;
const liveLyricsNavigationKeys = new Set();
let liveLyricsNavigationFrame = 0;
const activeUploads = { audio: null, cover: null };

function enqueueMutation(url, options) {
  catalogLoadSequence += 1;
  const request = mutationQueue.then(async () => {
    const response = await fetch(url, options);
    return { response, result: await response.json() };
  });
  mutationQueue = request.then(() => undefined, () => undefined);
  return request;
}

function setEditorBusy(busy) {
  form.querySelectorAll("input, textarea, select, button").forEach((control) => {
    if (control !== cancelEdit) control.disabled = busy;
  });
  lyricsEditor.contentEditable = String(!busy);
}

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

function cloneTimedContent(content = {}) {
  return {
    entries: (content.entries || []).map((entry) => ({ text: String(entry.text || ""), time_ms: Number(entry.time_ms) || 0 })),
    text: String(content.text || ""),
    markers: (content.markers || []).map((marker) => ({ offset: Number(marker.offset) || 0, time_ms: Number(marker.time_ms) || 0 })),
    pauses: [...(content.pauses || [])].map((offset) => Number(offset) || 0),
  };
}

function previewDurationSeconds() {
  if (Number.isFinite(previewAudio.duration) && previewAudio.duration > 0) return previewAudio.duration;
  return state.audioUpload?.duration_seconds || state.editing?.duration_seconds || 0;
}

function formatMarkerTime(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total % 3_600_000 / 60_000);
  const seconds = Math.floor(total % 60_000 / 1000);
  const fraction = total % 1000;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

function lyricCaptionPart(value, fromEnd) {
  const runes = Array.from(fromEnd ? value.trimStart() : value.trimEnd());
  if (runes.length <= 12) return runes.join("");
  const clipped = (fromEnd ? runes.slice(-12) : runes.slice(0, 12)).join("");
  return fromEnd
    ? clipped.replace(/^\S+\s+/, "").trimStart()
    : clipped.replace(/\s+\S*$/, "").trimEnd();
}

function lyricPauseCounts() {
  const pauseCounts = new Map();
  state.timedContent.pauses.forEach((offset) => pauseCounts.set(offset, (pauseCounts.get(offset) || 0) + 1));
  return pauseCounts;
}

function lyricMarkerCaption(marker, markerIndex, markers, pauseCounts = lyricPauseCounts(), runes = Array.from(state.timedContent.text)) {
  const offset = Math.max(0, Math.min(runes.length, marker.offset));
  let lineStart = offset;
  while (lineStart > 0 && offset - lineStart < 24 && runes[lineStart - 1] !== "\n") lineStart -= 1;
  let lineEnd = offset;
  while (lineEnd < runes.length && lineEnd - offset < 24 && runes[lineEnd] !== "\n") lineEnd += 1;
  const pausesAtOffset = pauseCounts.get(offset) || 0;
  const markerAtOffsetIndex = markers.slice(0, markerIndex).filter((candidate) => candidate.offset === offset).length;
  const markerAfterPause = pausesAtOffset && markerAtOffsetIndex > 0;
  const text = (start, end, skipFirstPause = false) => {
    const result = [];
    for (let index = start; index < end; index += 1) {
      if (!skipFirstPause || index !== start) result.push(PAUSE_SYMBOL.repeat(pauseCounts.get(index) || 0));
      result.push(runes[index]);
    }
    return result.join("");
  };
  const pause = PAUSE_SYMBOL.repeat(pausesAtOffset);
  const before = `${text(lineStart, offset)}${markerAfterPause ? pause : ""}`;
  const after = `${markerAfterPause ? "" : pause}${text(offset, lineEnd, true)}`;
  return `${lyricCaptionPart(before, true)}|${lyricCaptionPart(after, false)}`;
}

function timelineCueLabels(marker, markerIndex, markers, pauseCounts, runes) {
  const time = formatMarkerTime(marker.time_ms);
  if (form.elements.kind.value === "set") {
    const title = `${marker.text} · ${time}`;
    return { title, ariaLabel: title };
  }
  const title = lyricMarkerCaption(marker, markerIndex, markers, pauseCounts, runes);
  return { title, ariaLabel: `${title}, ${time}` };
}

function activeTimelineMarkers() {
  return form.elements.kind.value === "set" ? state.timedContent.entries : state.timedContent.markers;
}

function collapsedLyricRanges(markers = state.timedContent.markers) {
  const sorted = [...markers].sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  const ranges = [];
  for (let index = 0; index < sorted.length - 1;) {
    const left = sorted[index];
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].time_ms === left.time_ms && sorted[end + 1].offset > sorted[end].offset) end += 1;
    if (end > index) ranges.push({ start: left.offset, end: sorted[end].offset, time_ms: left.time_ms, markers: sorted.slice(index, end + 1) });
    index = Math.max(index + 1, end + 1);
  }
  return ranges;
}

function editorNodeUnits(node) {
  if (node.nodeType === Node.TEXT_NODE) return Array.from(node.data).filter((rune) => rune !== PAUSE_SYMBOL).length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  if (node.matches(".lyrics-time-mark, .lyrics-pause-mark, .lyrics-play-cursor")) return 0;
  if (node.tagName === "BR") return 1;
  return [...node.childNodes].reduce((total, child) => total + editorNodeUnits(child), 0);
}

function editorPauseUnits(node) {
  if (node.nodeType === Node.TEXT_NODE) return Array.from(node.data).filter((rune) => rune === PAUSE_SYMBOL).length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  if (node.matches(".lyrics-pause-mark")) return 1;
  if (node.matches(".lyrics-time-mark, .lyrics-play-cursor")) return 0;
  return [...node.childNodes].reduce((total, child) => total + editorPauseUnits(child), 0);
}

function editorPauseCountFromPoint(target, targetOffset) {
  const visit = (node) => {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        return { found: true, pauses: Array.from(node.data.slice(0, targetOffset)).filter((rune) => rune === PAUSE_SYMBOL).length };
      }
      return { found: true, pauses: [...node.childNodes].slice(0, targetOffset).reduce((total, child) => total + editorPauseUnits(child), 0) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".lyrics-time-mark, .lyrics-play-cursor")) {
      return { found: false, pauses: editorPauseUnits(node) };
    }
    let pauses = 0;
    for (const child of node.childNodes) {
      const result = visit(child);
      if (result.found) return { found: true, pauses: pauses + result.pauses };
      pauses += result.pauses;
    }
    return { found: false, pauses };
  };
  return visit(lyricsEditor).pauses;
}

function editorOffsetFromPoint(target, targetOffset) {
  const visit = (node) => {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) return { found: true, offset: Array.from(node.data.slice(0, targetOffset)).filter((rune) => rune !== PAUSE_SYMBOL).length };
      return { found: true, offset: [...node.childNodes].slice(0, targetOffset).reduce((total, child) => total + editorNodeUnits(child), 0) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".lyrics-time-mark, .lyrics-pause-mark, .lyrics-play-cursor")) return { found: false, offset: editorNodeUnits(node) };
    let total = 0;
    for (const child of node.childNodes) {
      const result = visit(child);
      if (result.found) return { found: true, offset: total + result.offset };
      total += result.offset;
    }
    return { found: false, offset: total };
  };
  return visit(lyricsEditor).offset;
}

function currentLyricsSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !lyricsEditor.contains(selection.anchorNode) || !lyricsEditor.contains(selection.focusNode)) return state.lyricsSelection;
  const anchor = editorOffsetFromPoint(selection.anchorNode, selection.anchorOffset);
  const focus = editorOffsetFromPoint(selection.focusNode, selection.focusOffset);
  const focusPauses = editorPauseCountFromPoint(selection.focusNode, selection.focusOffset);
  const range = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  state.lyricsCursor = focus;
  state.lyricsCursorPauseCount = focusPauses;
  state.lyricsSelection = range;
  return range;
}

function currentLyricsCursor() {
  currentLyricsSelection();
  return { offset: state.lyricsCursor, pauseCount: state.lyricsCursorPauseCount };
}

function lyricMarkerPauseCount(marker) {
  const markerIndex = state.timedContent.markers.indexOf(marker);
  const earlierAtOffset = state.timedContent.markers
    .slice(0, markerIndex)
    .filter((candidate) => candidate.offset === marker.offset).length;
  return lyricPauseCountBeforeOffset(marker.offset) + (earlierAtOffset ? lyricPauseCountAtOffset(marker.offset) : 0);
}

function lyricMarkerAtCursor() {
  if (state.timedContent.markers.includes(state.selectedLyricMarker)) return state.selectedLyricMarker;
  const { offset, pauseCount } = currentLyricsCursor();
  const atOffset = state.timedContent.markers.filter((marker) => marker.offset === offset);
  const afterPause = pauseCount > lyricPauseCountBeforeOffset(offset);
  return afterPause ? atOffset.at(-1) : atOffset[0];
}

function selectLyricMarker(marker, event) {
  event.preventDefault();
  event.stopPropagation();
  state.selectedLyricMarker = marker;
  const pauseCount = lyricMarkerPauseCount(marker);
  state.lyricsCursor = marker.offset;
  state.lyricsCursorPauseCount = pauseCount;
  state.lyricsSelection = { start: marker.offset, end: marker.offset };
  renderLyricsEditor(false);
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(marker.offset, marker.offset, pauseCount);
  if (liveLyricsCursor.checked) seekPreviewToLyricsCursor();
}

function updateLyricSectionAction() {
  const button = document.querySelector("[data-toggle-lyric-section]");
  const selection = state.lyricsSelection;
  const inside = collapsedLyricRanges().some((range) => selection.start >= range.start && selection.end <= range.end);
  button.textContent = inside ? "Reveal section" : "Collapse selection";
}

function editorPointAtOffset(targetOffset, targetPauseCount = lyricPauseCountBeforeOffset(targetOffset)) {
  let remaining = Math.max(0, targetOffset);
  let remainingPauses = Math.max(0, targetPauseCount);
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const runes = Array.from(node.data);
      let units = 0;
      for (let codeUnit = 0; codeUnit < node.data.length; codeUnit += 1) {
        if (units >= remaining && !remainingPauses) return { node, offset: codeUnit };
        const rune = String.fromCodePoint(node.data.codePointAt(codeUnit));
        if (rune !== PAUSE_SYMBOL) units += 1;
        if (rune.length === 2) codeUnit += 1;
      }
      if (units >= remaining && !remainingPauses) return { node, offset: node.data.length };
      remaining -= units;
      return null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".lyrics-time-mark, .lyrics-play-cursor")) return null;
    if (node.matches(".lyrics-pause-mark")) {
      if (remainingPauses) remainingPauses -= 1;
      return null;
    }
    if (node.tagName === "BR") {
      if (!remaining) return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
      remaining -= 1;
      return null;
    }
    for (let index = 0; index < node.childNodes.length; index += 1) {
      if (!remaining && !remainingPauses) return { node, offset: index };
      const child = node.childNodes[index];
      const point = visit(child);
      if (point) return point;
    }
    if (!remaining && !remainingPauses) return { node, offset: node.childNodes.length };
    return null;
  };
  return visit(lyricsEditor) || { node: lyricsEditor, offset: lyricsEditor.childNodes.length };
}

function restoreLyricsSelection(start, end = start, endPauseCount = lyricPauseCountBeforeOffset(end)) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const startPoint = editorPointAtOffset(start, start === end ? endPauseCount : lyricPauseCountBeforeOffset(start));
  const endPoint = editorPointAtOffset(end, endPauseCount);
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function keepLyricsCaretVisible() {
  requestAnimationFrame(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !lyricsEditor.contains(selection.anchorNode)) return;
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    const editor = lyricsEditor.getBoundingClientRect();
    if (caret.top < editor.top) lyricsEditor.scrollTop -= editor.top - caret.top;
    else if (caret.bottom > editor.bottom) lyricsEditor.scrollTop += caret.bottom - editor.bottom;
  });
}

function readLyricsEditor() {
  const runes = [];
  const markers = [];
  const pauses = [];
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      Array.from(node.data).forEach((rune) => {
        if (rune === PAUSE_SYMBOL) pauses.push(runes.length);
        else runes.push(rune);
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(".lyrics-time-mark")) {
      markers.push({ offset: runes.length, time_ms: Number(node.dataset.timeMs) || 0 });
      return;
    }
    if (node.matches(".lyrics-pause-mark")) {
      pauses.push(runes.length);
      return;
    }
    if (node.matches(".lyrics-play-cursor")) return;
    if (node.tagName === "BR") {
      runes.push("\n");
      return;
    }
    [...node.childNodes].forEach(visit);
  };
  [...lyricsEditor.childNodes].forEach(visit);
  return { text: runes.join("").replace(/\r\n?/g, "\n"), markers, pauses: [...new Set(pauses)].sort((left, right) => left - right) };
}

function renderLyricsEditor(preserveSelection = document.activeElement === lyricsEditor) {
  const text = state.timedContent.text;
  if (!text) {
    lyricsEditor.replaceChildren();
    return;
  }
  const selection = preserveSelection ? currentLyricsSelection() : state.lyricsSelection;
  const cursor = { offset: state.lyricsCursor, pauseCount: state.lyricsCursorPauseCount };
  const markers = new Map();
  state.timedContent.markers.forEach((marker) => {
    const list = markers.get(marker.offset) || [];
    list.push(marker);
    markers.set(marker.offset, list);
  });
  const pauses = new Map();
  state.timedContent.pauses.forEach((offset) => pauses.set(offset, (pauses.get(offset) || 0) + 1));
  const fragment = document.createDocumentFragment();
  const runes = Array.from(text);
  const collapsed = collapsedLyricRanges();
  let parent = fragment;
  let activeRange = null;
  const appendMarker = (marker) => {
    const mark = document.createElement("span");
    mark.className = `lyrics-time-mark${marker === state.selectedLyricMarker ? " is-selected" : ""}`;
    mark.contentEditable = "false";
    mark.dataset.timeMs = String(marker.time_ms);
    mark.dataset.markerIndex = String(state.timedContent.markers.indexOf(marker));
    mark.title = lyricMarkerCaption(marker, state.timedContent.markers.indexOf(marker), state.timedContent.markers, pauses, runes);
    mark.addEventListener("pointerdown", (event) => selectLyricMarker(marker, event));
    parent.append(mark);
  };
  const appendPlaybackCursor = () => {
    const cursor = document.createElement("span");
    cursor.className = "lyrics-play-cursor";
    cursor.contentEditable = "false";
    cursor.setAttribute("aria-hidden", "true");
    parent.append(cursor);
  };
  for (let offset = 0; offset <= runes.length; offset += 1) {
    const nextRange = collapsed.find((range) => offset >= range.start && offset < range.end) || null;
    if (nextRange !== activeRange) {
      activeRange = nextRange;
      if (activeRange) {
        const wrapper = document.createElement("span");
        wrapper.className = "lyrics-collapsed";
        wrapper.title = "Collapsed section";
        fragment.append(wrapper);
        parent = wrapper;
      } else parent = fragment;
    }
    const offsetMarkers = markers.get(offset) || [];
    const pauseCount = pauses.get(offset) || 0;
    const showPlaybackCursor = !liveLyricsCursor.checked && state.lyricsPlaybackOffset === offset;
    const playbackPauseCount = Math.max(0, state.lyricsPlaybackPauseCount - lyricPauseCountBeforeOffset(offset));
    if (pauseCount) offsetMarkers.slice(0, 1).forEach(appendMarker);
    else offsetMarkers.forEach(appendMarker);
    if (showPlaybackCursor && playbackPauseCount === 0) appendPlaybackCursor();
    for (let index = 0; index < pauseCount; index += 1) {
      const pause = document.createElement("span");
      pause.className = "lyrics-pause-mark";
      pause.contentEditable = "false";
      pause.title = "Pause";
      pause.textContent = PAUSE_SYMBOL;
      parent.append(pause);
      if (showPlaybackCursor && playbackPauseCount === index + 1 && index + 1 < pauseCount) appendPlaybackCursor();
    }
    if (pauseCount) offsetMarkers.slice(1).forEach(appendMarker);
    if (showPlaybackCursor && pauseCount && playbackPauseCount >= pauseCount) appendPlaybackCursor();
    if (offset < runes.length) parent.append(document.createTextNode(runes[offset]));
  }
  lyricsEditor.replaceChildren(fragment);
  if (liveLyricsCursor.checked && state.lyricsPlaybackOffset >= 0) {
    state.lyricsCursor = state.lyricsPlaybackOffset;
    state.lyricsCursorPauseCount = state.lyricsPlaybackPauseCount;
    state.lyricsSelection = { start: state.lyricsCursor, end: state.lyricsCursor };
    lyricsEditor.focus({ preventScroll: true });
    restoreLyricsSelection(state.lyricsCursor, state.lyricsCursor, state.lyricsCursorPauseCount);
    keepLyricsCaretVisible();
  } else if (preserveSelection) {
    if (selection.start === selection.end) restoreLyricsSelection(cursor.offset, cursor.offset, cursor.pauseCount);
    else restoreLyricsSelection(selection.start, selection.end);
  }
  updateLyricSectionAction();
}

function renderTimedList() {
  clearSongs.disabled = !state.timedContent.entries.length;
  if (!state.timedContent.entries.length) {
    timedList.innerHTML = '<p class="timed-empty">No songs yet.</p>';
    return;
  }
  const rows = [];
  state.timedContent.entries.forEach((entry, index) => {
    const row = document.createElement("div");
    const time = document.createElement("time");
    const input = document.createElement("input");
    const remove = document.createElement("button");
    row.className = "timed-entry";
    time.textContent = formatMarkerTime(entry.time_ms);
    input.value = entry.text;
    input.maxLength = 180;
    input.setAttribute("aria-label", `Song ${index + 1} name`);
    input.addEventListener("input", () => { entry.text = input.value; });
    remove.type = "button";
    remove.className = "quiet-button";
    remove.textContent = "−";
    remove.setAttribute("aria-label", `Remove song ${index + 1}`);
    remove.addEventListener("click", () => {
      state.timedContent.entries.splice(index, 1);
      renderTimedEditor();
    });
    row.append(time, input, remove);
    rows.push(row);
    const following = state.timedContent.entries[index + 1];
    if (!following) return;
    const insertRow = document.createElement("div");
    const insert = document.createElement("button");
    const hasRoom = following.time_ms - entry.time_ms > 1;
    insertRow.className = "timed-entry-insert";
    insert.type = "button";
    insert.textContent = "+";
    insert.disabled = !hasRoom;
    insert.setAttribute("aria-label", `Add song between ${index + 1} and ${index + 2}`);
    insert.title = hasRoom ? "Add song between these markers" : "Markers need at least 2 milliseconds between them";
    insert.addEventListener("click", () => {
      const timeMS = entry.time_ms + Math.floor((following.time_ms - entry.time_ms) / 2);
      state.timedContent.entries.splice(index + 1, 0, { text: "", time_ms: timeMS });
      renderTimedEditor();
      timedList.querySelectorAll(".timed-entry input")[index + 1]?.focus();
    });
    insertRow.append(insert);
    rows.push(insertRow);
  });
  timedList.replaceChildren(...rows);
}

function renderTimelineNavigator() {
  const { start, end } = state.previewView;
  const trackWidth = previewNavigator.clientWidth;
  const handleWidth = timelineWindow.querySelector("button")?.getBoundingClientRect().width || 14;
  const visualWidth = Math.min(trackWidth, Math.max((end - start) * trackWidth, handleWidth * 3));
  const center = ((start + end) / 2) * trackWidth;
  timelineWindow.style.left = `${Math.max(0, Math.min(trackWidth - visualWidth, center - visualWidth / 2))}px`;
  timelineWindow.style.width = `${visualWidth}px`;
}

function seekPreviewAtClientX(clientX) {
  const bounds = uploadWaveform.getBoundingClientRect();
  if (!bounds.width || !previewDurationSeconds()) return;
  const local = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
  const full = state.previewView.start + local * (state.previewView.end - state.previewView.start);
  previewAudio.currentTime = full * previewDurationSeconds();
  paintPreviewProgress();
}

function seekPreviewAtMarker(event, marker) {
  if (event.detail) seekPreviewAtClientX(event.clientX);
  else {
    previewAudio.currentTime = Math.min(marker.time_ms / 1000, previewDurationSeconds());
    paintPreviewProgress();
  }
}

function timelineMarkerGroup(markers, index) {
  if (form.elements.kind.value !== "song") return { start: index, end: index };
  let start = index;
  let end = index;
  while (start > 0 && markers[start - 1].time_ms === markers[index].time_ms && markers[start - 1].offset !== markers[index].offset) start -= 1;
  while (end + 1 < markers.length && markers[end + 1].time_ms === markers[index].time_ms && markers[end + 1].offset !== markers[index].offset) end += 1;
  return { start, end };
}

function moveTimelineMarker(markers, index, desired, original) {
  const group = timelineMarkerGroup(markers, index);
  const minimum = group.start ? markers[group.start - 1].time_ms + 1 : 0;
  let next = Math.max(minimum, desired);
  if (!shiftFollowing.checked && group.end + 1 < markers.length) next = Math.min(next, markers[group.end + 1].time_ms - 1);
  let delta = next - original[group.start];
  if (shiftFollowing.checked && form.elements.kind.value === "song" && markers.length > 1) {
    delta = Math.min(delta, original.at(-1) - 1 - original.at(-2));
  }
  if (shiftFollowing.checked) {
    for (let following = group.start; following < markers.length; following += 1) {
      if (form.elements.kind.value === "song" && following === markers.length - 1) break;
      markers[following].time_ms = Math.max(0, original[following] + delta);
    }
  } else {
    for (let grouped = group.start; grouped <= group.end; grouped += 1) markers[grouped].time_ms = next;
  }
  updateTimelineCuePositions();
  if (form.elements.kind.value === "set") renderTimedList();
  else renderLyricsEditor();
}

function bindTimelineCue(button, marker, index, markers) {
  button.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    seekPreviewAtMarker(event, marker);
  });
  if (button.classList.contains("is-end")) {
    button.addEventListener("click", (event) => seekPreviewAtMarker(event, marker));
    return;
  }
  button.addEventListener("click", (event) => {
    if (!event.detail) seekPreviewAtMarker(event, marker);
  });
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const step = event.shiftKey ? 100 : 1000;
    const original = markers.map((candidate) => candidate.time_ms);
    moveTimelineMarker(markers, index, marker.time_ms + direction * step, original);
    renderTimelineCues();
    previewCues.querySelector(`[data-marker-index="${index}"]`)?.focus();
  });
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const original = markers.map((candidate) => candidate.time_ms);
    let dragged = false;
    button.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (Math.abs(moveEvent.clientX - startX) >= 3) dragged = true;
      if (!dragged) return;
      const bounds = uploadWaveform.getBoundingClientRect();
      const local = Math.max(0, Math.min(1, (moveEvent.clientX - bounds.left) / bounds.width));
      const desired = Math.round((state.previewView.start + local * (state.previewView.end - state.previewView.start)) * previewDurationSeconds() * 1000);
      moveTimelineMarker(markers, index, desired, original);
    };
    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", finish);
      button.removeEventListener("pointercancel", finish);
      if (!dragged && finishEvent.type === "pointerup") seekPreviewAtClientX(finishEvent.clientX);
      renderTimelineCues();
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
  });
}

function updateTimelineCuePositions() {
  const markers = activeTimelineMarkers();
  const pauseCounts = form.elements.kind.value === "song" ? lyricPauseCounts() : null;
  const lyricRunes = form.elements.kind.value === "song" ? Array.from(state.timedContent.text) : null;
  const durationMS = previewDurationSeconds() * 1000;
  const { start, end } = state.previewView;
  const span = end - start;
  previewCues.querySelectorAll(".timeline-cue").forEach((button) => {
    const index = Number(button.dataset.markerIndex);
    const marker = markers[index];
    if (!marker || !durationMS) {
      button.hidden = true;
      return;
    }
    const ratio = Math.min(marker.time_ms, durationMS) / durationMS;
    button.hidden = ratio < start || ratio > end;
    button.style.left = `${(ratio - start) / span * 100}%`;
    const labels = timelineCueLabels(marker, index, markers, pauseCounts, lyricRunes);
    button.title = labels.title;
    button.setAttribute("aria-label", labels.ariaLabel);
  });
}

function renderTimelineCues() {
  const markers = activeTimelineMarkers();
  const pauseCounts = form.elements.kind.value === "song" ? lyricPauseCounts() : null;
  const lyricRunes = form.elements.kind.value === "song" ? Array.from(state.timedContent.text) : null;
  const durationMS = previewDurationSeconds() * 1000;
  if (!durationMS || !markers.length) {
    previewCues.replaceChildren();
    return;
  }
  const buttons = [];
  markers.forEach((marker, index) => {
    const button = document.createElement("button");
    const isSongEnd = form.elements.kind.value === "song" && index === markers.length - 1 && marker.offset === Array.from(state.timedContent.text).length;
    button.type = "button";
    button.className = `timeline-cue${isSongEnd ? " is-end" : ""}`;
    button.dataset.markerIndex = String(index);
    button.style.zIndex = marker.time_ms >= durationMS ? String(markers.length - index + 2) : String(index + 2);
    const labels = timelineCueLabels(marker, index, markers, pauseCounts, lyricRunes);
    button.title = labels.title;
    button.setAttribute("aria-label", labels.ariaLabel);
    bindTimelineCue(button, marker, index, markers);
    buttons.push(button);
  });
  previewCues.replaceChildren(...buttons);
  updateTimelineCuePositions();
}

function renderTimedEditor() {
  renderTimelineNavigator();
  renderTimelineCues();
  if (form.elements.kind.value === "set") renderTimedList();
  else renderLyricsEditor();
}

function addSongs(lines) {
  const names = lines.map((line) => line.trim()).filter(Boolean);
  if (!names.length) return;
  let time = state.timedContent.entries.length ? state.timedContent.entries.at(-1).time_ms + 180_000 : 0;
  names.forEach((text) => {
    state.timedContent.entries.push({ text, time_ms: time });
    time += 180_000;
  });
  songListInput.value = "";
  renderTimedEditor();
}

function ensureInitialLyricsMarkers() {
  const length = Array.from(state.timedContent.text).length;
  if (!length) return;
  if (!state.timedContent.markers.some((marker) => marker.offset === 0)) state.timedContent.markers.push({ offset: 0, time_ms: 0 });
  syncLyricsEndMarker();
}

function syncLyricsEndMarker(durationSeconds = previewDurationSeconds()) {
  if (form.elements.kind.value !== "song") return;
  const length = Array.from(state.timedContent.text).length;
  const durationMS = Math.round(durationSeconds * 1000);
  if (!length || !durationMS) return;
  sortLyricsMarkers();
  const end = state.timedContent.markers.at(-1);
  if (end?.offset === length) {
    // Never pull stored overflow timing backwards; equal existing times can be an intentional collapsed section.
    end.time_ms = Math.max(end.time_ms, durationMS);
  } else {
    state.timedContent.markers.push({ offset: length, time_ms: Math.max(durationMS, (end?.time_ms ?? -1) + 1) });
  }
}

function setMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("is-error", error);
  message.setAttribute("role", error ? "alert" : "status");
}

function setAssetStatus(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle("is-error", error);
  element.setAttribute("role", error ? "alert" : "status");
}

function setProgress(element, value, indeterminate = false) {
  element.hidden = false;
  element.classList.toggle("is-indeterminate", indeterminate);
  if (indeterminate) {
    element.removeAttribute("aria-valuenow");
  } else {
    const normalized = Math.max(0, Math.min(100, Math.round(value)));
    element.setAttribute("aria-valuenow", String(normalized));
    element.style.setProperty("--progress", `${normalized}%`);
  }
}

function hideProgress(element) {
  element.hidden = true;
  element.classList.remove("is-indeterminate");
  element.removeAttribute("aria-valuenow");
}

function uploadFile(kind, file, onProgress) {
  activeUploads[kind]?.abort();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    activeUploads[kind] = request;
    request.open("POST", `/api/admin/uploads/${kind}`);
    request.responseType = "json";
    request.timeout = 60 * 60 * 1000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total * 100);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve(request.response);
      else reject(new Error(request.response?.error || `${kind} upload failed`));
    });
    request.addEventListener("error", () => reject(new Error(`${kind} upload was interrupted`)));
    request.addEventListener("timeout", () => reject(new Error(`${kind} upload timed out`)));
    request.addEventListener("abort", () => reject(new DOMException(`${kind} upload superseded`, "AbortError")));
    request.addEventListener("loadend", () => {
      if (activeUploads[kind] === request) activeUploads[kind] = null;
    });
    const data = new FormData();
    data.append(kind, file);
    request.send(data);
  });
}

function setKind(kind, guessed = false) {
  const input = form.querySelector(`[name="kind"][value="${kind}"]`);
  if (input) input.checked = true;
  setFields.hidden = kind !== "set";
  setTimedFields.hidden = kind !== "set";
  songTimedFields.hidden = kind !== "song";
  liveLyricsCursorToggle.hidden = kind !== "song";
  timedHeading.textContent = kind === "set" ? "Set songs" : "Lyrics timing";
  document.querySelector("[data-kind-hint]").textContent = guessed
    ? `${kind === "set" ? "Set" : "Song"} suggested from the uploaded duration. You can switch it.`
    : "12:00 and longer is suggested as a set.";
  renderTagSuggestions(kind);
  renderTimedEditor();
}

function selectedTags() {
  const seen = new Set();
  return form.elements.tags.value.split(",").map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

function popularTags(kind) {
  const counts = new Map();
  (state.catalog[kind] || []).forEach((item) => (item.tags || []).forEach((rawTag) => {
    const tag = String(rawTag).trim();
    const key = tag.toLocaleLowerCase();
    if (!key) return;
    const entry = counts.get(key) || { tag, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }));
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    .slice(0, 10);
}

function renderTagSuggestions(kind = form.elements.kind.value, focusKey = "") {
  const selected = selectedTags();
  const selectedKeys = new Set(selected.map((tag) => tag.toLocaleLowerCase()));
  const buttons = popularTags(kind).map(({ tag, count }) => {
    const button = document.createElement("button");
    const key = tag.toLocaleLowerCase();
    const active = selectedKeys.has(key);
    button.type = "button";
    button.className = "tag-suggestion";
    button.dataset.tagKey = key;
    button.textContent = tag;
    button.title = `${count} ${count === 1 ? "track" : "tracks"}`;
    button.setAttribute("aria-pressed", String(active));
    button.disabled = selected.length >= 3 && !active;
    button.addEventListener("click", () => {
      const tags = selectedTags();
      const index = tags.findIndex((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase());
      if (index >= 0) tags.splice(index, 1);
      else if (tags.length < 3) tags.push(tag);
      form.elements.tags.value = tags.join(", ");
      renderTagSuggestions(kind, key);
    });
    return button;
  });
  tagSuggestions.replaceChildren(...buttons);
  tagSuggestions.setAttribute("aria-label", `Popular ${kind} tags`);
  if (focusKey) buttons.find((button) => button.dataset.tagKey === focusKey)?.focus();
}

function setCoverTransform(position = "50% 50%", zoom = 1) {
  const values = TouchzoukUI.coverValues({ cover_position: position, cover_zoom: zoom });
  state.coverTransform = values;
  TouchzoukUI.applyCoverCrop(coverPreview, { cover_position: `${values.x}% ${values.y}%`, cover_zoom: values.zoom });
}

function interpolatedWaveform(source, start, end, count) {
  if (!source.length || count < 1) return [];
  if (source.length === 1) return Array.from({ length: count }, () => source[0]);
  const first = start * (source.length - 1);
  const last = end * (source.length - 1);
  return Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? first : first + (last - first) * index / (count - 1);
    const left = Math.floor(position);
    const right = Math.min(source.length - 1, left + 1);
    const fraction = position - left;
    return source[left] + (source[right] - source[left]) * fraction;
  });
}

function paintPreviewWaveform() {
  const bounds = uploadWaveform.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width || 420));
  const height = Math.max(1, Math.floor(bounds.height || 52));
  const ratio = window.devicePixelRatio || 1;
  uploadWaveform.width = Math.floor(width * ratio);
  uploadWaveform.height = Math.floor(height * ratio);
  uploadWaveform.style.height = `${height}px`;
  const context = uploadWaveform.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const source = state.previewWaveform.length ? state.previewWaveform : Array.from({ length: 180 }, () => 0);
  const targetCount = Math.max(18, Math.floor(width / 4));
  const visibleSamples = (state.previewView.end - state.previewView.start) * source.length;
  let bins;
  if (visibleSamples >= targetCount) {
    const startIndex = Math.floor(state.previewView.start * source.length);
    const endIndex = Math.max(startIndex + 1, Math.ceil(state.previewView.end * source.length));
    bins = TouchzoukUI.rebinWaveform(source.slice(startIndex, endIndex), targetCount);
  } else bins = interpolatedWaveform(source, state.previewView.start, state.previewView.end, targetCount);
  const fullProgress = previewAudio.duration ? previewAudio.currentTime / previewAudio.duration : 0;
  const progress = (fullProgress - state.previewView.start) / (state.previewView.end - state.previewView.start);
  const step = width / bins.length;
  const hoverIndex = state.previewHoverRatio == null ? -10 : Math.min(bins.length - 1, Math.floor(state.previewHoverRatio * bins.length));
  bins.forEach((point, index) => {
    const played = progress > 0 && (index + .5) / bins.length <= progress;
    const hover = TouchzoukUI.waveformHoverStyle(Math.abs(index - hoverIndex), played);
    const barHeight = Math.max(2, point * height * .82) * (hover?.scale || 1);
    context.fillStyle = played ? "#efe3ce" : "rgba(239, 227, 206, .32)";
    if (hover) {
      context.fillStyle = hover.fill;
      context.shadowColor = hover.shadow;
      context.shadowBlur = hover.blur;
    }
    context.fillRect(index * step, (height - barHeight) / 2, Math.max(1, step - 2), barHeight);
    context.shadowBlur = 0;
  });
}

function requestPreviewWaveformPaint() {
  if (previewWaveformFrame) return;
  previewWaveformFrame = requestAnimationFrame(() => {
    previewWaveformFrame = 0;
    paintPreviewWaveform();
  });
}

async function drawUploadWaveform(url, sequence = state.audioSequence) {
  state.waveformPreviewController?.abort();
  state.previewWaveform = [];
  paintPreviewWaveform();
  if (!url) return;
  const controller = new AbortController();
  state.waveformPreviewController = controller;
  try {
    const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
    if (!response.ok || sequence !== state.audioSequence) return;
    const points = (await response.json()).points || [];
    if (controller.signal.aborted || sequence !== state.audioSequence) return;
    state.previewWaveform = points;
    paintPreviewWaveform();
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      if (state.editing) setAssetStatus(audioStatus, "Waveform preview unavailable. Use Rebuild wave to retry.", true);
    }
  }
}

function setPreviewVolume(value) {
  previewAudio.volume = Number(value);
  previewVolume.value = value;
  previewVolume.style.setProperty("--volume-percent", `${Math.round(Number(value) * 100)}%`);
  previewVolume.setAttribute("aria-valuetext", `${Math.round(Number(value) * 100)} percent`);
}

function updatePreviewPlayState(unavailable = false) {
  previewPlay.classList.toggle("is-playing", state.previewPlayRequested);
  const action = state.previewPlayRequested ? "Pause" : "Play";
  previewPlay.setAttribute("aria-label", unavailable ? `${state.previewTitle} is unavailable` : `${action} ${state.previewTitle}`);
}

function setPreviewMetadata(title, duration) {
  state.previewTitle = title || "audio preview";
  const effectiveDuration = duration || (Number.isFinite(previewAudio.duration) ? previewAudio.duration : 0);
  previewDuration.textContent = formatDuration(effectiveDuration);
  previewSeek.setAttribute("aria-label", `Seek through ${state.previewTitle}`);
  previewSeek.setAttribute("aria-valuetext", `${formatDuration(previewAudio.currentTime)} of ${formatDuration(effectiveDuration)}`);
  syncLyricsEndMarker(effectiveDuration);
  updatePreviewPlayState();
}

function setPreviewSource(source, title, duration = 0) {
  if (!source) return;
  const absoluteSource = new URL(source, window.location.href).href;
  if (state.previewSource !== absoluteSource) {
    state.previewIntent += 1;
    state.previewPlayRequested = false;
    state.previewStarting = false;
    previewAudio.pause();
    state.previewSource = absoluteSource;
    state.previewView = { start: 0, end: 1 };
    setPreviewSticky(false);
    previewAudio.src = source;
    previewSeek.value = "0";
    previewCurrent.textContent = "00:00";
    renderTimedEditor();
  }
  previewPlay.disabled = false;
  setPreviewMetadata(title, duration);
  updatePreviewPlayState();
}

function clearPreview() {
  state.previewIntent += 1;
  state.previewPlayRequested = false;
  state.previewStarting = false;
  state.previewSeeking = false;
  state.previewSeekWasPlaying = false;
  state.previewSource = "";
  state.previewTitle = "audio preview";
  state.previewWaveform = [];
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  previewAudio.load();
  previewPlay.disabled = true;
  previewSeek.disabled = true;
  previewSeek.value = "0";
  previewCurrent.textContent = "00:00";
  previewDuration.textContent = "00:00";
  updatePreviewPlayState();
  paintPreviewWaveform();
}

async function playPreview() {
  if (!state.previewSource) return;
  const intent = ++state.previewIntent;
  state.previewPlayRequested = true;
  state.previewStarting = true;
  updatePreviewPlayState();
  try {
    await previewAudio.play();
    if (intent !== state.previewIntent) {
      if (!state.previewPlayRequested) previewAudio.pause();
      return;
    }
    state.previewStarting = false;
    if (!state.previewPlayRequested) previewAudio.pause();
  } catch {
    if (intent !== state.previewIntent) return;
    state.previewStarting = false;
    state.previewPlayRequested = false;
    updatePreviewPlayState(true);
  }
}

function pausePreview() {
  state.previewIntent += 1;
  state.previewStarting = false;
  state.previewPlayRequested = false;
  previewAudio.pause();
  updatePreviewPlayState();
}

function paintPreviewProgress() {
  const progress = previewAudio.duration ? previewAudio.currentTime / previewAudio.duration : 0;
  if (state.previewSticky && state.previewPlayRequested && !state.previewSeeking) centerPreviewView(progress, false);
  const { start, end } = state.previewView;
  const visibleProgress = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  previewSeek.value = String(Math.round(visibleProgress * 1000));
  previewCurrent.textContent = formatDuration(previewAudio.currentTime);
  const duration = formatDuration(previewAudio.duration);
  previewDuration.textContent = duration;
  previewSeek.setAttribute("aria-valuetext", `${previewCurrent.textContent} of ${duration}`);
  if (form.elements.kind.value === "song" && !liveLyricsNavigationKeys.size) {
    const cursor = lyricsCursorAtTime(previewAudio.currentTime * 1000);
    if (cursor.offset !== state.lyricsPlaybackOffset || cursor.pauseCount !== state.lyricsPlaybackPauseCount) {
      state.lyricsPlaybackOffset = cursor.offset;
      state.lyricsPlaybackPauseCount = cursor.pauseCount;
      if (!lyricsComposing) renderLyricsEditor();
    }
  }
  requestPreviewWaveformPaint();
}

function animatePreviewPlayback() {
  if (previewPlaybackFrame || !state.previewPlayRequested) return;
  const frame = () => {
    previewPlaybackFrame = 0;
    if (!state.previewPlayRequested) return;
    paintPreviewProgress();
    previewPlaybackFrame = requestAnimationFrame(frame);
  };
  previewPlaybackFrame = requestAnimationFrame(frame);
}

function stopPreviewAnimation() {
  if (previewPlaybackFrame) cancelAnimationFrame(previewPlaybackFrame);
  previewPlaybackFrame = 0;
}

setPreviewVolume(previewVolume.value);
previewVolume.addEventListener("input", () => setPreviewVolume(previewVolume.value));
previewPlay.addEventListener("click", () => state.previewPlayRequested ? pausePreview() : void playPreview());
previewAudio.addEventListener("loadedmetadata", () => {
  previewSeek.disabled = false;
  setPreviewMetadata(state.previewTitle, previewAudio.duration);
  paintPreviewProgress();
  renderTimedEditor();
});
previewAudio.addEventListener("timeupdate", paintPreviewProgress);
previewAudio.addEventListener("ended", () => {
  state.previewPlayRequested = false;
  stopPreviewAnimation();
  updatePreviewPlayState();
});
previewAudio.addEventListener("play", () => {
  if (!state.previewPlayRequested) {
    previewAudio.pause();
    return;
  }
  animatePreviewPlayback();
  updatePreviewPlayState();
});
previewAudio.addEventListener("pause", () => {
  if (!state.previewStarting && !state.previewSeeking) state.previewPlayRequested = false;
  if (!state.previewPlayRequested) stopPreviewAnimation();
  updatePreviewPlayState();
});
TouchzoukUI.bindSeeker({
  input: previewSeek,
  surface: uploadWaveform,
  onSeekStart: () => {
    state.previewSeekWasPlaying = state.previewPlayRequested;
    state.previewSeeking = true;
  },
  onSeek: (progress) => {
    if (!previewAudio.duration) return;
    const fullProgress = state.previewView.start + progress * (state.previewView.end - state.previewView.start);
    previewSeek.value = String(Math.round(fullProgress * 1000));
    previewAudio.currentTime = fullProgress * previewAudio.duration;
    paintPreviewProgress();
    if (state.previewSeekWasPlaying && previewAudio.paused && !state.previewStarting) void playPreview();
  },
  onSeekEnd: () => {
    if (state.previewSeekWasPlaying) void playPreview();
    state.previewSeekWasPlaying = false;
    state.previewSeeking = false;
  },
});
previewSeek.addEventListener("click", (event) => {
  if (event.ctrlKey) focusLyricsAtPlayback();
});
previewSeek.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !previewAudio.duration) return;
  event.preventDefault();
  let progress = Number(previewSeek.value) / 1000;
  if (event.key === "Home") progress = 0;
  else if (event.key === "End") progress = 1;
  else progress += (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? .01 : .001);
  const { start, end } = state.previewView;
  previewAudio.currentTime = (start + Math.max(0, Math.min(1, progress)) * (end - start)) * previewAudio.duration;
  paintPreviewProgress();
});
uploadWaveform.parentElement.addEventListener("pointermove", (event) => {
  state.previewHoverRatio = TouchzoukUI.pointerRatio(event, uploadWaveform);
  requestPreviewWaveformPaint();
});
uploadWaveform.parentElement.addEventListener("pointerleave", () => {
  state.previewHoverRatio = null;
  requestPreviewWaveformPaint();
});
window.addEventListener("resize", () => {
  paintPreviewWaveform();
  renderTimelineNavigator();
});

document.querySelector("[data-add-song]").addEventListener("click", () => {
  addSongs([songListInput.value.split(/\r?\n/).find((line) => line.trim()) || ""]);
});
document.querySelector("[data-add-song-list]").addEventListener("click", () => addSongs(songListInput.value.split(/\r?\n/)));
clearSongs.addEventListener("click", () => {
  state.timedContent.entries = [];
  songListInput.value = "";
  renderTimedEditor();
});
songListInput.addEventListener("paste", (event) => {
  const lines = event.clipboardData?.getData("text").split(/\r?\n/).filter((line) => line.trim()) || [];
  if (lines.length < 2) return;
  event.preventDefault();
  addSongs(lines);
});

function decodePlaylistText(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value.trim();
}

function virtualDJField(line, name) {
  const match = line.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodePlaylistText(match[1]) : "";
}

function playlistClockMS(value) {
  const parts = value.split(":").map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return ((parts[0] * 60 + parts[1]) * 60 + (parts[2] || 0)) * 1000;
}

function parseVirtualDJHistory(source) {
  const lines = source.replace(/^\ufeff/, "").split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXTVDJ:")) continue;
    const artist = virtualDJField(line, "artist");
    const title = virtualDJField(line, "title");
    const remix = virtualDJField(line, "remix");
    const path = lines[index + 1]?.trim() || "";
    const filename = path.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") || "Untitled song";
    const display = [artist, title].filter(Boolean).join(" — ") || title || filename;
    records.push({
      text: remix ? `${display} (${remix})` : display,
      clock_ms: playlistClockMS(virtualDJField(line, "time")),
    });
  }
  if (!records.length) return [];
  let previousClock = records[0].clock_ms;
  let firstClock = previousClock;
  let previousOffset = -1;
  return records.map((record) => {
    let clock = record.clock_ms;
    if (clock == null || firstClock == null) {
      firstClock ??= 0;
      clock = previousClock == null ? firstClock : previousClock + 180_000;
    }
    while (previousClock != null && clock < previousClock) clock += 24 * 60 * 60 * 1000;
    previousClock = clock;
    let offset = Math.max(0, clock - firstClock);
    if (offset <= previousOffset) offset = previousOffset + 1;
    previousOffset = offset;
    return { text: record.text, offset_ms: offset };
  });
}

async function appendVirtualDJFiles(files) {
  if (playlistInput.disabled) return;
  let added = 0;
  for (const file of files) {
    const records = parseVirtualDJHistory(await file.text());
    if (!records.length) continue;
    const base = state.timedContent.entries.length ? state.timedContent.entries.at(-1).time_ms + 180_000 : 0;
    const available = Math.max(0, 500 - state.timedContent.entries.length);
    records.slice(0, available).forEach((record) => {
      state.timedContent.entries.push({ text: record.text, time_ms: base + record.offset_ms });
      added += 1;
    });
    if (records.length > available) break;
  }
  if (!added) setMessage("No VirtualDJ history songs were found in that file.", true);
  else setMessage(`${added} playlist song${added === 1 ? "" : "s"} appended.`);
  playlistInput.value = "";
  renderTimedEditor();
}

playlistInput.addEventListener("change", () => void appendVirtualDJFiles([...playlistInput.files]));
["dragenter", "dragover"].forEach((eventName) => playlistDrop.addEventListener(eventName, (event) => {
  event.preventDefault();
  if (playlistInput.disabled) return;
  playlistDrop.classList.add("is-dragging");
}));
["dragleave", "drop"].forEach((eventName) => playlistDrop.addEventListener(eventName, (event) => {
  event.preventDefault();
  playlistDrop.classList.remove("is-dragging");
}));
playlistDrop.addEventListener("drop", (event) => void appendVirtualDJFiles([...event.dataTransfer.files]));

function sortLyricsMarkers() {
  state.timedContent.markers.sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
}

function lyricPauseCountBeforeOffset(offset) {
  const pauses = state.timedContent.pauses;
  let low = 0;
  let high = pauses.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (pauses[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lyricPauseCountAtOffset(offset) {
  return lyricPauseCountBeforeOffset(offset + 1) - lyricPauseCountBeforeOffset(offset);
}

function lyricMarkerTimingPoints() {
  const markers = [...state.timedContent.markers].sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  const usedAtOffset = new Map();
  return markers.map((marker) => {
    const index = usedAtOffset.get(marker.offset) || 0;
    usedAtOffset.set(marker.offset, index + 1);
    const pausesAtOffset = lyricPauseCountAtOffset(marker.offset);
    return {
      ...marker,
      position: marker.offset + lyricPauseCountBeforeOffset(marker.offset) + (pausesAtOffset && index > 0 ? pausesAtOffset : 0),
    };
  });
}

function lyricCursorAtTimingPosition(position) {
  const length = Array.from(state.timedContent.text).length;
  const pauses = state.timedContent.pauses;
  let pausesBefore = 0;
  for (let index = 0; index < pauses.length;) {
    const offset = pauses[index];
    let count = 1;
    while (index + count < pauses.length && pauses[index + count] === offset) count += 1;
    const pauseStart = offset + pausesBefore;
    if (position < pauseStart) {
      return { offset: Math.max(0, Math.min(length, Math.floor(position - pausesBefore))), pauseCount: pausesBefore };
    }
    if (position < pauseStart + count) {
      return { offset: Math.max(0, Math.min(length, offset)), pauseCount: pausesBefore + Math.floor(position - pauseStart) };
    }
    pausesBefore += count;
    index += count;
  }
  return { offset: Math.max(0, Math.min(length, Math.floor(position - pausesBefore))), pauseCount: pausesBefore };
}

function timeAtLyricsOffset(offset, pauseCountBeforeCursor = lyricPauseCountBeforeOffset(offset)) {
  const collapsed = collapsedLyricRanges().find((range) => offset >= range.start && offset <= range.end);
  if (collapsed) return collapsed.time_ms;
  const markers = lyricMarkerTimingPoints();
  const durationMS = Math.round(previewDurationSeconds() * 1000);
  const length = Array.from(state.timedContent.text).length;
  const position = offset + pauseCountBeforeCursor;
  const exact = markers.filter((marker) => marker.position === position).at(-1);
  if (exact) return exact.time_ms;
  const finalPosition = length + state.timedContent.pauses.length;
  const before = markers.filter((marker) => marker.position < position).at(-1) || { position: 0, time_ms: 0 };
  const after = markers.find((marker) => marker.position > position) || { position: finalPosition, time_ms: durationMS };
  if (after.position === before.position) return before.time_ms;
  return Math.round(before.time_ms + (after.time_ms - before.time_ms) * (position - before.position) / (after.position - before.position));
}

function lyricsCursorAtTime(timeMS) {
  const markers = lyricMarkerTimingPoints().sort((left, right) => left.time_ms - right.time_ms || left.position - right.position);
  if (!markers.length) return { offset: -1, pauseCount: 0 };
  let left = markers[0];
  for (const right of markers.slice(1)) {
    if (timeMS >= right.time_ms) {
      left = right;
      continue;
    }
    if (right.time_ms === left.time_ms) return lyricCursorAtTimingPosition(right.position);
    const progress = Math.max(0, (timeMS - left.time_ms) / (right.time_ms - left.time_ms));
    return lyricCursorAtTimingPosition(Math.floor(left.position + (right.position - left.position) * progress));
  }
  return lyricCursorAtTimingPosition(left.position);
}

function syncLyricsFromEditor() {
  const selection = currentLyricsSelection();
  const snapshot = readLyricsEditor();
  state.timedContent.text = snapshot.text;
  state.timedContent.markers = snapshot.markers;
  state.timedContent.pauses = snapshot.pauses;
  state.selectedLyricMarker = null;
  state.lyricsSelection = selection;
  if (!snapshot.text) {
    state.timedContent.markers = [];
    state.timedContent.pauses = [];
  } else {
    ensureInitialLyricsMarkers();
    syncLyricsEndMarker();
    sortLyricsMarkers();
  }
  if (form.elements.kind.value === "song" && state.lyricsPlaybackOffset >= 0) {
    const cursor = lyricsCursorAtTime(previewAudio.currentTime * 1000);
    state.lyricsPlaybackOffset = cursor.offset;
    state.lyricsPlaybackPauseCount = cursor.pauseCount;
  }
  renderTimedEditor();
}

function insertLyricsText(text) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !lyricsEditor.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text.replace(/\r\n?/g, "\n"));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  syncLyricsFromEditor();
}

lyricsEditor.addEventListener("compositionstart", () => { lyricsComposing = true; });
lyricsEditor.addEventListener("compositionend", () => {
  lyricsComposing = false;
  syncLyricsFromEditor();
});
lyricsEditor.addEventListener("input", () => { if (!lyricsComposing) syncLyricsFromEditor(); });
lyricsEditor.addEventListener("copy", (event) => copyLyricsSelection(event));
lyricsEditor.addEventListener("paste", (event) => {
  event.preventDefault();
  const encoded = event.clipboardData?.getData(LYRICS_CLIPBOARD_TYPE);
  if (encoded) {
    try {
      const payload = JSON.parse(encoded);
      if (payload?.version === 1) {
        insertLyricsPayload(payload);
        return;
      }
    } catch {
      // Fall through to plain text when clipboard metadata is invalid.
    }
  }
  insertLyricsText(event.clipboardData?.getData("text/plain") || "");
});
lyricsEditor.addEventListener("beforeinput", (event) => {
  if (event.inputType !== "insertParagraph") return;
  event.preventDefault();
  insertLyricsText("\n");
});

function addLyricMarkerAtCursor() {
  const length = Array.from(state.timedContent.text).length;
  if (!length) return;
  const { offset, pauseCount } = currentLyricsCursor();
  const timeMS = timeAtLyricsOffset(offset, pauseCount);
  const existing = state.timedContent.markers.filter((marker) => marker.offset === offset);
  let marker;
  let created = false;
  const afterPause = pauseCount > lyricPauseCountBeforeOffset(offset);
  if (state.timedContent.pauses.includes(offset) && existing.length === 1 && afterPause) {
    marker = { offset, time_ms: timeMS };
    state.timedContent.markers.push(marker);
    created = true;
  } else if (existing.length) marker = afterPause ? existing.at(-1) : existing[0];
  else {
    marker = { offset, time_ms: timeMS };
    state.timedContent.markers.push(marker);
    created = true;
  }
  state.timedContent.markers.sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  const index = state.timedContent.markers.indexOf(marker);
  const minimum = index ? state.timedContent.markers[index - 1].time_ms + 1 : 0;
  const maximum = state.timedContent.markers[index + 1]?.time_ms - 1;
  if (maximum !== undefined && minimum > maximum) {
    if (created) state.timedContent.markers.splice(index, 1);
    setMessage("There is no room for another marker at this position.", true);
  } else {
    marker.time_ms = Math.max(minimum, Math.min(maximum ?? timeMS, created ? marker.time_ms : timeMS));
    state.selectedLyricMarker = marker;
  }
  renderTimedEditor();
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(offset, offset, pauseCount);
}

function addLyricPauseAtCursor() {
  const cursor = currentLyricsCursor();
  const { offset } = cursor;
  let { pauseCount } = cursor;
  const added = !state.timedContent.pauses.includes(offset);
  if (added) state.timedContent.pauses.push(offset);
  state.timedContent.pauses.sort((left, right) => left - right);
  if (added) pauseCount = lyricPauseCountBeforeOffset(offset) + 1;
  state.selectedLyricMarker = null;
  renderLyricsEditor();
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(offset, offset, pauseCount);
}

function removeLyricMarkerAtCursor() {
  const { offset, pauseCount } = currentLyricsCursor();
  const last = state.timedContent.markers.length - 1;
  const target = lyricMarkerAtCursor();
  const index = state.timedContent.markers.indexOf(target);
  if (index < 0) {
    setMessage("There is no removable marker at this cursor position.", true);
    return;
  }
  if (index === 0 || index === last) {
    setMessage("The first and final markers cannot be removed.", true);
    return;
  }
  state.timedContent.markers.splice(index, 1);
  state.selectedLyricMarker = null;
  setMessage("");
  renderTimedEditor();
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(offset, offset, pauseCount);
}

function toggleCollapsedLyricsSection() {
  let selection = currentLyricsSelection();
  const existing = collapsedLyricRanges().find((range) => selection.start >= range.start && selection.end <= range.end);
  if (existing) {
    state.timedContent.markers = state.timedContent.markers.filter((marker) => !existing.markers.includes(marker));
    ensureInitialLyricsMarkers();
    syncLyricsEndMarker();
    sortLyricsMarkers();
    renderTimedEditor();
    restoreLyricsSelection(selection.start, selection.end);
    return;
  }
  if (selection.start === selection.end) {
    setMessage("Select lyrics to collapse, or place the cursor inside a collapsed section to reveal it.", true);
    return;
  }
  const runes = Array.from(state.timedContent.text);
  let start = selection.start;
  let end = selection.end;
  if (end > start && runes[end - 1] === "\n") end -= 1;
  while (start > 0 && runes[start - 1] !== "\n") start -= 1;
  while (end < runes.length && runes[end] !== "\n") end += 1;
  selection = { start, end };
  state.lyricsSelection = selection;
  const before = state.timedContent.markers.filter((marker) => marker.offset < selection.start).at(-1);
  const after = state.timedContent.markers.find((marker) => marker.offset > selection.end);
  const minimum = (before?.time_ms ?? -1) + 1;
  const maximum = (after?.time_ms ?? Math.round(previewDurationSeconds() * 1000)) - 1;
  const timeMS = Math.max(minimum, Math.min(maximum, timeAtLyricsOffset(selection.start)));
  if (timeMS > maximum) {
    setMessage("There is no timing room to collapse this selection.", true);
    return;
  }
  state.timedContent.markers = state.timedContent.markers.filter((marker) => marker.offset < selection.start || marker.offset > selection.end);
  state.timedContent.markers.push({ offset: selection.start, time_ms: timeMS }, { offset: selection.end, time_ms: timeMS });
  const lyricsLength = Array.from(state.timedContent.text).length;
  const durationMS = Math.round(previewDurationSeconds() * 1000);
  if (selection.end === lyricsLength && timeMS < durationMS) state.timedContent.markers.push({ offset: lyricsLength, time_ms: durationMS });
  sortLyricsMarkers();
  renderTimedEditor();
  restoreLyricsSelection(selection.start, selection.end);
}

function jumpToLyricsCursor() {
  seekPreviewToLyricsCursor(true);
}

function seekPreviewToLyricsCursor(center = false, cursor = currentLyricsCursor()) {
  if (!previewDurationSeconds()) return;
  const { offset, pauseCount } = cursor;
  const timeMS = timeAtLyricsOffset(offset, pauseCount);
  previewAudio.currentTime = Math.max(0, Math.min(previewDurationSeconds(), timeMS / 1000));
  if (center) centerPreviewView(previewAudio.currentTime / previewDurationSeconds());
  paintPreviewProgress();
}

function focusLyricsAtPlayback() {
  if (form.elements.kind.value !== "song") return;
  const cursor = lyricsCursorAtTime(previewAudio.currentTime * 1000);
  if (cursor.offset < 0) return;
  state.selectedLyricMarker = null;
  state.lyricsPlaybackOffset = cursor.offset;
  state.lyricsPlaybackPauseCount = cursor.pauseCount;
  state.lyricsCursor = cursor.offset;
  state.lyricsCursorPauseCount = cursor.pauseCount;
  state.lyricsSelection = { start: cursor.offset, end: cursor.offset };
  renderLyricsEditor(false);
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(cursor.offset, cursor.offset, cursor.pauseCount);
}

function moveLyricMarkerAtCursor(direction, fine) {
  const marker = lyricMarkerAtCursor();
  const index = state.timedContent.markers.indexOf(marker);
  const finalIndex = state.timedContent.markers.length - 1;
  if (index <= 0 || index >= finalIndex) {
    setMessage("Place the cursor on a movable marker first.", true);
    return;
  }
  const { offset, pauseCount } = currentLyricsCursor();
  const step = fine ? 10 : 1000;
  const original = state.timedContent.markers.map((candidate) => candidate.time_ms);
  state.selectedLyricMarker = marker;
  moveTimelineMarker(state.timedContent.markers, index, marker.time_ms + direction * step, original);
  renderTimelineCues();
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(offset, offset, pauseCount);
  if (state.previewPlayRequested && !liveLyricsCursor.checked) {
    previewAudio.currentTime = Math.min(marker.time_ms / 1000, previewDurationSeconds());
    paintPreviewProgress();
    if (previewAudio.paused && !state.previewStarting) void playPreview();
  }
}

function selectedLyricsMarkers() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return [];
  if (selection.isCollapsed && state.timedContent.markers.includes(state.selectedLyricMarker)) {
    return [state.selectedLyricMarker];
  }
  if (selection.isCollapsed) {
    const marker = lyricMarkerAtCursor();
    return marker ? [marker] : [];
  }
  const range = selection.getRangeAt(0);
  return [...lyricsEditor.querySelectorAll(".lyrics-time-mark")]
    .filter((mark) => range.intersectsNode(mark))
    .map((mark) => state.timedContent.markers[Number(mark.dataset.markerIndex)])
    .filter(Boolean);
}

function lyricsPlainText(start, end) {
  const runes = Array.from(state.timedContent.text);
  const pauses = lyricPauseCounts();
  const result = [];
  for (let offset = start; offset <= end; offset += 1) {
    if (offset < end) result.push(PAUSE_SYMBOL.repeat(pauses.get(offset) || 0));
    if (offset < end) result.push(runes[offset] || "");
  }
  return result.join("");
}

function copyLyricsSelection(event) {
  if (!event.clipboardData) return;
  const selection = currentLyricsSelection();
  const markers = selectedLyricsMarkers();
  if (selection.start === selection.end && !markers.length) return;
  const text = Array.from(state.timedContent.text).slice(selection.start, selection.end).join("");
  const baseTime = markers.length && selection.start === selection.end
    ? markers[0].time_ms
    : timeAtLyricsOffset(selection.start);
  const payload = {
    version: 1,
    text,
    markers: markers.map((marker) => ({
      offset: marker.offset - selection.start,
      time_offset_ms: marker.time_ms - baseTime,
    })),
    pauses: state.timedContent.pauses
      .filter((offset) => offset >= selection.start && offset < selection.end)
      .map((offset) => offset - selection.start),
  };
  const plain = lyricsPlainText(selection.start, selection.end);
  event.preventDefault();
  event.clipboardData.setData("text/plain", plain);
  event.clipboardData.setData(LYRICS_CLIPBOARD_TYPE, JSON.stringify(payload));
}

// Keep copied timing intervals intact; move the whole group only enough to fit its new neighbors.
function fitPastedMarkers(markers, existing) {
  if (!markers.length) return markers;
  markers.sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  existing.sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  const first = markers[0];
  const last = markers.at(-1);
  const before = existing.filter((marker) => marker.offset < first.offset).at(-1);
  const after = existing.find((marker) => marker.offset > last.offset);
  const durationMS = Math.round(previewDurationSeconds() * 1000);
  const minimumDelta = (before ? before.time_ms + 1 : 0) - first.time_ms;
  const maximumDelta = (after ? after.time_ms - 1 : durationMS) - last.time_ms;
  if (minimumDelta > maximumDelta) return [];
  const delta = Math.max(minimumDelta, Math.min(0, maximumDelta));
  markers.forEach((marker) => { marker.time_ms += delta; });
  return markers;
}

function insertLyricsPayload(payload) {
  const selection = currentLyricsSelection();
  const sourceRunes = Array.from(state.timedContent.text);
  const insertedRunes = Array.from(String(payload.text || ""));
  const removedLength = selection.end - selection.start;
  const offsetDelta = insertedRunes.length - removedLength;
  const startPauseCount = removedLength ? lyricPauseCountBeforeOffset(selection.start) : state.lyricsCursorPauseCount;
  const pasteTime = timeAtLyricsOffset(selection.start, startPauseCount);
  const existingMarkers = state.timedContent.markers.flatMap((marker) => {
    if (marker.offset >= selection.start && marker.offset < selection.end) return [];
    const atFinalMarker = marker.offset === sourceRunes.length && selection.end === sourceRunes.length;
    const followsInsertion = marker.offset > selection.end || marker.offset === selection.end && (removedLength > 0 || atFinalMarker);
    return [{ ...marker, offset: followsInsertion ? marker.offset + offsetDelta : marker.offset }];
  });
  const pastedMarkers = (Array.isArray(payload.markers) ? payload.markers : []).flatMap((marker) => {
    const relativeOffset = Number(marker.offset);
    const timeOffset = Number(marker.time_offset_ms);
    if (!Number.isInteger(relativeOffset) || relativeOffset < 0 || relativeOffset > insertedRunes.length || !Number.isFinite(timeOffset)) return [];
    return [{ offset: selection.start + relativeOffset, time_ms: Math.round(pasteTime + timeOffset) }];
  });
  const fittedMarkers = fitPastedMarkers(pastedMarkers, existingMarkers);
  const acceptedMarkers = fittedMarkers.filter((marker) => !existingMarkers.some(
    (existing) => existing.offset === marker.offset && existing.time_ms === marker.time_ms,
  ));
  const existingPauses = state.timedContent.pauses.flatMap((offset) => {
    if (offset >= selection.start && offset < selection.end) return [];
    return [offset > selection.end || offset === selection.end && removedLength > 0 ? offset + offsetDelta : offset];
  });
  const pastedPauses = (Array.isArray(payload.pauses) ? payload.pauses : []).flatMap((offset) => {
    const relativeOffset = Number(offset);
    return Number.isInteger(relativeOffset) && relativeOffset >= 0 && relativeOffset <= insertedRunes.length
      ? [selection.start + relativeOffset]
      : [];
  });
  state.timedContent.text = [
    ...sourceRunes.slice(0, selection.start),
    ...insertedRunes,
    ...sourceRunes.slice(selection.end),
  ].join("");
  state.timedContent.markers = [...existingMarkers, ...acceptedMarkers];
  state.timedContent.pauses = [...new Set([...existingPauses, ...pastedPauses])].sort((left, right) => left - right);
  state.selectedLyricMarker = null;
  ensureInitialLyricsMarkers();
  syncLyricsEndMarker();
  sortLyricsMarkers();
  const cursorOffset = selection.start + insertedRunes.length;
  state.lyricsCursor = cursorOffset;
  state.lyricsCursorPauseCount = lyricPauseCountBeforeOffset(cursorOffset);
  state.lyricsSelection = { start: cursorOffset, end: cursorOffset };
  renderTimedEditor();
  lyricsEditor.focus({ preventScroll: true });
  restoreLyricsSelection(cursorOffset, cursorOffset, state.lyricsCursorPauseCount);
  if (pastedMarkers.length && !fittedMarkers.length) setMessage("Text pasted, but its markers do not fit between the surrounding markers.", true);
}

document.querySelector("[data-add-lyric-marker]").addEventListener("click", addLyricMarkerAtCursor);
document.querySelector("[data-add-lyric-pause]").addEventListener("click", addLyricPauseAtCursor);
document.querySelector("[data-remove-lyric-marker]").addEventListener("click", removeLyricMarkerAtCursor);
document.querySelector("[data-toggle-lyric-section]").addEventListener("click", toggleCollapsedLyricsSection);
document.querySelector("[data-jump-lyric-cursor]").addEventListener("click", jumpToLyricsCursor);
function stopLiveLyricsNavigation(commitPending = false) {
  const pending = liveLyricsNavigationFrame;
  if (liveLyricsNavigationFrame) cancelAnimationFrame(liveLyricsNavigationFrame);
  liveLyricsNavigationFrame = 0;
  if (commitPending && pending && liveLyricsNavigationKeys.size) syncLiveLyricsNavigation();
  liveLyricsNavigationKeys.clear();
}

function syncLiveLyricsNavigation() {
  const selection = window.getSelection();
  const selectionInside = selection?.rangeCount && lyricsEditor.contains(selection.anchorNode) && lyricsEditor.contains(selection.focusNode);
  if (!liveLyricsCursor.checked || document.activeElement !== lyricsEditor && !selectionInside) return;
  state.selectedLyricMarker = null;
  currentLyricsSelection();
  updateLyricSectionAction();
  const cursor = currentLyricsCursor();
  state.lyricsPlaybackOffset = cursor.offset;
  state.lyricsPlaybackPauseCount = cursor.pauseCount;
  seekPreviewToLyricsCursor(false, cursor);
}

liveLyricsCursor.addEventListener("change", () => {
  state.selectedLyricMarker = null;
  if (liveLyricsCursor.checked) focusLyricsAtPlayback();
  else {
    stopLiveLyricsNavigation();
    renderLyricsEditor(false);
  }
});
lyricsEditor.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.code === "Space") {
    event.preventDefault();
    addLyricMarkerAtCursor();
    return;
  }
  if (event.ctrlKey && event.code === "KeyP") {
    event.preventDefault();
    addLyricPauseAtCursor();
    return;
  }
  if (event.ctrlKey && LYRIC_MARKER_MOVE_DIRECTIONS[event.code]) {
    event.preventDefault();
    moveLyricMarkerAtCursor(LYRIC_MARKER_MOVE_DIRECTIONS[event.code], event.shiftKey);
    return;
  }
  if (liveLyricsCursor.checked && !event.isComposing && !lyricsComposing && LYRIC_NAVIGATION_KEYS.has(event.key)) {
    liveLyricsNavigationKeys.add(event.key);
    if (liveLyricsNavigationFrame) cancelAnimationFrame(liveLyricsNavigationFrame);
    liveLyricsNavigationFrame = requestAnimationFrame(() => {
      liveLyricsNavigationFrame = 0;
      if (liveLyricsNavigationKeys.size) syncLiveLyricsNavigation();
    });
  }
  if (["Backspace", "Delete"].includes(event.key) && state.selectedLyricMarker) {
    event.preventDefault();
    removeLyricMarkerAtCursor();
  }
});
lyricsEditor.addEventListener("click", (event) => {
  if (!event.target.closest?.(".lyrics-time-mark")) state.selectedLyricMarker = null;
  currentLyricsSelection();
  updateLyricSectionAction();
  if (liveLyricsCursor.checked) seekPreviewToLyricsCursor();
});
lyricsEditor.addEventListener("keyup", (event) => {
  currentLyricsSelection();
  updateLyricSectionAction();
  const navigated = LYRIC_NAVIGATION_KEYS.has(event.key);
  if (navigated) state.selectedLyricMarker = null;
  if (liveLyricsCursor.checked && navigated) {
    if (liveLyricsNavigationFrame) {
      cancelAnimationFrame(liveLyricsNavigationFrame);
      liveLyricsNavigationFrame = 0;
      syncLiveLyricsNavigation();
    }
    liveLyricsNavigationKeys.delete(event.key);
  }
});
lyricsEditor.addEventListener("blur", () => stopLiveLyricsNavigation(true));
window.addEventListener("blur", () => stopLiveLyricsNavigation(true));

function minimumPreviewSpan() {
  const durationMS = Math.round(previewDurationSeconds() * 1000);
  return durationMS ? Math.min(1, 1 / durationMS) : 1;
}

function applyPreviewView() {
  paintPreviewWaveform();
  renderTimedEditor();
}

function centerPreviewView(progress, repaint = true) {
  const span = state.previewView.end - state.previewView.start;
  state.previewView.start = Math.max(0, Math.min(1 - span, progress - span / 2));
  state.previewView.end = state.previewView.start + span;
  if (repaint) applyPreviewView();
  else {
    renderTimelineNavigator();
    updateTimelineCuePositions();
  }
}

function setPreviewSticky(sticky) {
  state.previewSticky = sticky;
  timelineFollow.setAttribute("aria-pressed", String(sticky));
  if (sticky && previewDurationSeconds()) centerPreviewView(previewAudio.currentTime / previewDurationSeconds());
}

function zoomPreview(factor, anchorRatio = null) {
  const span = state.previewView.end - state.previewView.start;
  const nextSpan = Math.max(minimumPreviewSpan(), Math.min(1, span * factor));
  const playProgress = previewDurationSeconds() ? previewAudio.currentTime / previewDurationSeconds() : .5;
  const fullAnchor = anchorRatio == null
    ? (playProgress >= state.previewView.start && playProgress <= state.previewView.end ? playProgress : state.previewView.start + span / 2)
    : state.previewView.start + anchorRatio * span;
  const localAnchor = span ? (fullAnchor - state.previewView.start) / span : .5;
  state.previewView.start = Math.max(0, Math.min(1 - nextSpan, fullAnchor - localAnchor * nextSpan));
  state.previewView.end = state.previewView.start + nextSpan;
  if (state.previewSticky) centerPreviewView(playProgress);
  else applyPreviewView();
}

function panPreview(direction) {
  setPreviewSticky(false);
  const span = state.previewView.end - state.previewView.start;
  state.previewView.start = Math.max(0, Math.min(1 - span, state.previewView.start + direction * span * .12));
  state.previewView.end = state.previewView.start + span;
  applyPreviewView();
}

uploadWaveform.parentElement.addEventListener("wheel", (event) => {
  if (!previewDurationSeconds()) return;
  event.preventDefault();
  if (event.ctrlKey) zoomPreview(Math.exp(event.deltaY * .002), TouchzoukUI.pointerRatio(event, uploadWaveform));
  else panPreview(Math.sign(event.deltaY || event.deltaX));
}, { passive: false });

function bindNavigatorPart(part, mode) {
  const update = (original, delta) => {
    const minimumSpan = minimumPreviewSpan();
    if (mode === "start") state.previewView.start = Math.max(0, Math.min(original.end - minimumSpan, original.start + delta));
    else if (mode === "end") state.previewView.end = Math.min(1, Math.max(original.start + minimumSpan, original.end + delta));
    else {
      const span = original.end - original.start;
      state.previewView.start = Math.max(0, Math.min(1 - span, original.start + delta));
      state.previewView.end = state.previewView.start + span;
    }
    paintPreviewWaveform();
    renderTimedEditor();
  };
  part.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setPreviewSticky(false);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    update({ ...state.previewView }, direction * (event.shiftKey ? .01 : .002));
    part.focus();
  });
  part.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setPreviewSticky(false);
    const startX = event.clientX;
    const original = { ...state.previewView };
    part.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const width = previewNavigator.getBoundingClientRect().width;
      const delta = width ? (moveEvent.clientX - startX) / width : 0;
      update(original, delta);
    };
    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      part.removeEventListener("pointermove", move);
      part.removeEventListener("pointerup", finish);
      part.removeEventListener("pointercancel", finish);
    };
    part.addEventListener("pointermove", move);
    part.addEventListener("pointerup", finish);
    part.addEventListener("pointercancel", finish);
  });
}
bindNavigatorPart(document.querySelector("[data-timeline-start]"), "start");
bindNavigatorPart(document.querySelector("[data-timeline-drag]"), "drag");
bindNavigatorPart(document.querySelector("[data-timeline-end]"), "end");

function runTimelineAction(action) {
  if (!previewDurationSeconds()) return;
  if (action === "zoom-in") zoomPreview(.78);
  else if (action === "zoom-out") zoomPreview(1 / .78);
  else if (action === "left") panPreview(-1);
  else if (action === "right") panPreview(1);
}

function bindHoldAction(button) {
  const action = () => runTimelineAction(button.dataset.timelineAction);
  let delay = 0;
  let repeat = 0;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
    delay = 0;
    repeat = 0;
  };
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    action();
    delay = setTimeout(() => { repeat = setInterval(action, 55); }, 320);
  });
  ["pointerup", "pointercancel", "lostpointercapture", "blur"].forEach((eventName) => button.addEventListener(eventName, stop));
  button.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    action();
  });
  button.addEventListener("click", (event) => {
    if (!event.detail) action();
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}
document.querySelectorAll("[data-timeline-action]").forEach(bindHoldAction);
timelineFollow.addEventListener("contextmenu", (event) => event.preventDefault());
timelineFollow.addEventListener("click", () => setPreviewSticky(!state.previewSticky));

const TIMELINE_SHORTCUTS = {
  "+": "zoom-in",
  "=": "zoom-in",
  "-": "zoom-out",
  "[": "left",
  "]": "right",
};

document.addEventListener("keydown", (event) => {
  if (deleteDialog.open || !event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return;
  const shortcutKey = event.key.toLowerCase();
  const timelineAction = TIMELINE_SHORTCUTS[event.key]
    || (event.code === "NumpadAdd" ? "zoom-in" : event.code === "NumpadSubtract" ? "zoom-out" : "");
  const lyricsFocused = document.activeElement === lyricsEditor;
  let action = timelineAction && previewDurationSeconds() ? timelineAction : "";
  if (shortcutKey === "q" && !previewPlay.disabled) action = "play";
  else if (shortcutKey === "l" && !liveLyricsCursorToggle.hidden) action = "live-cursor";
  else if (shortcutKey === "m") action = "shift-markers";
  else if (shortcutKey === "f" && previewDurationSeconds()) action = "follow-playhead";
  else if (shortcutKey === "h" && form.elements.kind.value === "song" && lyricsFocused) action = "toggle-section";
  else if (shortcutKey === "j" && form.elements.kind.value === "song" && lyricsFocused && previewDurationSeconds()) action = "jump-to-cursor";
  if (!action) return;
  event.preventDefault();
  if (event.repeat && !timelineAction) return;
  if (timelineAction) runTimelineAction(timelineAction);
  else if (action === "play") previewPlay.click();
  else if (action === "live-cursor") liveLyricsCursor.click();
  else if (action === "shift-markers") shiftFollowing.click();
  else if (action === "follow-playhead") timelineFollow.click();
  else if (action === "toggle-section") toggleCollapsedLyricsSection();
  else if (action === "jump-to-cursor") jumpToLyricsCursor();
});

async function pollAudio(uploadID, sequence) {
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    if (sequence !== state.audioSequence) return;
    const response = await fetch(`/api/admin/uploads/${uploadID}`);
    const upload = await response.json();
    if (sequence !== state.audioSequence) return;
    if (!response.ok) throw new Error(upload.error || "Could not read audio status");
    if (upload.state === "failed") throw new Error(upload.error || "Audio analysis failed");
    setPreviewSource(upload.asset_url, upload.title || upload.filename, upload.duration_seconds);
    if (upload.duration_seconds > 0) {
      if (!form.elements.title.value.trim() || form.elements.title.value === state.autoTitle) {
        form.elements.title.value = upload.title || "";
        state.autoTitle = form.elements.title.value;
      }
      if (!state.kindDirty) setKind(upload.suggested_kind, true);
      audioDrop.hidden = true;
      audioReady.hidden = false;
      coverUpload.hidden = false;
      document.querySelector("[data-audio-name]").textContent = upload.title || upload.filename;
      document.querySelector("[data-audio-detail]").textContent = `${formatDuration(upload.duration_seconds)} · metadata ready · building waveform`;
    }
    if (upload.state === "ready") {
      state.audioUpload = upload;
      audioDrop.hidden = true;
      audioReady.hidden = false;
      document.querySelector("[data-audio-name]").textContent = upload.title || upload.filename;
      document.querySelector("[data-audio-detail]").textContent = `${formatDuration(upload.duration_seconds)} · waveform ready`;
      setAssetStatus(audioStatus, "Audio ready to publish.");
      hideProgress(audioProgress);
      await drawUploadWaveform(upload.waveform_url, sequence);
      return;
    }
    setAssetStatus(audioStatus, upload.state === "waveform" ? "Metadata ready. Creating waveform…" : upload.state === "analyzing" ? "Extracting title and audio metadata…" : "Queued for analysis…");
    setProgress(audioProgress, 100, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Audio analysis timed out");
}

async function startAudioUpload(file) {
  state.editorGeneration += 1;
  submit.disabled = false;
  const sequence = ++state.audioSequence;
  state.kindDirty = false;
  state.audioUpload = null;
  clearPreview();
  void drawUploadWaveform("", sequence);
  audioReady.hidden = true;
  audioDrop.hidden = false;
  cancelEdit.hidden = false;
  setAssetStatus(audioStatus, "Uploading audio…");
  setProgress(audioProgress, 0);
  try {
    const upload = await uploadFile("audio", file, (percent) => {
      if (sequence !== state.audioSequence) return;
      setAssetStatus(audioStatus, `Uploading audio · ${Math.round(percent)}%`);
      setProgress(audioProgress, percent);
    });
    if (sequence !== state.audioSequence) return;
    audioDrop.hidden = true;
    audioReady.hidden = false;
    coverUpload.hidden = false;
    document.querySelector("[data-audio-name]").textContent = upload.filename;
    document.querySelector("[data-audio-detail]").textContent = "Uploaded · waiting for metadata and waveform";
    setPreviewSource(upload.asset_url, upload.filename);
    setAssetStatus(audioStatus, "Analyzing audio and creating waveform…");
    setProgress(audioProgress, 100, true);
    await pollAudio(upload.id, sequence);
  } catch (error) {
    if (sequence !== state.audioSequence) return;
    state.audioUpload = null;
    setAssetStatus(audioStatus, error.message, true);
    hideProgress(audioProgress);
  }
}

async function startCoverUpload(file) {
  state.editorGeneration += 1;
  submit.disabled = false;
  const sequence = ++state.coverSequence;
  state.coverReplacementStarted = true;
  state.coverUpload = null;
  if (coverPreview.dataset.localUrl) URL.revokeObjectURL(coverPreview.dataset.localUrl);
  coverPreview.dataset.localUrl = URL.createObjectURL(file);
  coverPreview.src = coverPreview.dataset.localUrl;
  coverPreview.hidden = false;
  coverDrop.classList.add("has-preview");
  coverDrop.setAttribute("aria-label", "Drag or use arrow keys to reposition the cover; scroll, pinch, plus, or minus to zoom");
  coverTools.hidden = false;
  cancelEdit.hidden = false;
  setCoverTransform();
  setAssetStatus(coverStatus, "Uploading cover…");
  setProgress(coverProgress, 0);
  try {
    const upload = await uploadFile("cover", file, (percent) => {
      if (sequence !== state.coverSequence) return;
      setAssetStatus(coverStatus, `Uploading cover · ${Math.round(percent)}%`);
      setProgress(coverProgress, percent);
    });
    if (sequence !== state.coverSequence) return;
    state.coverUpload = upload;
    coverPreview.src = upload.asset_url;
    if (coverPreview.dataset.localUrl) {
      URL.revokeObjectURL(coverPreview.dataset.localUrl);
      delete coverPreview.dataset.localUrl;
    }
    setAssetStatus(coverStatus, "Cover ready.");
    hideProgress(coverProgress);
  } catch (error) {
    if (sequence !== state.coverSequence) return;
    setAssetStatus(coverStatus, error.message, true);
    hideProgress(coverProgress);
  }
}

function bindDropZone(drop, kind, input = drop.querySelector("input")) {
  const acceptFile = (file) => {
    if (!file || input.disabled) return;
    if (kind === "audio") startAudioUpload(file);
    else startCoverUpload(file);
  };
  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = "";
    acceptFile(file);
  });
  ["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (input.disabled) return;
    drop.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
  }));
  drop.addEventListener("drop", (event) => acceptFile(event.dataTransfer.files[0]));
}

bindDropZone(audioDrop, "audio");
bindDropZone(coverDrop, "cover", coverInput);
coverDrop.addEventListener("click", () => {
  if (!coverDrop.classList.contains("has-preview")) coverInput.click();
});
document.querySelector("[data-change-cover]").addEventListener("click", () => coverInput.click());

const coverPointers = new Map();
let coverDrag = null;
let coverPinch = null;
const applyCoverGesture = () => setCoverTransform(`${state.coverTransform.x}% ${state.coverTransform.y}%`, state.coverTransform.zoom);
coverDrop.addEventListener("pointerdown", (event) => {
  if (coverDrop.disabled || !coverDrop.classList.contains("has-preview")) return;
  event.preventDefault();
  coverDrop.setPointerCapture(event.pointerId);
  coverPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  coverDrop.classList.add("is-cropping");
  if (coverPointers.size === 1) coverDrag = { x: event.clientX, y: event.clientY };
  if (coverPointers.size === 2) {
    const [first, second] = [...coverPointers.values()];
    coverPinch = { distance: Math.hypot(second.x - first.x, second.y - first.y), zoom: state.coverTransform.zoom };
  }
});
coverDrop.addEventListener("pointermove", (event) => {
  if (!coverPointers.has(event.pointerId)) return;
  event.preventDefault();
  coverPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (coverPointers.size >= 2 && coverPinch) {
    const [first, second] = [...coverPointers.values()];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    state.coverTransform.zoom = Math.max(1, Math.min(3, coverPinch.zoom * distance / Math.max(1, coverPinch.distance)));
  } else if (coverDrag) {
    const bounds = coverDrop.getBoundingClientRect();
    state.coverTransform.x = Math.max(0, Math.min(100, state.coverTransform.x - (event.clientX - coverDrag.x) / bounds.width * 100));
    state.coverTransform.y = Math.max(0, Math.min(100, state.coverTransform.y - (event.clientY - coverDrag.y) / bounds.height * 100));
    coverDrag = { x: event.clientX, y: event.clientY };
  }
  applyCoverGesture();
});
const endCoverPointer = (event) => {
  coverPointers.delete(event.pointerId);
  if (coverPointers.size < 2) coverPinch = null;
  if (coverPointers.size === 1) {
    const remaining = [...coverPointers.values()][0];
    coverDrag = { x: remaining.x, y: remaining.y };
  } else if (!coverPointers.size) {
    coverDrag = null;
    coverDrop.classList.remove("is-cropping");
  }
};
coverDrop.addEventListener("pointerup", endCoverPointer);
coverDrop.addEventListener("pointercancel", endCoverPointer);
coverDrop.addEventListener("wheel", (event) => {
  if (coverDrop.disabled || !coverDrop.classList.contains("has-preview")) return;
  event.preventDefault();
  state.coverTransform.zoom = Math.max(1, Math.min(3, state.coverTransform.zoom - event.deltaY * .002));
  applyCoverGesture();
}, { passive: false });
coverDrop.addEventListener("keydown", (event) => {
  if (coverDrop.disabled || !coverDrop.classList.contains("has-preview")) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const step = event.shiftKey ? 10 : 2;
  if (event.key === "ArrowLeft") state.coverTransform.x -= step;
  else if (event.key === "ArrowRight") state.coverTransform.x += step;
  else if (event.key === "ArrowUp") state.coverTransform.y -= step;
  else if (event.key === "ArrowDown") state.coverTransform.y += step;
  else if (["+", "="].includes(event.key)) state.coverTransform.zoom += .1;
  else if (event.key === "-") state.coverTransform.zoom -= .1;
  else return;
  event.preventDefault();
  state.coverTransform.x = Math.max(0, Math.min(100, state.coverTransform.x));
  state.coverTransform.y = Math.max(0, Math.min(100, state.coverTransform.y));
  state.coverTransform.zoom = Math.max(1, Math.min(3, state.coverTransform.zoom));
  applyCoverGesture();
  setAssetStatus(coverStatus, `Cover position ${Math.round(state.coverTransform.x)}% by ${Math.round(state.coverTransform.y)}%, zoom ${state.coverTransform.zoom.toFixed(1)}×.`);
});
form.querySelectorAll('[name="kind"]').forEach((input) => input.addEventListener("change", () => {
  state.kindDirty = true;
  setKind(input.value);
}));
form.elements.title.addEventListener("input", () => {
  if (form.elements.title.value !== state.autoTitle) state.autoTitle = "";
});
form.elements.tags.addEventListener("input", () => renderTagSuggestions());
function mediaPayload() {
  const isSet = form.elements.kind.value === "set";
  return {
    audio_upload_id: state.audioUpload?.id || "",
    cover_upload_id: state.coverUpload?.id || "",
    kind: form.elements.kind.value,
    title: form.elements.title.value,
    subtitle: form.elements.subtitle.value,
    event_name: isSet ? form.elements.event_name.value : "",
    event_url: isSet ? form.elements.event_url.value : "",
    location_url: isSet ? form.elements.location_url.value : "",
    played_at: form.elements.played_at.value,
    country: isSet ? form.elements.country.value : "",
    city: isSet ? form.elements.city.value : "",
    tags: form.elements.tags.value,
    telegram_url: form.elements.telegram_url.value,
    cover_position: `${Math.round(state.coverTransform.x)}% ${Math.round(state.coverTransform.y)}%`,
    cover_zoom: Number(state.coverTransform.zoom.toFixed(2)),
    timed_content: cloneTimedContent(state.timedContent),
  };
}

function cancelPendingEditorAssets() {
  state.audioSequence += 1;
  state.coverSequence += 1;
  activeUploads.audio?.abort();
  activeUploads.cover?.abort();
  activeUploads.audio = null;
  activeUploads.cover = null;
  state.audioUpload = null;
  state.coverUpload = null;
  state.coverReplacementStarted = false;
  state.previewView = { start: 0, end: 1 };
  setPreviewSticky(false);
  state.waveformPreviewController?.abort();
  clearPreview();
  audioInput.value = "";
  coverInput.value = "";
  hideProgress(audioProgress);
  hideProgress(coverProgress);
  if (coverPreview.dataset.localUrl) URL.revokeObjectURL(coverPreview.dataset.localUrl);
  delete coverPreview.dataset.localUrl;
}

function resetEditor() {
  state.editorGeneration += 1;
  setEditorBusy(false);
  cancelPendingEditorAssets();
  state.editing = null;
  state.autoTitle = "";
  state.kindDirty = false;
  state.timedContent = { entries: [], text: "", markers: [], pauses: [] };
  state.lyricsCursor = 0;
  state.lyricsCursorPauseCount = 0;
  state.lyricsSelection = { start: 0, end: 0 };
  state.lyricsPlaybackOffset = -1;
  state.lyricsPlaybackPauseCount = 0;
  state.selectedLyricMarker = null;
  form.reset();
  setPreviewVolume(previewVolume.value);
  setKind("set");
  audioDrop.hidden = false;
  audioReady.hidden = true;
  coverPreview.hidden = true;
  coverPreview.removeAttribute("src");
  coverDrop.classList.remove("has-preview");
  coverDrop.setAttribute("aria-label", "Choose a cover, or drop one here");
  coverTools.hidden = true;
  coverUpload.hidden = true;
  setCoverTransform();
  lyricsEditor.replaceChildren();
  songListInput.value = "";
  rebuildWave.hidden = true;
  setAssetStatus(audioStatus, "");
  setAssetStatus(coverStatus, "");
  editorTitle.textContent = "New media";
  editorContext.textContent = "Audio and cover uploads begin immediately.";
  cancelEdit.hidden = true;
  submit.textContent = "Publish media";
}

function editItem(item) {
  if (editorSavePending) {
    setMessage("Wait for the current save to finish before opening another item.", true);
    return;
  }
  state.editorGeneration += 1;
  setEditorBusy(false);
  cancelPendingEditorAssets();
  state.editing = item;
  state.autoTitle = "";
  state.kindDirty = true;
  setMessage("");
  setKind(item.kind);
  form.elements.title.value = item.title || "";
  form.elements.subtitle.value = item.subtitle || "";
  form.elements.event_name.value = item.event_name || "";
  form.elements.event_url.value = item.event_url || "";
  form.elements.location_url.value = item.location_url || "";
  form.elements.played_at.value = item.played_at || "";
  form.elements.country.value = item.country || "";
  form.elements.city.value = item.city || "";
  form.elements.tags.value = (item.tags || []).join(", ");
  renderTagSuggestions(item.kind);
  form.elements.telegram_url.value = item.telegram_url || "";
  state.timedContent = cloneTimedContent(item.timed_content);
  state.lyricsCursor = 0;
  state.lyricsCursorPauseCount = 0;
  state.lyricsSelection = { start: 0, end: 0 };
  state.lyricsPlaybackOffset = -1;
  state.lyricsPlaybackPauseCount = 0;
  state.selectedLyricMarker = null;
  renderTimedEditor();
  audioDrop.hidden = true;
  audioReady.hidden = false;
  coverUpload.hidden = false;
  document.querySelector("[data-audio-name]").textContent = item.title;
  document.querySelector("[data-audio-detail]").textContent = `${formatDuration(item.duration_seconds)} · existing audio`;
  setAssetStatus(audioStatus, "Audio is retained while editing.");
  rebuildWave.hidden = false;
  setPreviewSource(item.audio_url, item.title, item.duration_seconds);
  void drawUploadWaveform(item.waveform_url);
  coverPreview.src = item.cover_url;
  coverPreview.hidden = false;
  coverDrop.classList.add("has-preview");
  coverDrop.setAttribute("aria-label", "Drag or use arrow keys to reposition the cover; scroll, pinch, plus, or minus to zoom");
  coverTools.hidden = false;
  setCoverTransform(item.cover_position, item.cover_zoom);
  setAssetStatus(coverStatus, "Cover crop is saved with this track.");
  editorTitle.textContent = `Edit ${item.kind}`;
  editorContext.textContent = "Metadata saves immediately when you submit; audio is unchanged.";
  cancelEdit.hidden = false;
  submit.textContent = "Save changes";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus();
}

let waveformRebuildPending = false;
async function rebuildEditorWaveform() {
  const item = state.editing;
  if (!item || waveformRebuildPending) return;
  const generation = state.editorGeneration;
  waveformRebuildPending = true;
  rebuildWave.disabled = true;
  uploadWaveform.setAttribute("aria-busy", "true");
  setAssetStatus(audioStatus, "Rebuilding waveform…");
  void drawUploadWaveform("");
  try {
    const { response, result } = await enqueueMutation(`/api/admin/media/${item.id}/waveform`, { method: "POST" });
    if (!response.ok) throw new Error(result.error || "Waveform rebuild failed");
    await loadAll({ afterMutations: true });
    if (generation !== state.editorGeneration || state.editing?.id !== item.id) return;
    item.duration_seconds = result.duration_seconds;
    document.querySelector("[data-audio-detail]").textContent = `${formatDuration(result.duration_seconds)} · existing audio`;
    await drawUploadWaveform(item.waveform_url);
    if (generation !== state.editorGeneration || state.editing?.id !== item.id) return;
    setAssetStatus(audioStatus, "Waveform rebuilt.");
  } catch (error) {
    if (generation === state.editorGeneration) setAssetStatus(audioStatus, error.message, true);
    await loadAll({ afterMutations: true });
    if (generation === state.editorGeneration && state.editing?.id === item.id) await drawUploadWaveform(item.waveform_url);
  } finally {
    waveformRebuildPending = false;
    rebuildWave.disabled = false;
    uploadWaveform.removeAttribute("aria-busy");
  }
}

rebuildWave.addEventListener("click", () => { void rebuildEditorWaveform(); });

cancelEdit.addEventListener("click", resetEditor);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (editorSavePending) { setMessage("Wait for the current save to finish.", true); return; }
  if (form.elements.kind.value === "set" && state.timedContent.entries.some((entry) => !entry.text.trim())) {
    setMessage("Name every song before saving the set.", true);
    [...timedList.querySelectorAll(".timed-entry input")].find((input) => !input.value.trim())?.focus();
    return;
  }
  if (!form.reportValidity()) return;
  if (!state.editing && !state.audioUpload) { setMessage("Wait for the audio upload and analysis to finish.", true); return; }
  if (!state.editing && !state.coverUpload) { setMessage("Upload a cover before publishing.", true); return; }
  if (state.editing && state.coverReplacementStarted && !state.coverUpload) { setMessage("Wait for the replacement cover to finish uploading, or choose it again if the upload failed.", true); return; }
  const editorGeneration = state.editorGeneration;
  const payload = mediaPayload();
  editorSavePending = true;
  setEditorBusy(true);
  setMessage(state.editing ? "Saving changes…" : "Publishing media…");
  try {
    const { response, result } = await enqueueMutation(state.editing ? `/api/admin/media/${state.editing.id}` : "/api/admin/media", {
      method: state.editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      if (payload.audio_upload_id && state.audioUpload?.id === payload.audio_upload_id) state.audioUpload = null;
      if (payload.cover_upload_id && state.coverUpload?.id === payload.cover_upload_id) state.coverUpload = null;
    }
    if (editorGeneration !== state.editorGeneration) {
      await loadAll({ afterMutations: true });
      return;
    }
    if (!response.ok) throw new Error(result.error || "Could not save media");
    setMessage(`“${result.title}” saved.`);
    resetEditor();
    await loadAll({ afterMutations: true });
  } catch (error) {
    if (editorGeneration === state.editorGeneration) setMessage(error.message, true);
    await loadAll({ afterMutations: true });
  } finally {
    editorSavePending = false;
    if (editorGeneration === state.editorGeneration) setEditorBusy(false);
  }
});

async function loadIdentity() {
  const response = await fetch("/api/admin/me");
  if (response.ok) document.querySelector("[data-admin-name]").textContent = (await response.json()).name;
}

async function fetchSettings() {
  const response = await fetch("/api/admin/settings");
  if (!response.ok) throw new Error("Could not load settings");
  return response.json();
}

async function fetchCatalog(kind) {
  const response = await fetch(`/api/media?kind=${kind}`);
  if (!response.ok) throw new Error(`Could not load ${kind}s`);
  return (await response.json()).items;
}

function renderCatalogContext(element, item) {
  const lead = item.kind === "set" ? item.event_name || item.subtitle : item.subtitle;
  const location = [item.city, item.country].filter(Boolean).join(", ");
  const locationLink = TouchzoukUI.createLocationLink(item, "admin-location-link");
  const parts = [lead, locationLink || location, item.played_at].filter(Boolean);
  parts.forEach((part, index) => {
    if (index) element.append(document.createTextNode(" · "));
    element.append(part instanceof Node ? part : document.createTextNode(part));
  });
  element.hidden = !parts.length;
}

function catalogDetails(item) {
  return [formatDuration(item.duration_seconds), ...(item.tags || [])].join(" · ");
}

function renderLibrary() {
  const library = document.querySelector("[data-admin-library]");
  const items = state.catalog[state.libraryKind];
  library.replaceChildren();
  document.querySelector("[data-catalog-order-hint]").textContent = `Drag ${state.libraryKind}s into their public order.`;
  if (!items.length) {
    library.innerHTML = `<div class="admin-empty">No ${state.libraryKind}s published.</div>`;
    return;
  }
  const template = document.querySelector("#admin-media-template");
  items.forEach((item) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.id = item.id;
    row.classList.add("is-sortable");
    const image = row.querySelector(".admin-row-cover img");
    image.src = item.cover_url;
    image.alt = "";
    TouchzoukUI.applyCoverCrop(image, item);
    row.querySelector("strong").textContent = item.title;
    const context = row.querySelector(".admin-meta");
    renderCatalogContext(context, item);
    row.querySelector(".admin-details").textContent = catalogDetails(item);
    const rowStatus = row.querySelector(".admin-row-status");
    bindCatalogDrag(row, library, item.kind);
    row.querySelector(".edit-media").addEventListener("click", () => editItem(item));
    const pin = row.querySelector(".pin-media");
    if (item.kind !== "set") pin.hidden = true;
    else {
      const pinned = state.settings.featured_set_id === item.id;
      pin.textContent = pinned ? "Unpin" : "Pin on home";
      pin.classList.toggle("is-pinned", pinned);
      pin.addEventListener("click", async () => {
        pin.disabled = true;
        try {
          const { response, result } = await enqueueMutation(`/api/admin/media/${item.id}/pin`, { method: "POST" });
          if (!response.ok) throw new Error(result.error || "Could not update pin");
          await loadAll({ afterMutations: true });
        } catch (error) {
          setMessage(error.message, true);
          await loadAll({ afterMutations: true });
        } finally {
          pin.disabled = false;
        }
      });
    }
    const regenerate = row.querySelector(".regenerate");
    regenerate.addEventListener("click", async () => {
      regenerate.disabled = true;
      rowStatus.classList.remove("is-error");
      rowStatus.textContent = "Analyzing audio…";
      try {
        const { response, result } = await enqueueMutation(`/api/admin/media/${item.id}/waveform`, { method: "POST" });
        if (!response.ok) throw new Error(result.error || "Waveform rebuild failed");
        item.duration_seconds = result.duration_seconds;
        row.querySelector(".admin-details").textContent = catalogDetails(item);
        rowStatus.textContent = "Waveform rebuilt.";
        await loadAll({ afterMutations: true });
      } catch (error) {
        setMessage(error.message, true);
        await loadAll({ afterMutations: true });
      } finally {
        regenerate.disabled = false;
      }
    });
    row.querySelector(".delete-media").addEventListener("click", () => requestDelete(item));
    TouchzoukUI.bindPointerShine(row.querySelectorAll("button"));
    library.append(row);
  });
}

async function persistCatalogOrder(library, kind, focusID = "") {
  if (catalogOrderPending) return;
  catalogOrderPending = true;
  const ids = [...library.querySelectorAll(".admin-media-row")].map((row) => row.dataset.id);
  try {
    const { response, result } = await enqueueMutation(`/api/admin/settings/${kind}-order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error(result.error || `Could not save ${kind} order`);
    const position = focusID ? ids.indexOf(focusID) + 1 : 0;
    const label = kind === "set" ? "Set" : "Song";
    setMessage(position ? `${label} order saved. Position ${position} of ${ids.length}.` : `${label} order saved.`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    await loadAll({ afterMutations: true });
    catalogOrderPending = false;
  }
  if (focusID) document.querySelector(`.admin-media-row[data-id="${CSS.escape(focusID)}"]`)?.focus();
}

function bindCatalogDrag(row, library, kind) {
  let moved = false;
  let dragging = false;
  let dragFrame = 0;
  let latestClientY = 0;
  let activePointer = null;
  let start = null;
  let holdTimer = null;
  const blockTouchPan = (event) => {
    if (dragging) event.preventDefault();
  };
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Drag ${row.querySelector("strong").textContent} to reorder`);
  const moveRow = (clientY) => {
    const siblings = [...library.querySelectorAll(".admin-media-row")].filter((candidate) => candidate !== row);
    const before = siblings.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2;
    });
    if ((before || null) !== row.nextElementSibling) {
      library.insertBefore(row, before || null);
      moved = true;
    }
  };
  const scheduleMove = (clientY) => {
    latestClientY = clientY;
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      moveRow(latestClientY);
    });
  };
  const move = (event) => {
    if (event.pointerId !== activePointer) return;
    if (!dragging) {
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (event.pointerType === "touch") {
        if (distance >= 6) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        return;
      }
      if (distance < 6) return;
      beginDrag();
    }
    event.preventDefault();
    scheduleMove(event.clientY);
  };
  const beginDrag = () => {
    if (dragging || activePointer == null) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    dragging = true;
    library.setPointerCapture?.(activePointer);
    library.addEventListener("lostpointercapture", finish);
    row.setAttribute("aria-grabbed", "true");
    row.classList.add("is-dragging");
  };
  const finish = (event) => {
    if (event.pointerId !== activePointer) return;
    const pointerId = activePointer;
    activePointer = null;
    clearTimeout(holdTimer);
    holdTimer = null;
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      moveRow(latestClientY);
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("touchmove", blockTouchPan);
    library.removeEventListener("lostpointercapture", finish);
    if (library.hasPointerCapture?.(pointerId)) library.releasePointerCapture(pointerId);
    row.removeAttribute("aria-grabbed");
    row.classList.remove("is-dragging");
    if (moved) void persistCatalogOrder(library, kind);
    dragging = false;
    start = null;
  };
  row.addEventListener("pointerdown", (event) => {
    if (catalogOrderPending) return;
    if (event.target.closest("button, a, input, select, textarea")) return;
    if (!event.isPrimary || event.button !== 0) return;
    if (event.pointerType !== "touch") event.preventDefault();
    activePointer = event.pointerId;
    start = { x: event.clientX, y: event.clientY };
    moved = false;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("touchmove", blockTouchPan, { passive: false });
    if (event.pointerType === "touch") holdTimer = setTimeout(beginDrag, 320);
  });
  row.addEventListener("keydown", (event) => {
    if (catalogOrderPending) return;
    if (event.target !== row) return;
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling?.classList.contains("admin-media-row")) return;
    if (event.key === "ArrowUp") library.insertBefore(row, sibling);
    else library.insertBefore(sibling, row);
    void persistCatalogOrder(library, kind, row.dataset.id);
    row.focus();
  });
}

let pendingDelete = null;
function requestDelete(item) {
  pendingDelete = item;
  deleteDialog.returnValue = "";
  document.querySelector("[data-delete-copy]").textContent = `Delete “${item.title}” and its stored media?`;
  deleteDialog.showModal();
}

deleteDialog.addEventListener("close", async () => {
  const item = pendingDelete;
  pendingDelete = null;
  if (deleteDialog.returnValue !== "yes" || !item) return;
  setMessage(`Deleting “${item.title}”…`);
  try {
    const { response, result } = await enqueueMutation(`/api/admin/media/${item.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(result.error || "Could not delete media");
    if (state.editing?.id === item.id) resetEditor();
    setMessage(`“${item.title}” deleted.`);
    await loadAll({ afterMutations: true });
  } catch (error) {
    setMessage(error.message, true);
    await loadAll({ afterMutations: true });
  }
});

document.querySelectorAll("[data-library-tab]").forEach((button) => button.addEventListener("click", () => {
  state.libraryKind = button.dataset.libraryTab;
  document.querySelectorAll("[data-library-tab]").forEach((tab) => tab.setAttribute("aria-pressed", String(tab === button)));
  renderLibrary();
}));

async function loadAll({ afterMutations = false } = {}) {
  const sequence = ++catalogLoadSequence;
  try {
    if (afterMutations) await mutationQueue;
    const [settings, sets, songs] = await Promise.all([fetchSettings(), fetchCatalog("set"), fetchCatalog("song")]);
    if (sequence !== catalogLoadSequence) return;
    state.settings = settings;
    state.catalog.set = sets;
    state.catalog.song = songs;
    document.querySelector('[data-admin-count="set"]').textContent = sets.length;
    document.querySelector('[data-admin-count="song"]').textContent = songs.length;
    renderTagSuggestions();
    renderLibrary();
  } catch (error) {
    if (sequence !== catalogLoadSequence) return;
    document.querySelector("[data-admin-library]").innerHTML = '<div class="admin-empty">Could not load published media.</div>';
    console.error(error);
  }
}

setKind("set");
loadIdentity();
loadAll();
