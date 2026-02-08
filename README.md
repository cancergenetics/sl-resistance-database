# SL Resistance Prediction Static Explorer

Static web app for exploring synthetic-lethal therapy resistance predictions with no backend.

## Files

- `/Users/metinyazar/Desktop/prediction_database/build_static_data.py`: CSV -> JSON generator.
- `/Users/metinyazar/Desktop/prediction_database/index.html`, `/Users/metinyazar/Desktop/prediction_database/styles.css`, `/Users/metinyazar/Desktop/prediction_database/app.js`: static frontend.
- `/Users/metinyazar/Desktop/prediction_database/dist/`: generated data used by the frontend.

## 1) Generate static data

By default, the script reads all files matching:

- `PredictingSLResistanceFeatures*_pred.csv`

Run:

```bash
python3 build_static_data.py
```

Useful options:

```bash
# Use a single CSV
python3 build_static_data.py --input "PredictingSLResistanceFeatures_BRCA1_ATR_main_withfeatures_pred.csv"

# Keep all rows (disable Top-N truncation)
python3 build_static_data.py --top-n 0

# If lower score means better rank
python3 build_static_data.py --lower-score-better
```

Column mapping is controlled at the top of `build_static_data.py` in `COLUMN_MAP_OVERRIDES`.

## 2) Serve locally

From `/Users/metinyazar/Desktop/prediction_database`:

```bash
python3 -m http.server 8000
```

Open:

- `http://localhost:8000`

## 3) Deploy as a static site

Any static host works (GitHub Pages, Netlify, Vercel static, S3 static hosting).

Publish this folder's static assets:

- `index.html`
- `styles.css`
- `app.js`
- `dist/`

No server/API is required.

## Data model produced

- `dist/index/alias_maps.json`
- `dist/index/therapy_pairs.json`
- `dist/index/genes.json`
- `dist/index/therapy_files.json`
- `dist/index/gene_buckets.json`
- `dist/therapy/<therapy_id>.json`
- `dist/gene/gene_bucket_<xx>.json`

Frontend behavior:

- Therapy Pair view: `Rank`, `Gene`, `PredictionScore`.
- Gene view: `TherapyPair`, `Rank`, `PredictionScore`.
- Global search resolves therapy aliases and gene aliases using normalized keys.
