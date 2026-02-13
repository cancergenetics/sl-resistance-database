function resolveDataRoot() {
  const { origin, pathname } = window.location;
  const cleanPath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const base = cleanPath && !cleanPath.endsWith(".html")
    ? cleanPath
    : cleanPath.slice(0, cleanPath.lastIndexOf("/"));
  return `${origin}${base}/dist`;
}

const DATA_ROOT = resolveDataRoot();
const DEFAULT_TOP_N = 100;

const state = {
  meta: null,
  therapyPairs: [],
  therapyFiles: {},
  genes: [],
  geneBuckets: {},
  geneBucketCache: new Map(),
  currentTherapyId: "",
  currentResults: [],
  lastGlobalGeneMatches: [],
};

const el = {
  metaInfo: document.getElementById("meta-info"),
  pairTab: document.getElementById("pair-tab"),
  geneTab: document.getElementById("gene-tab"),
  pairView: document.getElementById("pair-view"),
  geneView: document.getElementById("gene-view"),

  biomarkerSelect: document.getElementById("biomarker-select"),
  targetSelect: document.getElementById("target-select"),
  pairResultsWrap: document.getElementById("pair-results-wrap"),
  pairTopnNote: document.getElementById("therapy-topn-note"),
  pairGeneSearch: document.getElementById("pair-gene-search"),
  pairGeneSuggestBox: document.getElementById("gene-suggest-box"),
  pairResults: document.getElementById("therapy-results"),

  geneGlobalSearch: document.getElementById("gene-global-search"),
  geneGlobalSuggestBox: document.getElementById("gene-global-suggest-box"),
  geneGlobalResults: document.getElementById("gene-global-results"),
};

