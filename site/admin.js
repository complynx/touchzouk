const state = {
  audioUpload: null,
  coverUpload: null,
  editing: null,
  libraryKind: "set",
  editorGeneration: 0,
  catalog: { set: [], song: [] },
  settings: { featured_set_id: "", song_order: [] },
  audioSequence: 0,
  coverSequence: 0,
  coverReplacementStarted: false,
  autoTitle: "",
  kindDirty: false,
  coverTransform: { x: 50, y: 50, zoom: 1 },
  waveformPreviewController: null,
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
const setFields = document.querySelector("[data-set-fields]");
const cancelEdit = document.querySelector("[data-cancel-edit]");
const editorTitle = document.querySelector("#editor-title");
const editorContext = document.querySelector("[data-editor-context]");
const uploadWaveform = document.querySelector("[data-upload-waveform]");
const deleteDialog = document.querySelector("[data-delete-dialog]");
const tagSuggestions = document.querySelector("[data-tag-suggestions]");
let mutationQueue = Promise.resolve();
let catalogLoadSequence = 0;
let editorSavePending = false;
let songOrderPending = false;
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
}

const formatDuration = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

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
  document.querySelector("[data-kind-hint]").textContent = guessed
    ? `${kind === "set" ? "Set" : "Song"} suggested from the uploaded duration. You can switch it.`
    : "12:00 and longer is suggested as a set.";
  renderTagSuggestions(kind);
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

async function drawUploadWaveform(url, sequence = state.audioSequence) {
  state.waveformPreviewController?.abort();
  const controller = new AbortController();
  state.waveformPreviewController = controller;
  uploadWaveform.hidden = !state.editing;
  if (!url) return;
  let points;
  try {
    const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
    if (!response.ok || sequence !== state.audioSequence) return;
    points = (await response.json()).points || [];
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      if (state.editing) {
        uploadWaveform.hidden = false;
        setAssetStatus(audioStatus, "Waveform preview unavailable. Activate it to rebuild.", true);
      }
    }
    return;
  }
  if (controller.signal.aborted || sequence !== state.audioSequence) return;
  const bounds = uploadWaveform.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width || 420));
  const height = 52;
  const ratio = window.devicePixelRatio || 1;
  uploadWaveform.width = Math.floor(width * ratio);
  uploadWaveform.height = Math.floor(height * ratio);
  uploadWaveform.style.height = `${height}px`;
  const context = uploadWaveform.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const count = Math.max(32, Math.floor(width / 4));
  const bins = Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * points.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * points.length / count));
    return Math.max(0, ...points.slice(start, end));
  });
  bins.forEach((point, index) => {
    const barHeight = Math.max(2, point * height * .82);
    context.fillStyle = "rgba(239, 227, 206, .62)";
    context.fillRect(index * width / count, (height - barHeight) / 2, Math.max(1, width / count - 2), barHeight);
  });
  uploadWaveform.hidden = false;
}

async function pollAudio(uploadID, sequence) {
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    if (sequence !== state.audioSequence) return;
    const response = await fetch(`/api/admin/uploads/${uploadID}`);
    const upload = await response.json();
    if (sequence !== state.audioSequence) return;
    if (!response.ok) throw new Error(upload.error || "Could not read audio status");
    if (upload.state === "failed") throw new Error(upload.error || "Audio analysis failed");
    if (upload.duration_seconds > 0) {
      if (!form.elements.title.value.trim() || form.elements.title.value === state.autoTitle) {
        form.elements.title.value = upload.title || "";
        state.autoTitle = form.elements.title.value;
      }
      if (!state.kindDirty) setKind(upload.suggested_kind, true);
      audioDrop.hidden = true;
      audioReady.hidden = false;
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
    played_at: form.elements.played_at.value,
    country: isSet ? form.elements.country.value : "",
    city: isSet ? form.elements.city.value : "",
    tags: form.elements.tags.value,
    telegram_url: form.elements.telegram_url.value,
    cover_position: `${Math.round(state.coverTransform.x)}% ${Math.round(state.coverTransform.y)}%`,
    cover_zoom: Number(state.coverTransform.zoom.toFixed(2)),
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
  form.reset();
  setKind("set");
  audioDrop.hidden = false;
  audioReady.hidden = true;
  coverPreview.hidden = true;
  coverPreview.removeAttribute("src");
  coverDrop.classList.remove("has-preview");
  coverDrop.setAttribute("aria-label", "Choose a cover, or drop one here");
  coverTools.hidden = true;
  setCoverTransform();
  uploadWaveform.hidden = true;
  uploadWaveform.classList.remove("is-actionable");
  uploadWaveform.removeAttribute("role");
  uploadWaveform.removeAttribute("tabindex");
  uploadWaveform.setAttribute("aria-label", "Analyzed waveform preview");
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
  setKind(item.kind);
  form.elements.title.value = item.title || "";
  form.elements.subtitle.value = item.subtitle || "";
  form.elements.event_name.value = item.event_name || "";
  form.elements.event_url.value = item.event_url || "";
  form.elements.played_at.value = item.played_at || "";
  form.elements.country.value = item.country || "";
  form.elements.city.value = item.city || "";
  form.elements.tags.value = (item.tags || []).join(", ");
  renderTagSuggestions(item.kind);
  form.elements.telegram_url.value = item.telegram_url || "";
  audioDrop.hidden = true;
  audioReady.hidden = false;
  document.querySelector("[data-audio-name]").textContent = item.title;
  document.querySelector("[data-audio-detail]").textContent = `${formatDuration(item.duration_seconds)} · existing audio`;
  setAssetStatus(audioStatus, "Audio is retained while editing.");
  uploadWaveform.classList.add("is-actionable");
  uploadWaveform.setAttribute("role", "button");
  uploadWaveform.tabIndex = 0;
  uploadWaveform.setAttribute("aria-label", `Rebuild waveform for ${item.title}`);
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
  uploadWaveform.setAttribute("aria-busy", "true");
  setAssetStatus(audioStatus, "Rebuilding waveform…");
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
  } finally {
    waveformRebuildPending = false;
    uploadWaveform.removeAttribute("aria-busy");
  }
}

