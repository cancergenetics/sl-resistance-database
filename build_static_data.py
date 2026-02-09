#!/usr/bin/env python3
"""Build static JSON assets for SL resistance prediction explorer."""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

# -----------------------------------------------------------------------------
# Config block: update these keys to match your input CSV columns.
# -----------------------------------------------------------------------------
COLUMN_MAP_OVERRIDES = {
    "therapy_pair": "SL_Pair",
    "gene": "Query",
    "rank": None,
    "prediction_score": "Resistance_Score",
}

DEFAULT_INPUT_GLOB = "PredictingSLResistanceFeatures*_pred.csv"
DEFAULT_OUTPUT_DIR = "dist"
TOP_N = 0
NUM_GENE_BUCKETS = 64
HIGHER_SCORE_BETTER = True

# Candidate column names if a column is not explicitly overridden above.
COLUMN_CANDIDATES = {
    "therapy_pair": [
        "therapy_pair",
        "therapy",
        "trial",
        "SL_pair",
        "SL_Pair",
        "drugA+drugB",
        "indication",
    ],
    "gene": ["gene", "Gene", "Query", "query", "hgnc_symbol", "HGNC_symbol"],
    "rank": ["rank", "Rank", "prediction_rank", "predictionRank", "PredictionRank"],
    "prediction_score": [
        "prediction_score",
        "PredictionScore",
        "score",
        "Score",
        "Resistance_Score",
    ],
}


def normalize_key(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def clean_string(value: Optional[str]) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_float(value: str) -> Optional[float]:
    text = clean_string(value)
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if not math.isfinite(number):
        return None
    return number


def parse_rank(value: str) -> Optional[int]:
    text = clean_string(value)
    if not text:
        return None
    try:
        rank = int(float(text))
    except ValueError:
        return None
    if rank <= 0:
        return None
    return rank


def fallback_therapy_from_filename(path: Path) -> str:
    match = re.search(r"PredictingSLResistanceFeatures_(.+?)_main", path.stem, re.IGNORECASE)
    if match:
        return match.group(1)
    return path.stem


def to_therapy_display(raw: str) -> str:
    value = clean_string(raw)
    if not value:
        return "Unknown Therapy"

    if "+" not in value and " " not in value and "__" not in value and "_" in value:
        parts = [piece for piece in value.split("_") if piece]
        if len(parts) > 1:
            return " + ".join(parts)

    value = re.sub(r"\s*\+\s*", " + ", value)
    value = re.sub(r"\s+", " ", value)
    return value


def to_therapy_id(raw: str) -> str:
    text = clean_string(raw).upper()
    if not text:
        return "UNKNOWN_THERAPY"

    text = re.sub(r"\s*\+\s*", "__", text)
    text = re.sub(r"\s*/\s*", "__", text)
    text = text.replace("&", "__")
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"[^A-Z0-9_]", "", text)
    text = re.sub(r"_{3,}", "__", text)
    text = text.strip("_")
    return text or "UNKNOWN_THERAPY"


def bucket_file_name(prefix: str, bucket_num: int, width: int) -> str:
    return f"{prefix}_{bucket_num:0{width}x}.json"


def bucket_for_key(key: str, num_buckets: int) -> int:
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return int(digest, 16) % num_buckets


def resolve_columns(fieldnames: List[str]) -> Dict[str, Optional[str]]:
    available = set(fieldnames)
    resolved: Dict[str, Optional[str]] = {}

    for canonical in ("therapy_pair", "gene", "rank", "prediction_score"):
        override = COLUMN_MAP_OVERRIDES.get(canonical)
        if override:
            if override not in available:
                raise ValueError(
                    f"Configured column '{override}' for '{canonical}' not found. "
                    f"Available columns: {fieldnames}"
                )
            resolved[canonical] = override
            continue

        resolved_col = None
        for candidate in COLUMN_CANDIDATES[canonical]:
            if candidate in available:
                resolved_col = candidate
                break
        resolved[canonical] = resolved_col

    missing_required = [
        name
        for name in ("gene", "prediction_score")
        if not resolved.get(name)
    ]
    if missing_required:
        raise ValueError(f"Missing required canonical columns: {missing_required}")

    return resolved


