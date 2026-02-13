function resolveDataRoot() {
  const { origin, pathname } = window.location;
  let basePath = pathname;

  if (basePath.endsWith("/")) {
    return `${origin}${basePath}dist`;
  }

  const lastSegment = basePath.split("/").pop() || "";
  if (lastSegment.includes(".")) {
    const folder = basePath.slice(0, basePath.lastIndexOf("/") + 1);
    return `${origin}${folder}dist`;
  }

  return `${origin}${basePath}/dist`;
}

const DATA_ROOT = resolveDataRoot();
const DEFAULT_TOP_N = 100;

const state = {
  meta: null,
  therapyPairs: [],
  therapyFiles: {},
  currentTherapyId: "",
  currentResults: [],
};

const el = {
  metaInfo: document.getElementById("meta-info"),
  biomarkerSelect: document.getElementById("biomarker-select"),
  targetSelect: document.getElementById("target-select"),
  pairResultsWrap: document.getElementById("pair-results-wrap"),
  therapyTopnNote: document.getElementById("therapy-topn-note"),
  pairGeneSearch: document.getElementById("pair-gene-search"),
  geneSuggestBox: document.getElementById("gene-suggest-box"),
  therapyResults: document.getElementById("therapy-results"),
};

function scoreDisplay(score) {
  const number = Number(score);
  if (Number.isNaN(number)) {
    return "";
  }
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeGene(value) {
  return String(value || "").toUpperCase();
}

function rankNumber(value) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  return Number.MAX_SAFE_INTEGER;
}

async function fetchJson(path) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load ${path} (${response.status})`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to load ${path}`);
}

function fillSelect(selectEl, options, valueKey, labelKey, placeholder) {
  selectEl.innerHTML = "";

  if (placeholder) {
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = placeholder;
    selectEl.appendChild(placeholderOption);
  }

  for (const option of options) {
    const node = document.createElement("option");
    node.value = option[valueKey];
    node.textContent = option[labelKey];
    selectEl.appendChild(node);
  }
}

function renderEmpty(message) {
  el.therapyResults.innerHTML = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-row";
  cell.colSpan = 3;
  cell.textContent = message;
  row.appendChild(cell);
  el.therapyResults.appendChild(row);
}

function parseTherapyParts(therapyId) {
  const parts = String(therapyId || "").split("_").filter(Boolean);
  if (parts.length >= 2) {
    return { biomarker: parts[0], target: parts.slice(1).join("_") };
  }
  return { biomarker: String(therapyId || ""), target: "" };
}

function formatTherapyDisplay(therapyId, fallbackDisplay = "") {
  const { biomarker, target } = parseTherapyParts(therapyId);
  if (biomarker && target) {
    return `${biomarker} + ${target}`;
  }
  return fallbackDisplay || therapyId;
}

function getPairsForBiomarker(biomarker) {
  return state.therapyPairs
    .filter((pair) => pair.biomarker === biomarker)
    .sort((a, b) => a.target.localeCompare(b.target));
}

function resetPairResults() {
  state.currentTherapyId = "";
  state.currentResults = [];
  el.pairGeneSearch.value = "";
  el.geneSuggestBox.classList.add("hidden");
  el.geneSuggestBox.innerHTML = "";
  el.pairResultsWrap.classList.add("hidden");
}

function setupBiomarkerOptions() {
  const biomarkers = [...new Set(state.therapyPairs.map((pair) => pair.biomarker))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  fillSelect(el.biomarkerSelect, biomarkers.map((item) => ({ value: item, label: item })), "value", "label", "Select");
  fillSelect(el.targetSelect, [], "value", "label", "Select");
}

function setupTargetOptions(biomarker) {
  if (!biomarker) {
    fillSelect(el.targetSelect, [], "value", "label", "Select");
    return;
  }

  const targets = getPairsForBiomarker(biomarker).map((pair) => ({
    value: pair.target,
    label: pair.target,
  }));

  fillSelect(el.targetSelect, targets, "value", "label", "Select");
}

function getSelectedTherapyId() {
  const biomarker = el.biomarkerSelect.value;
  const target = el.targetSelect.value;

  if (!biomarker || !target) {
    return "";
  }

  const pair = state.therapyPairs.find((item) => item.biomarker === biomarker && item.target === target);
  return pair ? pair.id : "";
}

function renderRows(rows) {
  el.therapyResults.innerHTML = "";

  if (!rows.length) {
    renderEmpty("No genes found for this input.");
    return;
  }

  for (const item of rows) {
    const rankValue = Number.isFinite(Number(item.rank)) ? Number(item.rank) : "";
    const row = document.createElement("tr");
    row.innerHTML = `<td>${item.gene}</td><td>${scoreDisplay(item.score)}</td><td>${rankValue}</td>`;
    el.therapyResults.appendChild(row);
  }
}

function getGeneSuggestions(query, limit = 12) {
  const term = normalizeGene(query);
  if (!term) {
    return [];
  }

  const unique = new Set();
  const suggestions = [];

  for (const item of state.currentResults) {
    const gene = String(item.gene || "");
    if (!gene) {
      continue;
    }
    if (!normalizeGene(gene).includes(term)) {
      continue;
    }
    if (unique.has(gene)) {
      continue;
    }

    unique.add(gene);
    suggestions.push(gene);

    if (suggestions.length >= limit) {
      break;
    }
  }

  return suggestions;
}

function renderGeneSuggestions(genes) {
  if (!genes.length) {
    el.geneSuggestBox.classList.add("hidden");
    el.geneSuggestBox.innerHTML = "";
    return;
  }

  el.geneSuggestBox.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const gene of genes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggest-item";
    button.textContent = gene;
    button.addEventListener("click", () => {
      el.pairGeneSearch.value = gene;
      applyGeneSearch(gene);
      el.geneSuggestBox.classList.add("hidden");
    });
    fragment.appendChild(button);
  }

  el.geneSuggestBox.appendChild(fragment);
  el.geneSuggestBox.classList.remove("hidden");
}

