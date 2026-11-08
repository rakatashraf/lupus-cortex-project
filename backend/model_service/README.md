# Lupus Cortex Model Service v4 — Mac notebook models as a local API

Serves the **v4 full model — Random Forest + LSTM + frozen §13 ensemble**
trained in the Mac Jupyter notebook (full 2015–2025 window, **RF 18/18 and
LSTM 18/18 complete**) as **schema v3** analysis reports, the same report
shape the frontend dashboard already reads. It mirrors the canonical v3
service (`~/workspace/lupus_repo/backend/model_service/model_api_v3.py`)
without editing it: the v3 service expects one combined pickle of old v2
models, while v4 models are per-component bare `RandomForestRegressor`s
(`rf_model_{cid}.joblib`, ~12 GB total) plus per-component LSTM models
(`lstm_model_{cid}.keras`, ~7 MB total) that stay on the Mac and are loaded
lazily — RF one at a time, memory-mapped; LSTM all cached after first load.

## How to run (on the Mac)

From a Jupyter cell in the Mac run folder:

```python
%pip install -r requirements-v4-mac.txt
%run run_v4_api.py
```

Or from a terminal in this directory:

```bash
python run_v4_api.py
```

The service listens on `http://127.0.0.1:8100`. Check it with:

```bash
curl http://127.0.0.1:8100/health
```

The launcher resolves the Mac run folder
(`/Users/mobashshira/Downloads/Lupus_Cortex_Local_GPU` by default, or
`LUPUS_V4_RUN_DIR`), verifies the models directory and the preprocessing
stats file exist, and prints a clear error naming the missing path if not.
Set `LUPUS_V4_MODELS_DIR` / `LUPUS_V4_PREPROC_STATS` directly to override.

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /` | Service info, schema/model versions, endpoint list |
| `GET /health` | Branch status (`rf` operational + model count, `lstm` operational + model count, `ensemble` frozen §13 status), `rf_models_available`, `lstm_models_available`, `ensemble_weights_available`, schema version |
| `POST /predict` | 18 RF + 18 LSTM + 18 ensemble predictions for a lat/lon/date (`{lat, lon, name?, date?}`) |
| `POST /api/analyze` | Full schema v3 report for a lat/lon/date; every call is logged to `logs/analysis_log.jsonl` |
| `POST /api/dashboard` | Alias of `/api/analyze` |
| `POST /api/extract` | Accepts a data-extractor bundle, appends it to `logs/extractions.jsonl`, returns `{"accepted": true}` |
| `POST /api/scenario` | Baseline report + documented assumption deltas (assumption-based, not model-predicted) |

The frontend dashboard reads `report.time.analyzed_at` (present alongside
`analysis_utc`, same value) and the report's `components`, `indices`, `hwi`,
`warnings`, and `recommendations`.

## Files

- `model_api_v4.py` — the FastAPI service (lazy, one-model-at-a-time loading).
- `report_schema_v3.py`, `index_detail.py` — vendored **verbatim** from the
  canonical v3 service (header comment notes the source; edit the canonical
  file and re-vendor, never these copies).
- `run_v4_api.py` — launcher (resolves Mac paths, verifies files, runs uvicorn).
- `requirements-v4-mac.txt` — fastapi, uvicorn, pydantic only (sklearn/numpy
  come from the Mac `.venv` that trained the models).
- `test_v4_smoke.py` — smoke test with stub models (runs on the VM, see below).

## Honest limits — read before trusting a report

- **Median-feature inference (no live history).** There is no live recent
  history at request time, so lag/roll features use per-component **training
  medians**, missing flags are 1, and reference/threshold features use the
  training medians. Every report discloses this in its `data_quality`
  notes and provenance. Predictions are median-conditioned estimates, **not**
  forecasts built from observed recent history.
- **Full model (RF + LSTM + ensemble, 18/18).** Served components: C01–C11, C15, C17–C20, C28, C30a.
  The served value per component is the frozen §13 ensemble blend of the RF and
  LSTM predictions (inverse-MAE weights from `artifacts_v4mac/hybrid_config.json`;
  the 7 components with no validation window use the documented 0.5/0.5
  equal-weight default, NOT fitted on test). RF and LSTM values are shown per
  component in the report. Ensemble test R² 0.978 on the common 182,952-row
  chronological test set (11 components with validation data).
  Unavailable (no trained model, never invented): C12, C13, C14, C21–C27,
  C29a. C29b (2.5) and C30b (20.7) are static measured values, as in v3.
  C16 is derived from the C15 ensemble prediction (95th-percentile exceedance).
- **Below-persistence RF components.** Validation R² is below the
  persistence baseline for **C02 (0.443 vs 0.492), C05 (0.757 vs 0.761),
  C06 (0.665 vs 0.705)** — these predictions are weaker than carrying the
  last observed value forward. This is flagged on the component and in the
  report notes.
- **C08 / C11 have no validation metrics** (no Aug–Sep 2025 validation
  window); served on the train-split fit only. The same seven components
  (C08, C11, C18, C19, C20, C28, C30a) also have no LSTM validation
  metrics and use the 0.5/0.5 equal-weight ensemble default.
- **LSTM median-sequence inference (no live history).** The LSTM 30-day input
  sequence is built from per-component training medians (value_lag1 median as
  the value_fused proxy; day-of-year from the requested date), in the same
  regime as the RF median-feature inference. Every report discloses this.
- **Local only.** The service binds `127.0.0.1:8100` on the Mac. The public
  GitHub Pages site **cannot** reach it — the 12 GB models stay on the Mac.
  The dashboard works when the page is opened on the Mac with this service
  running (local `file://` or `localhost` page), and falls back to its
  honest "awaiting model" state otherwise.
- **One RF model at a time; LSTM models all cached.** RF models load lazily
  and are evicted on switch, so a full `/api/analyze` loads 18 RF models in
  sequence (~12 GB total on disk). Expect the first call to take a while;
  repeat calls for the same component reuse the cached model. The 18 LSTM
  models (~7 MB total) are all cached after first load.
- **Validation is checked, not assumed.** Every `/api/analyze` response
  passes `validate_report()`; a failure raises HTTP 500 with the errors
  instead of returning an invalid report.

## Smoke test (VM)

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-v4-mac.txt \
  scikit-learn joblib numpy pandas httpx
.venv/bin/python test_v4_smoke.py
```

Builds tiny stub RF models (18 features), stub stats/checkpoints/ref CSV,
and asserts health, analyze, dashboard, extract, predict, and scenario
behave per the contract.