def dedupe_rows(rows: Iterable[dict], higher_score_better: bool) -> List[dict]:
    best_by_gene: Dict[str, dict] = {}
    for row in rows:
        gene = row["gene"]
        current = best_by_gene.get(gene)
        if current is None:
            best_by_gene[gene] = row
            continue

        row_rank = row.get("rank")
        cur_rank = current.get("rank")

        if row_rank is not None and cur_rank is not None:
            if row_rank < cur_rank:
                best_by_gene[gene] = row
            elif row_rank == cur_rank:
                if higher_score_better and row["score"] > current["score"]:
                    best_by_gene[gene] = row
                if not higher_score_better and row["score"] < current["score"]:
                    best_by_gene[gene] = row
            continue

        if row_rank is not None and cur_rank is None:
            best_by_gene[gene] = row
            continue
        if row_rank is None and cur_rank is not None:
            continue

        if higher_score_better and row["score"] > current["score"]:
            best_by_gene[gene] = row
        if not higher_score_better and row["score"] < current["score"]:
            best_by_gene[gene] = row

    return list(best_by_gene.values())


def derive_ranked_results(rows: List[dict], higher_score_better: bool) -> List[dict]:
    if not rows:
        return []

    has_complete_rank = all(row.get("rank") is not None for row in rows)
    if has_complete_rank:
        ordered = sorted(rows, key=lambda r: (r["rank"], r["gene"]))
        return [
            {"rank": int(row["rank"]), "gene": row["gene"], "score": float(row["score"])}
            for row in ordered
        ]

    ordered = sorted(
        rows,
        key=lambda r: (
            -r["score"] if higher_score_better else r["score"],
            r["gene"],
        ),
    )
    results = []
    for idx, row in enumerate(ordered, start=1):
        results.append({"rank": idx, "gene": row["gene"], "score": float(row["score"])})
    return results


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")


def collect_rows(
    csv_paths: List[Path],
    higher_score_better: bool,
) -> Tuple[Dict[str, dict], int]:
    therapies: Dict[str, dict] = {}
    row_count = 0

    for csv_path in csv_paths:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                continue

            columns = resolve_columns(reader.fieldnames)
            therapy_col = columns.get("therapy_pair")
            gene_col = columns["gene"]
            rank_col = columns.get("rank")
            score_col = columns["prediction_score"]

            for row in reader:
                gene = clean_string(row.get(gene_col)).upper()
                if not gene:
                    continue

                score = parse_float(row.get(score_col, ""))
                if score is None:
                    continue

                therapy_raw = ""
                if therapy_col:
                    therapy_raw = clean_string(row.get(therapy_col, ""))
                if not therapy_raw:
                    therapy_raw = fallback_therapy_from_filename(csv_path)

                therapy_display = to_therapy_display(therapy_raw)
                therapy_id = to_therapy_id(therapy_raw)
                rank_value = parse_rank(row.get(rank_col, "")) if rank_col else None

                if therapy_id not in therapies:
                    therapies[therapy_id] = {
                        "id": therapy_id,
                        "display": therapy_display,
                        "aliases": set([therapy_display, therapy_raw, therapy_id]),
                        "rows": [],
                    }
                else:
                    therapies[therapy_id]["aliases"].update([therapy_display, therapy_raw, therapy_id])

                therapies[therapy_id]["rows"].append(
                    {
                        "gene": gene,
                        "score": score,
                        "rank": rank_value,
                    }
                )
                row_count += 1

    for therapy in therapies.values():
        therapy["rows"] = dedupe_rows(therapy["rows"], higher_score_better)

    return therapies, row_count