uploadWaveform.addEventListener("click", () => { void rebuildEditorWaveform(); });
uploadWaveform.addEventListener("keydown", (event) => {
  if (!state.editing || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  void rebuildEditorWaveform();
});

cancelEdit.addEventListener("click", resetEditor);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (editorSavePending) { setMessage("Wait for the current save to finish.", true); return; }
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

function renderLibrary() {
  const library = document.querySelector("[data-admin-library]");
  const items = state.catalog[state.libraryKind];
  library.replaceChildren();
  document.querySelector("[data-song-order-hint]").hidden = state.libraryKind !== "song";
  if (!items.length) {
    library.innerHTML = `<div class="admin-empty">No ${state.libraryKind}s published.</div>`;
    return;
  }
  const template = document.querySelector("#admin-media-template");
  items.forEach((item) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.id = item.id;
    row.classList.toggle("is-song", item.kind === "song");
    const image = row.querySelector(".admin-row-cover img");
    image.src = item.cover_url;
    image.alt = "";
    TouchzoukUI.applyCoverCrop(image, item);
    row.querySelector(".admin-kind").textContent = item.kind;
    row.querySelector("strong").textContent = item.title;
    row.querySelector(".admin-duration").textContent = formatDuration(item.duration_seconds);
    const rowStatus = row.querySelector(".admin-row-status");
    const dragHandle = row.querySelector(".drag-handle");
    dragHandle.hidden = item.kind !== "song";
    if (item.kind === "song") bindSongDrag(row, library);
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
        row.querySelector(".admin-duration").textContent = formatDuration(result.duration_seconds);
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

async function persistSongOrder(library, focusID = "") {
  if (songOrderPending) return;
  songOrderPending = true;
  const ids = [...library.querySelectorAll(".admin-media-row.is-song")].map((row) => row.dataset.id);
  try {
    const { response, result } = await enqueueMutation("/api/admin/settings/song-order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error(result.error || "Could not save song order");
    const position = focusID ? ids.indexOf(focusID) + 1 : 0;
    setMessage(position ? `Song order saved. Position ${position} of ${ids.length}.` : "Song order saved.");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    await loadAll({ afterMutations: true });
    songOrderPending = false;
  }
  if (focusID) document.querySelector(`.admin-media-row.is-song[data-id="${CSS.escape(focusID)}"]`)?.focus();
}

function bindSongDrag(row, library) {
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
    const siblings = [...library.querySelectorAll(".admin-media-row.is-song")].filter((candidate) => candidate !== row);
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
    if (moved) void persistSongOrder(library);
    dragging = false;
    start = null;
  };
  row.addEventListener("pointerdown", (event) => {
    if (songOrderPending) return;
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
    if (songOrderPending) return;
    if (event.target !== row) return;
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling?.classList.contains("is-song")) return;
    if (event.key === "ArrowUp") library.insertBefore(row, sibling);
    else library.insertBefore(sibling, row);
    void persistSongOrder(library, row.dataset.id);
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
