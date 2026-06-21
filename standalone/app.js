/*
 * Standalone / PWA Multi-Label Text Annotation
 * -------------------------------------------------
 * Mirrors the UX of the AWS Ground Truth worker template, but runs as a
 * self-hosted web app. This is the context where:
 *   - PWA features (service worker, install, offline) ARE possible, and
 *   - an LLM/Classifier can be called directly (from a backend) for pre-labeling,
 *     because we are NOT inside Ground Truth's sandboxed iframe.
 *
 * Data flow:
 *   loadTask()        -> fetch the next text + label set (here: mocked / local sample)
 *   fetchPreLabels()  -> ask an LLM/Classifier for suggested labels (here: heuristic mock)
 *   submitResult()    -> POST the worker's answer to your backend (here: console + queue)
 */

"use strict";

/* ----------------------------- Configuration ----------------------------- */

const CONFIG = {
  requireSelection: true,
  exclusionLabel: "Keine zutreffend",
  // Set to a real endpoint to enable server-side LLM/classifier pre-labeling.
  // Leave null to use the local heuristic mock (works fully offline).
  preLabelEndpoint: null, // e.g. "/api/prelabel"
  submitEndpoint: null,   // e.g. "/api/annotations"
};

/* ------------------------------- Sample data ------------------------------ */
/* In production, replace loadTask() with a fetch() to your backend. */

const SAMPLE_TASKS = [
  {
    id: "demo-1",
    header: "Wähle alle zutreffenden Labels",
    text:
      "Die Lieferung kam zwei Tage zu spät, aber der Kundenservice war sehr freundlich " +
      "und hat mir sofort einen Rabatt angeboten. Das Produkt selbst funktioniert einwandfrei.",
    labels: ["Positiv", "Negativ", "Neutral", "Lieferung", "Kundenservice", "Produktqualität", "Frage", "Beschwerde"],
  },
  {
    id: "demo-2",
    header: "Wähle alle zutreffenden Labels",
    text: "Wie kann ich mein Passwort zurücksetzen? Ich finde die Option nirgends im Menü.",
    labels: ["Positiv", "Negativ", "Neutral", "Lieferung", "Kundenservice", "Produktqualität", "Frage", "Beschwerde"],
  },
];

let taskQueue = SAMPLE_TASKS.slice();
let currentTask = null;
let initialSelection = "[]";

/* ------------------------------- DOM refs -------------------------------- */

const els = {
  title: document.getElementById("title"),
  docText: document.getElementById("docText"),
  docRegion: document.getElementById("docRegion"),
  chips: document.getElementById("chips"),
  legend: document.getElementById("labelsLegend"),
  count: document.getElementById("count"),
  error: document.getElementById("error"),
  submitBtn: document.getElementById("submitBtn"),
  skipBtn: document.getElementById("skipBtn"),
  infoBtn: document.getElementById("infoBtn"),
  closeInfo: document.getElementById("closeInfo"),
  dialog: document.getElementById("instructionsDialog"),
  toast: document.getElementById("toast"),
};

let normalInputs = [];
let exclusionInput = null;

/* ------------------------------ Pre-labeling ----------------------------- */
/*
 * Returns suggested labels for a given text.
 * Technical feasibility: in this standalone/PWA context you can call any model.
 * In the embedded Ground Truth template this is NOT possible (sandbox blocks
 * network) -> use a Pre-Annotation Lambda instead (see README).
 */
async function fetchPreLabels(task) {
  if (CONFIG.preLabelEndpoint) {
    try {
      const res = await fetch(CONFIG.preLabelEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: task.text, labels: task.labels }),
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data.labels) ? data.labels : [];
      }
    } catch (e) {
      /* fall through to local mock */
    }
  }
  return localHeuristicPreLabels(task);
}

/* Tiny offline keyword heuristic so the demo shows pre-labeling without a backend. */
function localHeuristicPreLabels(task) {
  const t = (task.text || "").toLowerCase();
  const rules = {
    "Lieferung": ["liefer", "versand", "paket", "zu spät"],
    "Kundenservice": ["kundenservice", "support", "freundlich", "mitarbeiter"],
    "Produktqualität": ["produkt", "funktioniert", "qualität", "defekt"],
    "Frage": ["wie kann", "?", "wo finde", "warum"],
    "Beschwerde": ["zu spät", "schlecht", "problem", "ärgerlich"],
    "Positiv": ["freundlich", "einwandfrei", "super", "danke", "rabatt"],
    "Negativ": ["zu spät", "schlecht", "leider", "problem"],
  };
  const suggested = [];
  for (const [label, kws] of Object.entries(rules)) {
    if (!task.labels.includes(label)) continue;
    if (kws.some((k) => t.includes(k))) suggested.push(label);
  }
  return suggested;
}

/* ------------------------------- Rendering ------------------------------- */

