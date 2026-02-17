function resolveBasePath() {
  const { origin, pathname } = window.location;
  const cleanPath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const base = cleanPath && !cleanPath.endsWith(".html")
    ? cleanPath
    : cleanPath.slice(0, cleanPath.lastIndexOf("/"));
  return `${origin}${base}`;
}

const BASE_PATH = resolveBasePath();
const DATA_ROOT = `${BASE_PATH}/dist`;
const CLINICAL_TRIALS_PATH = `${BASE_PATH}/SL_clinical_trials.csv`;
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
  pairRenderedRows: [],
  globalRenderedRows: [],
  lastGlobalGeneMatches: [],
  clinicalTrialMap: new Map(),
};

const el = {
  metaInfo: document.getElementById("meta-info"),
  aboutToggle: document.getElementById("about-toggle"),
  aboutPanel: document.getElementById("about-panel"),
  pairTab: document.getElementById("pair-tab"),
  geneTab: document.getElementById("gene-tab"),
  pairView: document.getElementById("pair-view"),
  geneView: document.getElementById("gene-view"),

  biomarkerSelect: document.getElementById("biomarker-select"),
  targetSelect: document.getElementById("target-select"),
  pairResultsWrap: document.getElementById("pair-results-wrap"),
  clinicalTrialInfo: document.getElementById("clinical-trial-info"),
  clinicalTrialSummary: document.getElementById("clinical-trial-summary"),
  clinicalTrialLines: document.getElementById("clinical-trial-lines"),
  pairTopnNote: document.getElementById("therapy-topn-note"),
  pairGeneSearch: document.getElementById("pair-gene-search"),
  pairGeneSuggestBox: document.getElementById("gene-suggest-box"),
  pairResults: document.getElementById("therapy-results"),
  pairDownloadCsv: document.getElementById("pair-download-csv"),
  pairDownloadAllCsv: document.getElementById("pair-download-all-csv"),

  geneGlobalSearch: document.getElementById("gene-global-search"),
  geneGlobalSuggestBox: document.getElementById("gene-global-suggest-box"),
  geneGlobalResults: document.getElementById("gene-global-results"),
  geneDownloadCsv: document.getElementById("gene-download-csv"),
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

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${path} (${response.status})`);
  }
  return response.text();
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

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function normalizeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");
}

function rankDisplay(value) {
  const rank = Number(value);
  return Number.isFinite(rank) ? rank : "";
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = i + 1 < line.length ? line[i + 1] : "";

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function detectDelimiter(headerLine) {
  const commaCount = (headerLine.match(/,/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseClinicalTrialCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return [];
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseDelimitedLine(lines[0], delimiter);
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseDelimitedLine(lines[i], delimiter);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = values[j] !== undefined ? values[j].trim() : "";
    }
    rows.push(row);
  }

  return rows;
}

function getRowField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  const normalizedEntries = Object.entries(row).map(([key, value]) => [
    String(key || "").trim().toLowerCase(),
    String(value || "").trim(),
  ]);

  for (const key of keys) {
    const needle = String(key || "").trim().toLowerCase();
    const match = normalizedEntries.find(([header, value]) => header === needle && value);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function buildClinicalTrialMap(rows) {
  const map = new Map();

  for (const row of rows) {
    const biomarker = getRowField(row, ["Biomarker"]);
    const target = getRowField(row, ["Target"]);
    if (!biomarker || !target) {
      continue;
    }

    const key = `${biomarker}__${target}`;
    if (!map.has(key)) {
      map.set(key, {
        biomarker,
        biomarkerApprovedName: getRowField(row, ["Biomarker approved name"]),
        target,
        targetApprovedName: getRowField(row, ["Target approved name"]),
        trials: [],
      });
    }

    const entry = map.get(key);
    if (!entry.biomarkerApprovedName) {
      entry.biomarkerApprovedName = getRowField(row, ["Biomarker approved name"]);
    }
    if (!entry.targetApprovedName) {
      entry.targetApprovedName = getRowField(row, ["Target approved name"]);
    }

    entry.trials.push({
      nct: getRowField(row, ["Clinical trial"]),
      phase: getRowField(row, ["Phase"]),
      agent: getRowField(row, ["Agent", "agent"]),
      cohort: getRowField(row, ["Cancer cohort"]),
      clinicalTrialLink: getRowField(row, ["Clinical trial link", "clinical trial link"]),
      agentLink: getRowField(row, ["ChEMBL drug link", "ChEMBL Drug link", "agent link", "Agent link"]),
    });
  }

  return map;
}

function safeHttpUrl(url) {
  const value = String(url || "").trim();
  return /^https?:\/\//i.test(value) ? value : "";
}

function appendLinkedText(parent, text, url) {
  const link = safeHttpUrl(url);
  if (!link) {
    parent.appendChild(document.createTextNode(text));
    return;
  }

  const anchor = document.createElement("a");
  anchor.href = link;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = text;
  parent.appendChild(anchor);
}

function renderClinicalTrialInfo(pair) {
  if (!pair) {
    el.clinicalTrialInfo.classList.add("hidden");
    el.clinicalTrialSummary.textContent = "";
    el.clinicalTrialLines.innerHTML = "";
    return;
  }

  const key = `${pair.biomarker}__${pair.target}`;
  const entry = state.clinicalTrialMap.get(key);

  el.clinicalTrialInfo.classList.remove("hidden");
  el.clinicalTrialLines.innerHTML = "";

  if (!entry) {
    el.clinicalTrialSummary.textContent = "";
    const emptyLine = document.createElement("p");
    emptyLine.className = "trial-empty";
    emptyLine.textContent = "No curated clinical trial entry found for this pair.";
    el.clinicalTrialLines.appendChild(emptyLine);
    return;
  }

  const biomarkerApproved = entry.biomarkerApprovedName || "N/A";
  const targetApproved = entry.targetApprovedName || "N/A";
  el.clinicalTrialSummary.textContent =
    `Biomarker: ${entry.biomarker} - ${biomarkerApproved}, ` +
    `Target: ${entry.target} - ${targetApproved}.`;

  entry.trials.forEach((trial, index) => {
    const line = document.createElement("p");
    line.className = "trial-line";
    const trialId = trial.nct || "N/A";
    const agent = trial.agent || "N/A";
    const phase = trial.phase ? `Phase ${trial.phase}` : "Phase N/A";
    const cohort = trial.cohort || "unspecified cohort";
    line.appendChild(document.createTextNode(`Clinical Trial ${index + 1}: `));
    appendLinkedText(line, trialId, trial.clinicalTrialLink);
    line.appendChild(document.createTextNode(" ("));
    appendLinkedText(line, agent, trial.agentLink);
    line.appendChild(document.createTextNode(` - ${phase}) in ${cohort}.`));
    el.clinicalTrialLines.appendChild(line);
  });
}

function setAboutPanelOpen(open) {
  el.aboutToggle.setAttribute("aria-expanded", String(open));
  el.aboutPanel.setAttribute("aria-hidden", String(!open));
  el.aboutPanel.classList.toggle("hidden", !open);
  if (open) {
    el.aboutPanel.focus();
  }
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
  state.pairRenderedRows = [];
  renderClinicalTrialInfo(null);
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
  state.pairRenderedRows = rows.map((item) => ({
    gene: item.gene,
    score: item.score,
    rank: item.rank,
  }));
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
    if (!gene || !normalizeGene(gene).startsWith(term) || unique.has(gene)) {
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

  const matches = state.currentResults.filter((item) => normalizeGene(item.gene).startsWith(term));
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
  renderClinicalTrialInfo(pair || null);

  el.pairTopnNote.textContent = `Showing Top-${DEFAULT_TOP_N} genes for ${pairLabel}. Use gene search to find any gene in this pair.`;
  el.pairGeneSearch.value = "";
  el.pairGeneSuggestBox.classList.add("hidden");
  el.pairGeneSuggestBox.innerHTML = "";
  el.pairResultsWrap.classList.remove("hidden");

  if (!state.currentResults.length) {
    state.pairRenderedRows = [];
    renderTableEmpty(el.pairResults, "No results for this therapy pair.");
    return;
  }

  renderPairRows(state.currentResults.slice(0, DEFAULT_TOP_N));
}

function resetGlobalGeneResults() {
  state.globalRenderedRows = [];
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
    state.globalRenderedRows = [];
    renderTableEmpty(el.geneGlobalResults, "Type a gene symbol to search all pairs.");
    return;
  }

  const bucketName = state.geneBuckets[normalized];
  if (!bucketName) {
    state.globalRenderedRows = [];
    renderTableEmpty(el.geneGlobalResults, "Gene not found.");
    return;
  }

  const bucket = await loadGeneBucket(bucketName);
  const entries = Array.isArray(bucket[normalized]) ? bucket[normalized] : [];

  if (!entries.length) {
    state.globalRenderedRows = [];
    renderTableEmpty(el.geneGlobalResults, "No therapy pairs found for this gene.");
    return;
  }

  const ordered = [...entries].sort((a, b) => rankNumber(a.rank) - rankNumber(b.rank));
  state.globalRenderedRows = ordered.map((item) => ({
    therapyPair: formatTherapyDisplay(item.therapy_id, item.display),
    score: item.score,
    rank: item.rank,
  }));
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
    const [meta, therapyPairs, therapyFiles, genes, geneBuckets, clinicalTrialText] = await Promise.all([
      fetchJson(`${DATA_ROOT}/index/meta.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_pairs.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_files.json`),
      fetchJson(`${DATA_ROOT}/index/genes.json`),
      fetchJson(`${DATA_ROOT}/index/gene_buckets.json`),
      fetchText(CLINICAL_TRIALS_PATH).catch(() => ""),
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
    state.clinicalTrialMap = buildClinicalTrialMap(parseClinicalTrialCsv(clinicalTrialText));

    setupBiomarkerOptions();
    resetPairResults();
    resetGlobalGeneResults();
    setAboutPanelOpen(false);

    el.pairTab.addEventListener("click", () => setActiveTab("pair"));
    el.geneTab.addEventListener("click", () => setActiveTab("gene"));
    el.aboutToggle.addEventListener("click", () => {
      const expanded = el.aboutToggle.getAttribute("aria-expanded") === "true";
      setAboutPanelOpen(!expanded);
    });

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

    el.pairDownloadCsv.addEventListener("click", () => {
      if (!state.currentResults.length) {
        return;
      }
      const pair = state.therapyPairs.find((item) => item.id === state.currentTherapyId);
      const pairLabel = pair ? pair.display : "pair_results";
      const topRows = state.currentResults.slice(0, DEFAULT_TOP_N);
      downloadCsv(
        `biomarker_target_${normalizeFilePart(pairLabel)}_top100.csv`,
        ["Gene", "Prediction Score", "Prediction Rank"],
        topRows.map((row) => [row.gene, scoreDisplay(row.score), rankDisplay(row.rank)])
      );
    });

    el.pairDownloadAllCsv.addEventListener("click", () => {
      if (!state.currentResults.length) {
        return;
      }
      const pair = state.therapyPairs.find((item) => item.id === state.currentTherapyId);
      const pairLabel = pair ? pair.display : "pair_results";
      downloadCsv(
        `biomarker_target_${normalizeFilePart(pairLabel)}_all_genes.csv`,
        ["Gene", "Prediction Score", "Prediction Rank"],
        state.currentResults.map((row) => [row.gene, scoreDisplay(row.score), rankDisplay(row.rank)])
      );
    });

    el.geneDownloadCsv.addEventListener("click", () => {
      if (!state.globalRenderedRows.length) {
        return;
      }
      const gene = normalizeGene(el.geneGlobalSearch.value) || "gene";
      downloadCsv(
        `gene_${normalizeFilePart(gene)}_all_pairs.csv`,
        ["Therapy Pair", "Prediction Score", "Prediction Rank"],
        state.globalRenderedRows.map((row) => [row.therapyPair, scoreDisplay(row.score), rankDisplay(row.rank)])
      );
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
