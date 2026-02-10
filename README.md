# SL Resistance Database

> **Note:** This project is currently in development. If you have questions, suggestions, or want to contribute, open an issue on GitHub.

Interactive explorer for synthetic lethality (SL) resistance predictions.

**Live:** https://metinyazar.github.io/sl-resistance-database/

## Data Structure

```text
dist/
├─ index/
│  ├─ alias_maps.json      # Normalized aliases -> canonical therapy/gene IDs
│  ├─ therapy_pairs.json   # Therapy pair metadata
│  ├─ therapy_files.json   # Therapy ID -> JSON file mapping
│  ├─ genes.json           # Gene list used for search
│  └─ gene_buckets.json    # Gene -> bucket file mapping
├─ therapy/
│  ├─ BRCA1_ATR.json       # Ranked resistance results for one SL pair
│  └─ ...                  # One file per therapy pair
└─ gene/
   ├─ gene_bucket_00.json  # Gene-centric results bucket
   └─ ...                  # Bucketed gene result files
```