def build_outputs(
    therapies: Dict[str, dict],
    out_dir: Path,
    top_n: Optional[int],
    num_gene_buckets: int,
    higher_score_better: bool,
    input_files: List[Path],
    input_pattern: str,
    source_rows: int,
) -> None:
    index_dir = out_dir / "index"
    therapy_dir = out_dir / "therapy"
    gene_dir = out_dir / "gene"

    index_dir.mkdir(parents=True, exist_ok=True)
    therapy_dir.mkdir(parents=True, exist_ok=True)
    gene_dir.mkdir(parents=True, exist_ok=True)

    alias_maps = {"therapy_pairs": {}, "genes": {}}
    therapy_pairs = []
    therapy_files = {}
    gene_symbols = set()
    gene_reverse = defaultdict(list)

    for therapy_id in sorted(therapies):
        therapy = therapies[therapy_id]
        results = derive_ranked_results(therapy["rows"], higher_score_better)
        if top_n is not None and top_n > 0:
            results = results[:top_n]

        therapy_payload = {
            "therapy_id": therapy_id,
            "display": therapy["display"],
            "results": results,
        }

        therapy_filename = f"{therapy_id}.json"
        write_json(therapy_dir / therapy_filename, therapy_payload)
        therapy_files[therapy_id] = f"therapy/{therapy_filename}"

        aliases = sorted({clean_string(a) for a in therapy["aliases"] if clean_string(a)})
        for alias in aliases:
            norm_alias = normalize_key(alias)
            if norm_alias and norm_alias not in alias_maps["therapy_pairs"]:
                alias_maps["therapy_pairs"][norm_alias] = therapy_id

        therapy_pairs.append(
            {
                "id": therapy_id,
                "display": therapy["display"],
                "aliases": aliases,
            }
        )

        for item in results:
            gene = item["gene"]
            gene_symbols.add(gene)
            gene_reverse[gene].append(
                {
                    "therapy_id": therapy_id,
                    "display": therapy["display"],
                    "rank": item["rank"],
                    "score": item["score"],
                }
            )

    genes_payload = []
    gene_buckets_map = {}
    bucket_width = max(2, len(f"{num_gene_buckets - 1:x}"))
    bucket_data = defaultdict(dict)

    for gene in sorted(gene_symbols):
        aliases = [gene, gene.lower()]
        genes_payload.append({"symbol": gene, "aliases": aliases})

        for alias in aliases:
            norm_alias = normalize_key(alias)
            if norm_alias and norm_alias not in alias_maps["genes"]:
                alias_maps["genes"][norm_alias] = gene

        entries = sorted(gene_reverse[gene], key=lambda x: (x["rank"], x["therapy_id"]))
        bucket_num = bucket_for_key(gene, num_gene_buckets)
        bucket_name = bucket_file_name("gene_bucket", bucket_num, bucket_width)
        gene_buckets_map[gene] = bucket_name
        bucket_data[bucket_name][gene] = entries

    for bucket_name, payload in bucket_data.items():
        write_json(gene_dir / bucket_name, payload)

    metadata = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "input_pattern": input_pattern,
        "input_files": [str(path.name) for path in input_files],
        "top_n": top_n,
        "num_therapies": len(therapy_pairs),
        "num_genes": len(genes_payload),
        "source_rows": source_rows,
        "score_direction": "higher_is_better" if higher_score_better else "lower_is_better",
    }

    write_json(index_dir / "meta.json", metadata)
    write_json(index_dir / "alias_maps.json", alias_maps)
    write_json(index_dir / "therapy_pairs.json", therapy_pairs)
    write_json(index_dir / "therapy_files.json", therapy_files)
    write_json(index_dir / "genes.json", genes_payload)
    write_json(index_dir / "gene_buckets.json", gene_buckets_map)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static JSON files for SL resistance app.")
    parser.add_argument(
        "--input",
        default=DEFAULT_INPUT_GLOB,
        help="CSV path or glob pattern (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default=DEFAULT_OUTPUT_DIR,
        help="Output directory for generated JSON (default: %(default)s)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=TOP_N,
        help="Keep top N ranked genes per therapy pair (default: all rows). Use 0 for all rows.",
    )
    parser.add_argument(
        "--num-gene-buckets",
        type=int,
        default=NUM_GENE_BUCKETS,
        help="Number of gene bucket files to generate.",
    )
    parser.add_argument(
        "--lower-score-better",
        action="store_true",
        help="Use ascending score order when rank is not present.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    matches = [Path(path) for path in sorted(glob.glob(args.input)) if Path(path).is_file()]
    if not matches:
        raise SystemExit(f"No input files matched pattern: {args.input}")

    top_n = None if args.top_n == 0 else args.top_n
    higher_score_better = not args.lower_score_better

    therapies, source_rows = collect_rows(matches, higher_score_better=higher_score_better)
    if not therapies:
        raise SystemExit("No valid rows found in input CSV(s).")

    out_dir = Path(args.out)
    build_outputs(
        therapies=therapies,
        out_dir=out_dir,
        top_n=top_n,
        num_gene_buckets=args.num_gene_buckets,
        higher_score_better=higher_score_better,
        input_files=matches,
        input_pattern=args.input,
        source_rows=source_rows,
    )

    print(f"Built static data in '{out_dir.resolve()}'")
    print(f"Therapy pairs: {len(therapies)}")
    print(f"Input rows: {source_rows}")
    print(f"Top-N per therapy: {top_n if top_n is not None else 'ALL'}")


if __name__ == "__main__":
    main()
