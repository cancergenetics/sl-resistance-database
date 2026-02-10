# Static Database Quick Guide

This project is a static SL-resistance database viewer.  
No backend or API is required.

## Build data

From `/Users/metinyazar/Desktop/prediction_database`:

```bash
python3 build_static_data.py
```

This generates JSON files in `/Users/metinyazar/Desktop/prediction_database/dist`.

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Use the app

1. Search a therapy pair to view ranked resistance genes.
2. Search a gene to view its scores across therapy pairs.
3. Results are read from static JSON in `dist/`.

## Deploy

Host these files on any static platform (for example GitHub Pages):

- `/Users/metinyazar/Desktop/prediction_database/index.html`
- `/Users/metinyazar/Desktop/prediction_database/styles.css`
- `/Users/metinyazar/Desktop/prediction_database/app.js`
- `/Users/metinyazar/Desktop/prediction_database/dist/`