function scoreDisplay(score) {
  const number = Number(score);
  if (Number.isNaN(number)) {
    return "";
  }
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeGene(value) {
  return String(value || "").trim().toUpperCase();
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

function fillSelect(selectEl, options, valueKey, labelKey, placeholder = "") {
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

function renderTableEmpty(tbody, message, colSpan = 3) {
  tbody.innerHTML = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-row";
  cell.colSpan = colSpan;
  cell.textContent = message;
  row.appendChild(cell);
  tbody.appendChild(row);
}

function setActiveTab(viewName) {
  const isPair = viewName === "pair";
  el.pairTab.classList.toggle("active", isPair);
  el.geneTab.classList.toggle("active", !isPair);
  el.pairView.classList.toggle("active", isPair);
  el.geneView.classList.toggle("active", !isPair);
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
  el.pairGeneSuggestBox.classList.add("hidden");
  el.pairGeneSuggestBox.innerHTML = "";
  el.pairResultsWrap.classList.add("hidden");
  renderTableEmpty(el.pairResults, "Select biomarker and target first.");
}

function setupBiomarkerOptions() {
  const biomarkers = [...new Set(state.therapyPairs.map((pair) => pair.biomarker))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  fillSelect(
    el.biomarkerSelect,
    biomarkers.map((item) => ({ value: item, label: item })),
    "value",
    "label",
    "Select"
  );
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

function renderPairRows(rows) {
  el.pairResults.innerHTML = "";

  if (!rows.length) {
    renderTableEmpty(el.pairResults, "No genes found for this input.");
    return;
  }

  for (const item of rows) {
    const rankValue = Number.isFinite(Number(item.rank)) ? Number(item.rank) : "";
    const row = document.createElement("tr");
    row.innerHTML = `<td>${item.gene}</td><td>${scoreDisplay(item.score)}</td><td>${rankValue}</td>`;
    el.pairResults.appendChild(row);
  }
}

function getPairGeneSuggestions(query, limit = 12) {
  const term = normalizeGene(query);
  if (!term) {
    return [];
  }

  const unique = new Set();
  const suggestions = [];

  for (const item of state.currentResults) {
    const gene = String(item.gene || "");
    if (!gene || !normalizeGene(gene).includes(term) || unique.has(gene)) {
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

function renderPairGeneSuggestions(genes) {
  if (!genes.length) {
    el.pairGeneSuggestBox.classList.add("hidden");
    el.pairGeneSuggestBox.innerHTML = "";
    return;
  }

  el.pairGeneSuggestBox.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const gene of genes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggest-item";
    button.textContent = gene;
    button.addEventListener("click", () => {
      el.pairGeneSearch.value = gene;
      applyPairGeneSearch(gene);
      el.pairGeneSuggestBox.classList.add("hidden");
    });
    fragment.appendChild(button);
  }

  el.pairGeneSuggestBox.appendChild(fragment);
  el.pairGeneSuggestBox.classList.remove("hidden");
}

function applyPairGeneSearch(rawTerm) {
  if (!state.currentResults.length) {
    renderTableEmpty(el.pairResults, "Select biomarker and target first.");
    return;
  }

  const term = normalizeGene(rawTerm);
  if (!term) {
    renderPairRows(state.currentResults.slice(0, DEFAULT_TOP_N));
    return;
  }

  const matches = state.currentResults.filter((item) => normalizeGene(item.gene).includes(term));
  renderPairRows(matches);
}

async function loadPairResults(therapyId) {
  const file = state.therapyFiles[therapyId];
  if (!file) {
    resetPairResults();
    renderTableEmpty(el.pairResults, "Therapy pair not found.");
    return;
  }

  const payload = await fetchJson(`${DATA_ROOT}/${file}`);
  const results = Array.isArray(payload.results) ? payload.results : [];

  state.currentTherapyId = therapyId;
  state.currentResults = [...results].sort((a, b) => rankNumber(a.rank) - rankNumber(b.rank));

  const pair = state.therapyPairs.find((item) => item.id === therapyId);
  const pairLabel = pair ? pair.display : therapyId;

  el.pairTopnNote.textContent = `Showing Top-${DEFAULT_TOP_N} genes for ${pairLabel}. Use gene search to find any gene in this pair.`;
  el.pairGeneSearch.value = "";
  el.pairGeneSuggestBox.classList.add("hidden");
  el.pairGeneSuggestBox.innerHTML = "";
  el.pairResultsWrap.classList.remove("hidden");

  if (!state.currentResults.length) {
    renderTableEmpty(el.pairResults, "No results for this therapy pair.");
    return;
  }

  renderPairRows(state.currentResults.slice(0, DEFAULT_TOP_N));
}

function resetGlobalGeneResults() {
  el.geneGlobalSearch.value = "";
  el.geneGlobalSuggestBox.classList.add("hidden");
  el.geneGlobalSuggestBox.innerHTML = "";
  renderTableEmpty(el.geneGlobalResults, "Type a gene symbol to search all pairs.");
}

function findGlobalGeneMatches(rawTerm, limit = 12) {
  const term = normalizeGene(rawTerm);
  if (!term) {
    state.lastGlobalGeneMatches = [];
    return [];
  }

  const matches = [];
  for (const item of state.genes) {
    const symbol = String(item.symbol || "");
    if (!symbol || !normalizeGene(symbol).startsWith(term)) {
      continue;
    }
    matches.push(symbol);
    if (matches.length >= limit) {
      break;
    }
  }

  state.lastGlobalGeneMatches = matches;
  return matches;
}

function renderGlobalGeneSuggestions(genes) {
  if (!genes.length) {
    el.geneGlobalSuggestBox.classList.add("hidden");
    el.geneGlobalSuggestBox.innerHTML = "";
    return;
  }

  el.geneGlobalSuggestBox.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const gene of genes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggest-item";
    button.textContent = gene;
    button.addEventListener("click", async () => {
      el.geneGlobalSearch.value = gene;
      await loadGlobalGeneResults(gene);
      el.geneGlobalSuggestBox.classList.add("hidden");
    });
    fragment.appendChild(button);
  }

  el.geneGlobalSuggestBox.appendChild(fragment);
  el.geneGlobalSuggestBox.classList.remove("hidden");
}

async function loadGeneBucket(bucketName) {
  if (state.geneBucketCache.has(bucketName)) {
    return state.geneBucketCache.get(bucketName);
  }

  const payload = await fetchJson(`${DATA_ROOT}/gene/${bucketName}`);
  state.geneBucketCache.set(bucketName, payload);
  return payload;
}

async function loadGlobalGeneResults(geneSymbol) {
  const normalized = normalizeGene(geneSymbol);
  if (!normalized) {
    renderTableEmpty(el.geneGlobalResults, "Type a gene symbol to search all pairs.");
    return;
  }

  const bucketName = state.geneBuckets[normalized];
  if (!bucketName) {
    renderTableEmpty(el.geneGlobalResults, "Gene not found.");
    return;
  }

  const bucket = await loadGeneBucket(bucketName);
  const entries = Array.isArray(bucket[normalized]) ? bucket[normalized] : [];

  if (!entries.length) {
    renderTableEmpty(el.geneGlobalResults, "No therapy pairs found for this gene.");
    return;
  }

  const ordered = [...entries].sort((a, b) => rankNumber(a.rank) - rankNumber(b.rank));
  el.geneGlobalResults.innerHTML = "";

  for (const item of ordered) {
    const pairLabel = formatTherapyDisplay(item.therapy_id, item.display);
    const rankValue = Number.isFinite(Number(item.rank)) ? Number(item.rank) : "";
    const row = document.createElement("tr");
    row.innerHTML = `<td>${pairLabel}</td><td>${scoreDisplay(item.score)}</td><td>${rankValue}</td>`;
    el.geneGlobalResults.appendChild(row);
  }
}

async function init() {
  try {
    const [meta, therapyPairs, therapyFiles, genes, geneBuckets] = await Promise.all([
      fetchJson(`${DATA_ROOT}/index/meta.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_pairs.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_files.json`),
      fetchJson(`${DATA_ROOT}/index/genes.json`),
      fetchJson(`${DATA_ROOT}/index/gene_buckets.json`),
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
    state.genes = Array.isArray(genes) ? genes : [];
    state.geneBuckets = geneBuckets || {};

    setupBiomarkerOptions();
    resetPairResults();
    resetGlobalGeneResults();

    el.pairTab.addEventListener("click", () => setActiveTab("pair"));
    el.geneTab.addEventListener("click", () => setActiveTab("gene"));

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
      await loadPairResults(therapyId);
    });

    el.pairGeneSearch.addEventListener("input", () => {
      const term = el.pairGeneSearch.value;
      applyPairGeneSearch(term);
      renderPairGeneSuggestions(getPairGeneSuggestions(term));
    });

    el.geneGlobalSearch.addEventListener("input", async () => {
      const term = el.geneGlobalSearch.value;
      const matches = findGlobalGeneMatches(term);
      renderGlobalGeneSuggestions(matches);

      const normalized = normalizeGene(term);
      if (!normalized) {
        renderTableEmpty(el.geneGlobalResults, "Type a gene symbol to search all pairs.");
        return;
      }

      if (state.lastGlobalGeneMatches.length === 1 && state.lastGlobalGeneMatches[0] === normalized) {
        await loadGlobalGeneResults(normalized);
      }
    });

    el.geneGlobalSearch.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      const exact = normalizeGene(el.geneGlobalSearch.value);
      if (exact && state.geneBuckets[exact]) {
        await loadGlobalGeneResults(exact);
        el.geneGlobalSuggestBox.classList.add("hidden");
        return;
      }

      if (state.lastGlobalGeneMatches.length > 0) {
        const first = state.lastGlobalGeneMatches[0];
        el.geneGlobalSearch.value = first;
        await loadGlobalGeneResults(first);
        el.geneGlobalSuggestBox.classList.add("hidden");
      }
    });

    document.addEventListener("click", (event) => {
      if (event.target !== el.pairGeneSearch && !el.pairGeneSuggestBox.contains(event.target)) {
        el.pairGeneSuggestBox.classList.add("hidden");
      }
      if (event.target !== el.geneGlobalSearch && !el.geneGlobalSuggestBox.contains(event.target)) {
        el.geneGlobalSuggestBox.classList.add("hidden");
      }
    });
  } catch (error) {
    console.error(error);
    renderTableEmpty(el.pairResults, "Unable to load data files.");
    renderTableEmpty(el.geneGlobalResults, "Unable to load data files.");
    el.pairResultsWrap.classList.remove("hidden");
  }
}

init();
