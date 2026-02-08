const DATA_ROOT = "./dist";

const state = {
  meta: null,
  aliasMaps: null,
  therapyPairs: [],
  genes: [],
  therapyFiles: {},
  geneBuckets: {},
  geneBucketCache: new Map(),
};

const el = {
  metaInfo: document.getElementById("meta-info"),
  searchInput: document.getElementById("global-search"),
  searchButton: document.getElementById("search-button"),
  searchFeedback: document.getElementById("search-feedback"),
  therapyTab: document.getElementById("therapy-tab"),
  geneTab: document.getElementById("gene-tab"),
  therapyView: document.getElementById("therapy-view"),
  geneView: document.getElementById("gene-view"),
  therapySelect: document.getElementById("therapy-select"),
  geneSelect: document.getElementById("gene-select"),
  therapyResults: document.getElementById("therapy-results"),
  geneResults: document.getElementById("gene-results"),
  therapyTopnNote: document.getElementById("therapy-topn-note"),
};

function normalizeKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function scoreDisplay(score) {
  const number = Number(score);
  if (Number.isNaN(number)) {
    return "";
  }
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }
  return response.json();
}

function setActiveTab(tabName) {
  const isTherapy = tabName === "therapy";
  el.therapyTab.classList.toggle("active", isTherapy);
  el.geneTab.classList.toggle("active", !isTherapy);
  el.therapyView.classList.toggle("active", isTherapy);
  el.geneView.classList.toggle("active", !isTherapy);
}

function setFeedback(text) {
  el.searchFeedback.innerHTML = text || "";
}

function fillSelect(selectEl, options, valueKey, labelKey) {
  selectEl.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option[valueKey];
    node.textContent = option[labelKey];
    selectEl.appendChild(node);
  }
}

function renderEmpty(tbody, message, colSpan) {
  tbody.innerHTML = "";
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-row";
  cell.colSpan = colSpan;
  cell.textContent = message;
  row.appendChild(cell);
  tbody.appendChild(row);
}

async function renderTherapy(therapyId) {
  const file = state.therapyFiles[therapyId];
  if (!file) {
    renderEmpty(el.therapyResults, "Therapy pair not found.", 3);
    return;
  }

  const data = await fetchJson(`${DATA_ROOT}/${file}`);
  el.therapyResults.innerHTML = "";

  if (!data.results || data.results.length === 0) {
    renderEmpty(el.therapyResults, "No results for this therapy pair.", 3);
    return;
  }

  for (const item of data.results) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${item.rank}</td><td>${item.gene}</td><td>${scoreDisplay(item.score)}</td>`;
    el.therapyResults.appendChild(row);
  }
}

async function loadGeneBucket(bucketName) {
  if (state.geneBucketCache.has(bucketName)) {
    return state.geneBucketCache.get(bucketName);
  }

  const payload = await fetchJson(`${DATA_ROOT}/gene/${bucketName}`);
  state.geneBucketCache.set(bucketName, payload);
  return payload;
}

async function renderGene(geneSymbol) {
  const bucketName = state.geneBuckets[geneSymbol];
  if (!bucketName) {
    renderEmpty(el.geneResults, "Gene not found.", 3);
    return;
  }

  const bucket = await loadGeneBucket(bucketName);
  const entries = bucket[geneSymbol] || [];
  el.geneResults.innerHTML = "";

  if (entries.length === 0) {
    renderEmpty(el.geneResults, "No therapy pairs found for this gene.", 3);
    return;
  }

  for (const item of entries) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${item.display}</td><td>${item.rank}</td><td>${scoreDisplay(item.score)}</td>`;
    el.geneResults.appendChild(row);
  }
}

function findSuggestions(rawTerm, maxItems = 5) {
  const norm = normalizeKey(rawTerm);
  if (!norm) {
    return [];
  }

  const therapyMatches = state.therapyPairs
    .filter((pair) => normalizeKey(pair.display).includes(norm))
    .slice(0, maxItems)
    .map((pair) => ({ type: "therapy", value: pair.id, label: pair.display }));

  const geneMatches = state.genes
    .filter((gene) => gene.symbol.includes(rawTerm.toUpperCase()))
    .slice(0, maxItems)
    .map((gene) => ({ type: "gene", value: gene.symbol, label: gene.symbol }));

  return [...therapyMatches, ...geneMatches].slice(0, maxItems);
}