function applyGeneSearch(rawTerm) {
  if (!state.currentResults.length) {
    renderEmpty("Select biomarker and target first.");
    return;
  }

  const term = normalizeGene(rawTerm.trim());

  if (!term) {
    const topRows = state.currentResults.slice(0, DEFAULT_TOP_N);
    renderRows(topRows);
    return;
  }

  const matches = state.currentResults.filter((item) => normalizeGene(item.gene).includes(term));
  renderRows(matches);
}

async function loadTherapyResults(therapyId) {
  const file = state.therapyFiles[therapyId];
  if (!file) {
    resetPairResults();
    renderEmpty("Therapy pair not found.");
    return;
  }

  const payload = await fetchJson(`${DATA_ROOT}/${file}`);
  const results = Array.isArray(payload.results) ? payload.results : [];

  state.currentTherapyId = therapyId;
  state.currentResults = [...results].sort((a, b) => rankNumber(a.rank) - rankNumber(b.rank));

  const pair = state.therapyPairs.find((item) => item.id === therapyId);
  const pairLabel = pair ? pair.display : therapyId;

  el.therapyTopnNote.textContent = `Showing Top-${DEFAULT_TOP_N} genes for ${pairLabel}. Use gene search to find any gene in this pair.`;
  el.pairGeneSearch.value = "";
  el.geneSuggestBox.classList.add("hidden");
  el.geneSuggestBox.innerHTML = "";
  el.pairResultsWrap.classList.remove("hidden");

  if (!state.currentResults.length) {
    renderEmpty("No results for this therapy pair.");
    return;
  }

  renderRows(state.currentResults.slice(0, DEFAULT_TOP_N));
}

async function init() {
  try {
    const [meta, therapyPairs, therapyFiles] = await Promise.all([
      fetchJson(`${DATA_ROOT}/index/meta.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_pairs.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_files.json`),
    ]);

    state.meta = meta;
    state.therapyPairs = therapyPairs
      .map((pair) => {
        const { biomarker, target } = parseTherapyParts(pair.id);
        return {
          ...pair,
          biomarker,
          target,
          display: formatTherapyDisplay(pair.id, pair.display),
        };
      })
      .sort((a, b) => a.display.localeCompare(b.display));
    state.therapyFiles = therapyFiles;

    setupBiomarkerOptions();
    resetPairResults();

    el.biomarkerSelect.addEventListener("change", () => {
      setupTargetOptions(el.biomarkerSelect.value);
      resetPairResults();
    });

    el.targetSelect.addEventListener("change", async () => {
      const therapyId = getSelectedTherapyId();
      if (!therapyId) {
        resetPairResults();
        return;
      }
      await loadTherapyResults(therapyId);
    });

    el.pairGeneSearch.addEventListener("input", () => {
      const term = el.pairGeneSearch.value.trim();
      applyGeneSearch(term);
      renderGeneSuggestions(getGeneSuggestions(term));
    });

    document.addEventListener("click", (event) => {
      if (event.target === el.pairGeneSearch || el.geneSuggestBox.contains(event.target)) {
        return;
      }
      el.geneSuggestBox.classList.add("hidden");
    });
  } catch (error) {
    console.error(error);
    el.pairResultsWrap.classList.remove("hidden");
    renderEmpty("Unable to load data files.");
  }
}

init();