function makeChip(label, opts = {}) {
  const wrap = document.createElement("label");
  wrap.className = "chip" + (opts.exclusion ? " chip--exclusion" : "") + (opts.prelabeled ? " chip--prelabeled" : "");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = label;
  input.checked = !!opts.checked;

  const box = document.createElement("span");
  box.className = "chip__box";
  box.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "chip__label";
  text.textContent = label;

  wrap.append(input, box, text);

  if (opts.prelabeled) {
    const tag = document.createElement("span");
    tag.className = "chip__tag";
    tag.textContent = "Vorschlag";
    wrap.appendChild(tag);
  }

  const sync = () => wrap.setAttribute("data-checked", input.checked ? "true" : "false");
  input.addEventListener("change", () => {
    if (opts.exclusion && input.checked) clearNormalLabels();
    else if (!opts.exclusion && input.checked) clearExclusion();
    sync();
    updateCount();
    clearError();
  });
  sync();
  return { wrap, input };
}

function clearNormalLabels() {
  normalInputs.forEach((i) => { i.checked = false; i.closest(".chip").setAttribute("data-checked", "false"); });
}
function clearExclusion() {
  if (exclusionInput) { exclusionInput.checked = false; exclusionInput.closest(".chip").setAttribute("data-checked", "false"); }
}
function selectedLabels() {
  return normalInputs.filter((i) => i.checked).map((i) => i.value);
}
function isExcluded() { return !!(exclusionInput && exclusionInput.checked); }

function updateCount() {
  const n = selectedLabels().length + (isExcluded() ? 1 : 0);
  els.count.textContent = n + " ausgewählt";
}
function clearError() { els.error.textContent = ""; }

function renderTask(task, preLabels) {
  currentTask = task;
  els.title.textContent = task.header || "Wähle alle zutreffenden Labels";
  els.docText.textContent = task.text;
  els.chips.innerHTML = "";
  normalInputs = [];
  exclusionInput = null;

  const preSet = new Set((preLabels || []).map(String));

  task.labels.forEach((label) => {
    if (label === CONFIG.exclusionLabel) return;
    const c = makeChip(label, { checked: preSet.has(label), prelabeled: preSet.has(label) });
    normalInputs.push(c.input);
    els.chips.appendChild(c.wrap);
  });

  const exC = makeChip(CONFIG.exclusionLabel, { exclusion: true });
  exclusionInput = exC.input;
  els.chips.appendChild(exC.wrap);

  els.legend.textContent = task.labels.length + " Labels – Mehrfachauswahl";
  els.docRegion && (els.docRegion.scrollTop = 0);
  initialSelection = JSON.stringify(selectedLabels().sort());
  updateCount();
  clearError();
}

/* ------------------------------- Workflow -------------------------------- */

async function loadTask() {
  const next = taskQueue.shift();
  if (!next) {
    els.docText.textContent = "Keine weiteren Aufgaben. Vielen Dank!";
    els.chips.innerHTML = "";
    els.submitBtn.disabled = true;
    els.skipBtn.disabled = true;
    els.legend.textContent = "";
    els.count.textContent = "";
    return;
  }
  const preLabels = await fetchPreLabels(next);
  renderTask(next, preLabels);
}

function buildResult(extra = {}) {
  const sel = selectedLabels();
  const modified = JSON.stringify(sel.slice().sort()) !== initialSelection;
  return Object.assign(
    {
      taskId: currentTask ? currentTask.id : null,
      labels: sel,
      noneOfTheAbove: isExcluded(),
      modified,
      timestamp: new Date().toISOString(),
    },
    extra
  );
}

async function submitResult(result) {
  if (CONFIG.submitEndpoint) {
    try {
      await fetch(CONFIG.submitEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
    } catch (e) {
      queueOffline(result);
      showToast("Offline – gespeichert, wird später gesendet");
      return;
    }
  } else {
    // Demo mode: log it.
    console.log("Annotation result:", result);
  }
  showToast("Gespeichert");
}

/* Simple offline queue using localStorage (a real PWA would use IndexedDB + Background Sync). */
function queueOffline(result) {
  try {
    const q = JSON.parse(localStorage.getItem("pendingAnnotations") || "[]");
    q.push(result);
    localStorage.setItem("pendingAnnotations", JSON.stringify(q));
  } catch (e) { /* ignore */ }
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

/* ------------------------------- Events ---------------------------------- */

els.submitBtn.addEventListener("click", async () => {
  if (CONFIG.requireSelection && selectedLabels().length === 0 && !isExcluded()) {
    els.error.textContent = "Bitte wähle mindestens ein Label aus.";
    return;
  }
  await submitResult(buildResult());
  await loadTask();
});

els.skipBtn.addEventListener("click", async () => {
  await submitResult(buildResult({ skipped: true }));
  await loadTask();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
    e.preventDefault();
    els.submitBtn.click();
  }
});

els.infoBtn.addEventListener("click", () => {
  if (typeof els.dialog.showModal === "function") els.dialog.showModal();
  else els.dialog.setAttribute("open", "");
});
els.closeInfo.addEventListener("click", () => {
  if (typeof els.dialog.close === "function") els.dialog.close();
  else els.dialog.removeAttribute("open");
});

/* ------------------------------- Bootstrap ------------------------------- */

loadTask();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => { /* offline support optional */ });
  });
}