async function resolveSearch() {
  const term = el.searchInput.value.trim();
  const normalized = normalizeKey(term);
  if (!normalized) {
    setFeedback("Type a therapy pair or a gene symbol.");
    return;
  }

  const therapyId = state.aliasMaps.therapy_pairs[normalized];
  if (therapyId) {
    el.therapySelect.value = therapyId;
    await renderTherapy(therapyId);
    setActiveTab("therapy");
    setFeedback(`Matched therapy pair: <strong>${state.therapyPairs.find((x) => x.id === therapyId)?.display || therapyId}</strong>`);
    return;
  }

  const gene = state.aliasMaps.genes[normalized];
  if (gene) {
    el.geneSelect.value = gene;
    await renderGene(gene);
    setActiveTab("gene");
    setFeedback(`Matched gene: <strong>${gene}</strong>`);
    return;
  }

  const suggestions = findSuggestions(term);
  if (suggestions.length === 0) {
    setFeedback("No match found.");
    return;
  }

  const links = suggestions
    .map((s, idx) => `<a href="#" class="suggestion-link" data-suggestion="${idx}">${s.type}: ${s.label}</a>`)
    .join(" | ");
  setFeedback(`No exact match. Try: ${links}`);

  const feedbackNode = el.searchFeedback;
  feedbackNode.querySelectorAll("a[data-suggestion]").forEach((anchor) => {
    anchor.addEventListener("click", async (event) => {
      event.preventDefault();
      const item = suggestions[Number(anchor.dataset.suggestion)];
      if (!item) {
        return;
      }
      if (item.type === "therapy") {
        el.therapySelect.value = item.value;
        await renderTherapy(item.value);
        setActiveTab("therapy");
      } else {
        el.geneSelect.value = item.value;
        await renderGene(item.value);
        setActiveTab("gene");
      }
      setFeedback("");
    });
  });
}

async function init() {
  try {
    const [meta, aliasMaps, therapyPairs, genes, therapyFiles, geneBuckets] = await Promise.all([
      fetchJson(`${DATA_ROOT}/index/meta.json`),
      fetchJson(`${DATA_ROOT}/index/alias_maps.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_pairs.json`),
      fetchJson(`${DATA_ROOT}/index/genes.json`),
      fetchJson(`${DATA_ROOT}/index/therapy_files.json`),
      fetchJson(`${DATA_ROOT}/index/gene_buckets.json`),
    ]);

    state.meta = meta;
    state.aliasMaps = aliasMaps;
    state.therapyPairs = therapyPairs;
    state.genes = genes;
    state.therapyFiles = therapyFiles;
    state.geneBuckets = geneBuckets;

    if (meta.top_n) {
      el.therapyTopnNote.textContent = `Showing Top-${meta.top_n} only.`;
    } else {
      el.therapyTopnNote.textContent = "Showing all ranked genes.";
    }

    fillSelect(el.therapySelect, therapyPairs, "id", "display");
    fillSelect(el.geneSelect, genes, "symbol", "symbol");

    if (therapyPairs.length > 0) {
      await renderTherapy(therapyPairs[0].id);
    } else {
      renderEmpty(el.therapyResults, "No therapy pairs available.", 3);
    }

    if (genes.length > 0) {
      await renderGene(genes[0].symbol);
    } else {
      renderEmpty(el.geneResults, "No genes available.", 3);
    }

    el.therapyTab.addEventListener("click", () => setActiveTab("therapy"));
    el.geneTab.addEventListener("click", () => setActiveTab("gene"));

    el.therapySelect.addEventListener("change", async (event) => {
      await renderTherapy(event.target.value);
    });

    el.geneSelect.addEventListener("change", async (event) => {
      await renderGene(event.target.value);
    });

    el.searchButton.addEventListener("click", resolveSearch);
    el.searchInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        await resolveSearch();
      }
    });
  } catch (error) {
    console.error(error);
    renderEmpty(el.therapyResults, "Unable to load data files.", 3);
    renderEmpty(el.geneResults, "Unable to load data files.", 3);
  }
}

init();
