#!/usr/bin/env python3
"""
Lupus Cortex Model Service v4 — Mac Jupyter notebook models, schema v3 reports.

Serves the v4 Random Forest models trained in the Mac Jupyter notebook
(full 2015-2025 window, 18/18 RF complete) as schema-v3 analysis reports,
mirroring the canonical v3 service (backend/model_service/model_api_v3.py)
without touching it. The v3 service expects ONE combined pickle of old v2
models; v4 models are per-component bare RandomForestRegressors
(rf_model_{cid}.joblib, ~12 GB total) that stay on the Mac and are loaded
lazily, one at a time, memory-mapped.

Model branches:
  - RF (per-component, v4): PRODUCTION. 18 validated models.
  - LSTM (per-component, v4): SERVED. 18 trained models (lstm_model_{cid}.keras
    + per-component StandardScalers in lstm_scalers.joblib). Sequences are
    median-conditioned (see below) — no live history at request time.
  - Ensemble: FROZEN §13. The served value per component is the frozen
    inverse-MAE blend of RF + LSTM (weights from artifacts_v4mac/
    hybrid_config.json). 11 components use validation-fitted weights; the 7
    components with no validation window (C08, C11, C18, C19, C20, C28, C30a)
    use the documented 0.5/0.5 equal-weight default, NOT fitted on test.
    On the common 182,952-row chronological test set (the 11 validation
    components) the ensemble scored R² 0.978 (RF 0.973, LSTM 0.975,
    persistence 0.975).

Inference honesty (disclosed in every report's data_quality notes):
  There is no live recent history at request time, so lag/roll features
  use per-component TRAINING MEDIANS, missing flags are 1, and
  reference/threshold features use the training medians. The LSTM 30-day
  input sequence is likewise median-conditioned (training medians for
  value_fused/value_lag1/value_roll7; day-of-year from the calendar days
  ending at the requested date). Predictions are median-conditioned
  estimates, never presented as if built on observed recent history.

Environment:
  LUPUS_V4_MODELS_DIR     - directory with rf_model_{cid}.joblib (default: ./models)
  LUPUS_V4_PREPROC_STATS  - global_preprocess_stats.json (default: ./global_preprocess_stats.json)
  LUPUS_V4_CHECKPOINTS    - checkpoints.json (default: ./checkpoints.json)
  LUPUS_V4_HYBRID_CONFIG  - hybrid_config.json with frozen §13 ensemble weights
                            (default: <run folder>/artifacts_v4mac/hybrid_config.json)
  LUPUS_REF_CSV           - fixed reference CSV (default: ./reference_dataset/lupus_cortex_fixed_reference_30.csv)
  LUPUS_V4_LOG_DIR        - log directory (default: ./logs)
"""
from __future__ import annotations

import csv
import gc
import json
import math
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

from report_schema_v3 import (
    SCHEMA_VERSION, CANONICAL_COMPONENTS, INDICES, INDEX_DEFS,
    HWI_WEIGHTS, HWI_VERSION, score_label, report_skeleton, validate_report,
)
from index_detail import build_index_detail, build_hwi_detail

BASE = Path(os.environ.get("LUPUS_V4_BASE", ".") or ".")
MODELS_DIR = Path(os.environ.get("LUPUS_V4_MODELS_DIR") or (BASE / "models"))
STATS_PATH = Path(os.environ.get("LUPUS_V4_PREPROC_STATS") or (BASE / "global_preprocess_stats.json"))
CHECKPOINTS_PATH = Path(os.environ.get("LUPUS_V4_CHECKPOINTS") or (BASE / "checkpoints.json"))
HYBRID_CONFIG_PATH = Path(os.environ.get("LUPUS_V4_HYBRID_CONFIG") or "")
REF_PATH = Path(os.environ.get("LUPUS_REF_CSV") or
               (BASE / "reference_dataset" / "lupus_cortex_fixed_reference_30.csv"))
LOG_DIR = Path(os.environ.get("LUPUS_V4_LOG_DIR") or (BASE / "logs"))

MODEL_VERSION = ("rf+lstm+ensemble v4 mac "
                 "(RF 18/18, LSTM 18/18, ensemble frozen §13: "
                 "11 val-fitted weights + 7 equal-weight defaults)")
N_FEATURES = 18

# LSTM serving: features in exact training order (lstm.py LSTM_FEATURES),
# 30-day sequences. The stats file has no value_fused median, so the
# value_lag1 training median is the documented proxy for value_fused.
LSTM_FEATURES = ["value_fused", "value_lag1", "value_roll7", "doy_sin", "doy_cos"]
LSTM_SEQ_LEN = 30

# The 18 components with a trained v4 RF model (checkpoints.json "rf" keys).
RF_COMPONENTS = [
    "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10",
    "C11", "C15", "C17", "C18", "C19", "C20", "C28", "C30a",
]

# Model features in exact training order (features.py FEATURES, 18).
FEATURES = [
    "value_lag1", "value_lag3", "value_lag7", "value_roll7", "value_roll30",
    "value_lag1_missing", "value_lag3_missing", "value_lag7_missing",
    "value_roll7_missing", "value_roll30_missing",
    "doy_sin", "doy_cos", "month", "latitude", "longitude",
    "reference_value", "threshold_low", "threshold_high",
]
LAG_ROLL_FEATURES = ["value_lag1", "value_lag3", "value_lag7", "value_roll7", "value_roll30"]

# Canonical metadata: id -> (name, unit, direction). Copied from the v3 service,
# extended with C14/C16 (derived-only entries, not canonical components).
CANONICAL_META = {
    "C01": ("PM2.5", "µg/m³", "lower_is_better"),
    "C02": ("PM10", "µg/m³", "lower_is_better"),
    "C03": ("NO₂", "ppb", "lower_is_better"),
    "C04": ("O₃", "ppm", "lower_is_better"),
    "C05": ("SO₂", "ppb", "lower_is_better"),
    "C06": ("CO", "ppb", "lower_is_better"),
    "C07": ("Aerosol Optical Depth", "unitless", "lower_is_better"),
    "C08": ("Land Surface Temperature", "°C", "context_dependent"),
    "C09": ("Air Temperature", "°C", "context_dependent"),
    "C10": ("Relative Humidity", "%", "optimal_range"),
    "C11": ("NDVI", "index", "higher_is_better"),
    "C12": ("Green-space percentage", "%", "higher_is_better"),
    "C13": ("Built-up percentage", "%", "context_dependent"),
    "C14": ("Impervious surface fraction", "fraction", "lower_is_better"),
    "C15": ("Precipitation", "mm/day", "optimal_range"),
    "C16": ("Extreme rainfall indicator", "index", "lower_is_better"),
    "C17": ("Soil Moisture", "m³/m³", "optimal_range"),
    "C18": ("Surface-water extent", "index_0_1", "context_dependent"),
    "C19": ("Flood extent", "fraction", "lower_is_better"),
    "C20": ("Drought anomaly (SPI)", "std_dev", "optimal_range"),
    "C21": ("Population density", "persons/km²", "context_dependent"),
    "C22": ("Vulnerable-age population", "%", "context_dependent"),
    "C23": ("Road density", "km/km²", "higher_is_better"),
    "C24": ("Public-transport accessibility", "index_0_100", "higher_is_better"),
    "C25": ("Hospital accessibility", "index_0_100", "higher_is_better"),
    "C26": ("Green-space accessibility", "index_0_100", "higher_is_better"),
    "C27": ("Critical-infrastructure density", "index_0_100", "higher_is_better"),
    "C28": ("Night-time lights", "nW/cm²/sr", "context_dependent"),
    "C29a": ("Elevation", "m", "context_dependent"),
    "C29b": ("Slope", "degrees", "context_dependent"),
    "C30a": ("Disaster exposure", "index_0_1", "lower_is_better"),
    "C30b": ("Disaster readiness", "index_0_100", "higher_is_better"),
}

# Static measured-only components (same values/notes as the v3 service).
# These have no trained RF model but have valid static measurements.
STATIC_MEASURED = {
    "C29b": (2.5, "Static Copernicus DEM slope; 40 samples, measured-only (no temporal model)"),
    "C30b": (20.7, "Bangladesh 2025 HKH climate readiness; 16 cells, national static value"),
}

app = FastAPI(title="Lupus Cortex Model Service v4", version="4.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_stats: dict | None = None        # cid -> {medians, clips, feature_cols}
_ref: dict = {}                    # canonical_id -> reference row
_checkpoints: dict | None = None   # checkpoints.json content (or None if absent)
_model_cache: dict = {"cid": None, "model": None}  # one model at a time
_model_lock = threading.Lock()


# ---------- Loading (lazy, tolerant of missing optional files) ----------

def _load_stats() -> dict:
    """Per-component preprocessing stats (medians + clips + feature_cols)."""
    global _stats
    if _stats is None:
        if not STATS_PATH.exists():
            raise RuntimeError(f"Preprocessing stats not found: {STATS_PATH}")
        with open(STATS_PATH) as f:
            raw = json.load(f)
        # The stats file carries one non-component entry (__dead_features__).
        _stats = {k: v for k, v in raw.items() if not str(k).startswith("_")}
    return _stats


def _load_ref() -> dict:
    """Fixed reference CSV rows by component_id. Missing file -> empty (no crash)."""
    global _ref
    if not _ref and REF_PATH.exists():
        with open(REF_PATH) as f:
            for row in csv.DictReader(f):
                _ref[row["component_id"]] = row
    return _ref


def _load_checkpoints() -> dict | None:
    """checkpoints.json (evaluation evidence). Missing file -> None."""
    global _checkpoints
    if _checkpoints is None:
        if CHECKPOINTS_PATH.exists():
            with open(CHECKPOINTS_PATH) as f:
                _checkpoints = json.load(f)
        else:
            _checkpoints = {}
    return _checkpoints or None


def _model_inventory() -> tuple[list[str], list[str]]:
    """(present, missing) RF model component IDs, by file existence."""
    present = [cid for cid in RF_COMPONENTS
               if (MODELS_DIR / f"rf_model_{cid}.joblib").exists()]
    missing = [cid for cid in RF_COMPONENTS if cid not in present]
    return present, missing


def _lstm_inventory() -> tuple[list[str], list[str]]:
    """(present, missing) LSTM model component IDs, by .keras file existence."""
    present = [cid for cid in RF_COMPONENTS
               if (MODELS_DIR / f"lstm_model_{cid}.keras").exists()]
    missing = [cid for cid in RF_COMPONENTS if cid not in present]
    return present, missing


def _lstm_status() -> str:
    """LSTM branch status from the .keras files on disk (no TF import)."""
    present, _missing = _lstm_inventory()
    if len(present) == len(RF_COMPONENTS):
        return "operational (18 models)"
    return f"partial — {len(present)}/18 .keras files on disk"


def _lstm_trained_count() -> int:
    """LSTM models with status=='done' in checkpoints.json."""
    ck = _load_checkpoints()
    if ck is None:
        return 0
    lstm = ck.get("lstm", {})
    return sum(1 for e in lstm.values()
               if isinstance(e, dict) and e.get("status") == "done")


def _validation_summary() -> tuple[list[str], list[str]]:
    """(below_persistence, no_val) RF component IDs, from checkpoints metrics."""
    ck = _load_checkpoints()
    below, no_val = [], []
    if ck is None:
        return below, no_val
    for cid in RF_COMPONENTS:
        entry = (ck.get("rf", {}) or {}).get(cid, {})
        metrics = entry.get("metrics", {}) if isinstance(entry, dict) else {}
        val = metrics.get("val", {}) or {}
        pers = metrics.get("val_persistence", {}) or {}
        vr, pr = val.get("R2"), pers.get("R2")
        if vr is None or (isinstance(vr, float) and math.isnan(vr)):
            no_val.append(cid)
        elif pr is not None and not (isinstance(pr, float) and math.isnan(pr)) and vr < pr:
            below.append(cid)
    return below, no_val


def _validation_for(cid: str) -> dict | None:
    """Per-component validation evidence (val R² vs persistence), or None."""
    ck = _load_checkpoints()
    if ck is None:
        return None
    entry = (ck.get("rf", {}) or {}).get(cid, {})
    metrics = entry.get("metrics", {}) if isinstance(entry, dict) else {}
    if not metrics:
        return None

    def _num(d: dict, key: str):
        v = (d or {}).get(key)
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return v

    val, pers = metrics.get("val", {}) or {}, metrics.get("val_persistence", {}) or {}
    return {
        "val_r2": _num(val, "R2"),
        "val_mae": _num(val, "MAE"),
        "val_rmse": _num(val, "RMSE"),
        "val_n": _num(val, "n"),
        "persistence_r2": _num(pers, "R2"),
        "below_persistence": (
            _num(val, "R2") is not None and _num(pers, "R2") is not None
            and _num(val, "R2") < _num(pers, "R2")
        ),
    }


# ---------- Ensemble weights (§13 frozen) & LSTM serving ----------

_ensemble_cache: dict | None = None   # cid -> {"rf", "lstm", "source"}
_ensemble_status: str = "not loaded"
_lstm_scalers_cache: dict | None = None
_lstm_models: dict[str, object] = {}
_tf_module = None
_TF_IMPORT_ERROR: str | None = None


def _resolve_hybrid_config() -> Path | None:
    """hybrid_config.json: env var first, then run-folder candidates."""
    if HYBRID_CONFIG_PATH and str(HYBRID_CONFIG_PATH) and HYBRID_CONFIG_PATH.exists():
        return HYBRID_CONFIG_PATH
    candidates = [
        BASE / "artifacts_v4mac" / "hybrid_config.json",
        MODELS_DIR.parent.parent / "artifacts_v4mac" / "hybrid_config.json",
        MODELS_DIR.parent / "hybrid_config.json",
        Path("hybrid_config.json"),
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _load_ensemble_weights() -> dict:
    """Frozen §13 ensemble weights, loaded from hybrid_config.json (never hardcoded).

    The 11 validation-fitted components keep their inverse-MAE weights
    (source 'val-fitted (frozen §13)'). Components with no validation window
    get the documented 0.5/0.5 equal-weight default (FIX 2, ordered
    2026-11-06) — a fixed default, NOT fitted on test — flagged as such.
    Missing/unreadable config -> {} (callers fall back to the RF value alone).
    """
    global _ensemble_cache, _ensemble_status
    if _ensemble_cache is not None:
        return _ensemble_cache
    weights: dict = {}
    cfg_path = _resolve_hybrid_config()
    if cfg_path is None:
        _ensemble_status = ("unavailable — hybrid_config.json not found; "
                            "ensemble falls back to the RF value")
        _ensemble_cache = {}
        return _ensemble_cache
    try:
        cfg = json.loads(cfg_path.read_text())
        ens = cfg.get("ensemble", {}) or {}
        frozen = bool(ens.get("frozen", False))
        src = "val-fitted (frozen §13)" if frozen else "val-fitted"
        for cid, w in (ens.get("weights", {}) or {}).items():
            if cid in RF_COMPONENTS:
                weights[cid] = {"rf": float(w["rf"]), "lstm": float(w["lstm"]),
                                "source": src}
        defaults = [c for c in RF_COMPONENTS if c not in weights]
        for cid in defaults:
            weights[cid] = {"rf": 0.5, "lstm": 0.5,
                            "source": "equal-weight default (no validation data; NOT fitted on test)"}
        _ensemble_status = (f"frozen §13 — {len(weights) - len(defaults)} val-fitted weights"
                            + (f" + {len(defaults)} equal-weight defaults "
                               f"({', '.join(defaults)})" if defaults else ""))
    except Exception as e:
        _ensemble_status = (f"unavailable — hybrid_config.json unreadable ({e}); "
                            "ensemble falls back to the RF value")
        weights = {}
    _ensemble_cache = weights
    return weights


def _ensemble_summary() -> tuple[list[str], list[str]]:
    """(equal_weight_default_components, val_fitted_components), from loaded weights."""
    weights = _load_ensemble_weights()
    defaults = [c for c, w in weights.items()
                if str(w.get("source", "")).startswith("equal-weight")]
    fitted = [c for c in weights if c not in defaults]
    return defaults, fitted


def _load_lstm_scalers() -> dict:
    """Per-component StandardScalers (lstm_scalers.joblib). Missing -> {}."""
    global _lstm_scalers_cache
    if _lstm_scalers_cache is not None:
        return _lstm_scalers_cache
    scalers: dict = {}
    p = MODELS_DIR / "lstm_scalers.joblib"
    if p.is_file():
        try:
            loaded = joblib.load(p)
            scalers = loaded if isinstance(loaded, dict) else {}
        except Exception as e:
            print(f"WARNING: could not load lstm_scalers.joblib: {e}")
    _lstm_scalers_cache = scalers
    return scalers


def _load_lstm_model(cid: str):
    """Load one LSTM .keras model (cached; all 18 together are ~7 MB).

    TensorFlow is imported lazily on first use so /health stays fast and the
    service still runs (RF-only) where TF is absent. A TF import failure is
    recorded once in _TF_IMPORT_ERROR; a single corrupt model file only
    disables that component.
    """
    global _tf_module, _TF_IMPORT_ERROR
    if cid in _lstm_models:
        return _lstm_models[cid]
    if _TF_IMPORT_ERROR is not None:
        return None
    path = MODELS_DIR / f"lstm_model_{cid}.keras"
    if not path.exists():
        _lstm_models[cid] = None
        return None
    if _tf_module is None:
        try:
            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
            import tensorflow as tf
        except Exception as e:
            _TF_IMPORT_ERROR = f"tensorflow could not be imported: {e}"
            return None
        _tf_module = tf
    try:
        model = _tf_module.keras.models.load_model(str(path))
    except Exception as e:
        print(f"WARNING: could not load LSTM model {cid}: {e}")
        _lstm_models[cid] = None
        return None
    _lstm_models[cid] = model
    return model


def _predict_lstm(cid: str, date: str) -> tuple[float | None, str | None]:
    """(value, error_note). Any failure -> (None, honest reason), never a guess.

    The 30-day input sequence is median-conditioned: value_fused, value_lag1
    and value_roll7 use the per-component TRAINING MEDIANS (the stats file
    has no value_fused median, so the value_lag1 median is the proxy),
    clipped to the training clips; doy_sin/cos come from the calendar days
    ending at the requested date. The sequence is scaled by the component's
    fitted StandardScaler (the model outputs raw values — the scaler scales
    inputs only). A global TF import failure returns (None, None): it is
    reported once in the data_quality notes, not on every component.
    """
    if _TF_IMPORT_ERROR is not None:
        return None, None
    path = MODELS_DIR / f"lstm_model_{cid}.keras"
    if not path.exists():
        return None, f"No LSTM model file for {cid}"
    scalers = _load_lstm_scalers()
    scaler = scalers.get(cid)
    if scaler is None:
        return None, f"No LSTM scaler for {cid}"
    model = _load_lstm_model(cid)
    if model is None:
        if _TF_IMPORT_ERROR is not None:
            return None, None
        return None, f"LSTM model for {cid} could not be loaded"
    try:
        stats = _load_stats()
    except Exception as e:
        return None, f"Preprocessing stats unavailable: {e}"
    entry = stats.get(cid)
    if entry is None:
        return None, f"No preprocessing stats for {cid}"
    medians = entry.get("medians", {})
    clips = entry.get("clips", {})
    lag_med = medians.get("value_lag1")
    roll_med = medians.get("value_roll7")
    if lag_med is None or roll_med is None:
        return None, f"No training medians for {cid}"

    def _clip(v, col):
        clip = clips.get(col)
        if isinstance(clip, dict) and clip.get("lo") is not None and clip.get("hi") is not None:
            return min(max(v, clip["lo"]), clip["hi"])
        return v

    fused = _clip(lag_med, "value_lag1")
    lag = _clip(lag_med, "value_lag1")
    roll = _clip(roll_med, "value_roll7")
    try:
        end = datetime.strptime(date, "%Y-%m-%d").date()
    except Exception:
        return None, f"Bad date for LSTM sequence: {date}"
    seq = []
    for i in range(LSTM_SEQ_LEN):
        d = end - timedelta(days=LSTM_SEQ_LEN - 1 - i)
        doy = d.timetuple().tm_yday
        seq.append([fused, lag, roll,
                    math.sin(2 * math.pi * doy / 365.25),
                    math.cos(2 * math.pi * doy / 365.25)])
    x = np.asarray(seq, dtype=float).reshape(1, LSTM_SEQ_LEN, len(LSTM_FEATURES))
    try:
        xs = scaler.transform(x.reshape(-1, len(LSTM_FEATURES)))
        xs = xs.reshape(1, LSTM_SEQ_LEN, len(LSTM_FEATURES))
    except Exception as e:
        return None, f"LSTM scaling failed for {cid}: {e}"
    xs = np.nan_to_num(xs, nan=0.0, posinf=0.0, neginf=0.0)
    try:
        y = model.predict(xs, verbose=0)
    except Exception as e:
        return None, f"LSTM prediction failed for {cid}: {e}"
    value = float(np.asarray(y).reshape(-1)[0])
    if value != value or value in (float("inf"), float("-inf")):
        return None, f"LSTM prediction for {cid} was not finite"
    return value, None


def _blend(rf_value: float | None, lstm_value: float | None,
           weights: dict) -> tuple[float | None, str]:
    """(value, model_used). Same rule as §13 FrozenEnsemble.blend: weighted
    average, renormalized over the models that actually produced a finite
    value. model_used is 'ensemble' (both), 'rf', 'lstm', or 'none'."""
    parts = []
    if rf_value is not None and math.isfinite(rf_value):
        parts.append((weights.get("rf", 0.5), rf_value, "rf"))
    if lstm_value is not None and math.isfinite(lstm_value):
        parts.append((weights.get("lstm", 0.5), lstm_value, "lstm"))
    if not parts:
        return None, "none"
    total = sum(w for w, _, _ in parts)
    if total <= 0:
        return None, "none"
    value = sum(w * v for w, v, _ in parts) / total
    if not math.isfinite(value):
        return None, "none"
    return value, ("ensemble" if len(parts) == 2 else parts[0][2])


def _lstm_validation_for(cid: str) -> dict | None:
    """Per-component LSTM validation evidence (val R² vs persistence), or None.

    The 7 no-validation components have only n_train_sequences in
    checkpoints.json (no 'val' key) — val_r2 stays None, honestly.
    """
    ck = _load_checkpoints()
    if ck is None:
        return None
    entry = (ck.get("lstm", {}) or {}).get(cid, {})
    metrics = entry.get("metrics", {}) if isinstance(entry, dict) else {}
    if not metrics:
        return None

    def _num(d: dict, key: str):
        v = (d or {}).get(key)
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return v

    val, pers = metrics.get("val", {}) or {}, metrics.get("val_persistence", {}) or {}
    return {
        "val_r2": _num(val, "R2"),
        "val_mae": _num(val, "MAE"),
        "val_rmse": _num(val, "RMSE"),
        "val_n": _num(val, "n"),
        "persistence_r2": _num(pers, "R2"),
        "n_train_sequences": metrics.get("n_train_sequences"),
        "below_persistence": (
            _num(val, "R2") is not None and _num(pers, "R2") is not None
            and _num(val, "R2") < _num(pers, "R2")
        ),
    }


def _lstm_validation_summary() -> tuple[list[str], list[str]]:
    """(lstm_below_persistence, lstm_no_val) component IDs, from checkpoints."""
    ck = _load_checkpoints()
    below, no_val = [], []
    if ck is None:
        return below, no_val
    for cid in RF_COMPONENTS:
        entry = (ck.get("lstm", {}) or {}).get(cid, {})
        metrics = entry.get("metrics", {}) if isinstance(entry, dict) else {}
        val = metrics.get("val", {}) or {}
        pers = metrics.get("val_persistence", {}) or {}
        vr, pr = val.get("R2"), pers.get("R2")
        if vr is None or (isinstance(vr, float) and math.isnan(vr)):
            no_val.append(cid)
        elif pr is not None and not (isinstance(pr, float) and math.isnan(pr)) and vr < pr:
            below.append(cid)
    return below, no_val


# ---------- Features & prediction ----------

def _features_for(lat: float, lon: float, date: str, entry: dict) -> np.ndarray:
    """18-feature inference vector (exact training order).

    No live history exists at request time, so lag/roll features use the
    per-component TRAINING MEDIANS and missing flags are 1. doy_sin/cos and
    month come from the requested date; latitude/longitude from the request;
    reference/threshold features from the training medians. Lag/roll
    features are clipped to the training clips.
    """
    medians = entry.get("medians", {})
    clips = entry.get("clips", {})
    dt = datetime.strptime(date, "%Y-%m-%d")
    doy = dt.timetuple().tm_yday
    feats = {
        "value_lag1": medians.get("value_lag1", 0),
        "value_lag3": medians.get("value_lag3", 0),
        "value_lag7": medians.get("value_lag7", 0),
        "value_roll7": medians.get("value_roll7", 0),
        "value_roll30": medians.get("value_roll30", 0),
        "value_lag1_missing": 1,
        "value_lag3_missing": 1,
        "value_lag7_missing": 1,
        "value_roll7_missing": 1,
        "value_roll30_missing": 1,
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "month": dt.month,
        "latitude": lat,
        "longitude": lon,
        "reference_value": medians.get("reference_value", 0),
        "threshold_low": medians.get("threshold_low", 0),
        "threshold_high": medians.get("threshold_high", 0),
    }
    # Clip lag/roll features to the training clips.
    for col in LAG_ROLL_FEATURES:
        clip = clips.get(col)
        if isinstance(clip, dict) and clip.get("lo") is not None and clip.get("hi") is not None:
            feats[col] = min(max(feats[col], clip["lo"]), clip["hi"])
    order = entry.get("feature_cols") or FEATURES
    if list(order) != FEATURES:
        raise RuntimeError(f"stats feature_cols do not match the 18 training features: {order}")
    return np.array([[feats[k] for k in FEATURES]], dtype=float)


def _load_model(cid: str):
    """Load one RF model (memory-mapped, plain-load fallback), one at a time.

    The cache holds a single model; switching evicts the previous one
    (del + gc) so the ~12 GB model set never sits in RAM at once.
    Asserts the model was trained on exactly the 18 features.
    """
    with _model_lock:
        if _model_cache["cid"] == cid and _model_cache["model"] is not None:
            return _model_cache["model"]
        if _model_cache["model"] is not None:
            _model_cache["model"] = None
            _model_cache["cid"] = None
            gc.collect()
        path = MODELS_DIR / f"rf_model_{cid}.joblib"
        if not path.exists():
            raise FileNotFoundError(f"RF model file not found: {path}")
        try:
            model = joblib.load(path, mmap_mode="r")
        except Exception:
            model = joblib.load(path)
        n_feat = getattr(model, "n_features_in_", None)
        if n_feat != N_FEATURES:
            raise RuntimeError(
                f"RF model {cid} was trained on {n_feat} features, expected {N_FEATURES}")
        _model_cache["cid"] = cid
        _model_cache["model"] = model
        return model


def _predict_rf(cid: str, lat: float, lon: float, date: str) -> tuple[float | None, str | None]:
    """(value, error_note). Any failure -> (None, honest reason), never a guess."""
    try:
        stats = _load_stats()
    except Exception as e:
        return None, f"Preprocessing stats unavailable: {e}"
    entry = stats.get(cid)
    if entry is None:
        return None, f"No preprocessing stats for {cid}"
    try:
        X = _features_for(lat, lon, date, entry)
    except Exception as e:
        return None, f"Feature construction failed for {cid}: {e}"
    try:
        model = _load_model(cid)
        value = float(model.predict(X)[0])
    except FileNotFoundError as e:
        return None, str(e)
    except Exception as e:
        return None, f"RF prediction failed for {cid}: {e}"
    if value != value or value in (float("inf"), float("-inf")):
        return None, f"RF prediction for {cid} was not finite"
    return value, None


# ---------- Scoring & report building (mirrors v3) ----------

def _score(value: float | None, direction: str, ref: dict | None) -> float | None:
    """Direction-aware 0-100 scoring using reference thresholds where available."""
    if value is None or value != value:
        return None
    try:
        t_low = float(ref["threshold_low"]) if ref and ref.get("threshold_low") else None
        t_high = float(ref["threshold_high"]) if ref and ref.get("threshold_high") else None
        rmin = float(ref["reference_min"]) if ref and ref.get("reference_min") else 0
        rmax = float(ref["reference_max"]) if ref and ref.get("reference_max") else 100
    except (ValueError, TypeError):
        t_low, t_high, rmin, rmax = None, None, 0, 100

    if direction == "higher_is_better":
        if t_low is None:
            return max(0.0, min(100.0, 100 * (value - rmin) / max(1e-9, rmax - rmin)))
        if value <= t_low: return 25.0
        if value >= t_high: return 90.0
        return 25 + 65 * (value - t_low) / max(1e-9, t_high - t_low)
    if direction == "lower_is_better":
        if t_low is None:
            return max(0.0, min(100.0, 100 * (1 - (value - rmin) / max(1e-9, rmax - rmin))))
        if value <= t_low: return 90.0
        if value >= t_high: return 25.0
        return 90 - 65 * (value - t_low) / max(1e-9, t_high - t_low)
    # context_dependent / optimal_range: score by distance from reference band centre
    if t_low is not None and t_high is not None:
        centre = (t_low + t_high) / 2
        half = max(1e-9, (t_high - t_low) / 2)
        dist = abs(value - centre) / half
        return max(10.0, 85 - 40 * min(dist, 2) / 2)
    return 55.0


_UNAVAILABLE_NOTES = {
    "C12": "No trained RF model (ineligible — too few distinct dates in the 2015–2025 master); land cover is annual data, used directly for analysis, not served as a prediction.",
    "C13": "No trained RF model (ineligible — too few distinct dates); built-up percentage is derived from annual land-cover data.",
    "C21": "No trained RF model (ineligible — too few distinct dates); population density is static/annual data.",
    "C22": "No trained RF model (ineligible — too few distinct dates); vulnerable-age population is static/annual data.",
    "C23": "No trained RF model; no live OSM feed in this service (the v3 service served these from OSM extracts).",
    "C24": "No trained RF model; no live OSM feed in this service (the v3 service served these from OSM extracts).",
    "C25": "No trained RF model; no live OSM feed in this service (the v3 service served these from OSM extracts).",
    "C26": "No trained RF model (ineligible — too few distinct dates); green-space accessibility is derived from annual land-cover data.",
    "C27": "No trained RF model; no live OSM feed in this service (the v3 service served these from OSM extracts).",
    "C29a": "No trained RF model (ineligible — too few distinct dates); elevation is static terrain data.",
}


def _component_result(cid: str, lat: float, lon: float, date: str,
                      c15_value: float | None = None) -> dict:
    name, unit, direction = CANONICAL_META[cid]
    ref = _load_ref().get(cid)
    availability, value, note = "unavailable", None, None
    validation = None
    rf_value = lstm_value = ensemble_value = None
    model_used = None
    ensemble_weights = None
    lstm_validation = None

    if cid in RF_COMPONENTS:
        # Served value = frozen §13 ensemble (RF + LSTM). RF and LSTM values
        # are exposed alongside; if one model fails, the blend renormalizes
        # over the model that did produce a value; if the ensemble weights
        # are unavailable entirely, the RF value is served alone (disclosed).
        rf_value, err = _predict_rf(cid, lat, lon, date)
        lstm_value, lstm_err = _predict_lstm(cid, date)
        lstm_validation = _lstm_validation_for(cid)
        weights = _load_ensemble_weights()
        w = weights.get(cid)
        ensemble_note = None
        if w is None:
            value, model_used = rf_value, "rf"
            ensemble_note = ("Ensemble weights unavailable (hybrid_config.json not found "
                             "or unreadable); RF value served.")
        else:
            ensemble_weights = {"rf": w["rf"], "lstm": w["lstm"], "source": w["source"]}
            value, model_used = _blend(rf_value, lstm_value, w)
            if model_used == "ensemble":
                ensemble_value = value
            if str(w["source"]).startswith("equal-weight"):
                ensemble_note = ("Ensemble uses the documented 0.5/0.5 equal-weight default "
                                 "(no validation window for this component; NOT fitted on test).")
        availability = "available" if value is not None else "unavailable"
        validation = _validation_for(cid)
        notes = []
        if err:
            notes.append(err)
        if lstm_err:
            notes.append(lstm_err)
        if validation and validation["below_persistence"]:
            vr, pr = validation["val_r2"], validation["persistence_r2"]
            notes.append(f"RF validation R² {vr:.3f} is below the persistence baseline "
                         f"{pr:.3f} — the RF prediction is weaker than carrying the last "
                         "observed value forward.")
        if lstm_validation and lstm_validation.get("below_persistence"):
            vr, pr = lstm_validation["val_r2"], lstm_validation["persistence_r2"]
            notes.append(f"LSTM validation R² {vr:.3f} is below the persistence baseline "
                         f"{pr:.3f} — the LSTM prediction is weaker than carrying the last "
                         "observed value forward.")
        if lstm_validation and lstm_validation.get("val_r2") is None:
            notes.append("No LSTM validation metrics (no Aug–Sep 2025 validation window); "
                         "LSTM trained on the train split only.")
        if ensemble_note:
            notes.append(ensemble_note)
        note = " ".join(notes) if notes else None
    elif cid == "C16":
        # Derived only: 95th-percentile exceedance from the C15 ensemble prediction.
        if c15_value is not None:
            value = c15_value
            availability = "derived"
            note = "Derived: 95th-percentile exceedance (from C15 ensemble prediction)"
    elif cid == "C14":
        note = "Derived from C13 (built-up percentage); C13 has no trained RF model, so C14 cannot be derived."
    elif cid in STATIC_MEASURED:
        value, note = STATIC_MEASURED[cid]
        availability = "measured"  # Static measured-only, no predictive model
    else:
        note = _UNAVAILABLE_NOTES.get(
            cid, "No trained RF model and no other validated source in this service.")

    score = _score(value, direction, ref)
    result = {
        "id": cid, "name": name, "value": value, "unit": unit,
        "score": round(score, 1) if score is not None else None,
        "label": score_label(score),
        "availability": availability,
        "reference": {"threshold_low": ref.get("threshold_low") if ref else None,
                      "threshold_high": ref.get("threshold_high") if ref else None,
                      "source": ref.get("source_organization") if ref else None,
                      "basis": ref.get("scientific_basis") if ref else None},
        "note": note,
        "model_version": MODEL_VERSION,
    }
    if validation is not None:
        result["validation"] = validation
    if cid in RF_COMPONENTS:
        # Full-model transparency: the served value plus both branch values.
        result["rf_value"] = rf_value
        result["lstm_value"] = lstm_value
        result["ensemble_value"] = ensemble_value
        result["model_used"] = model_used
        if ensemble_weights is not None:
            result["ensemble_weights"] = ensemble_weights
        if lstm_validation is not None:
            result["lstm_validation"] = lstm_validation
    return result


def _data_quality_notes(n_avail: int, present: list[str]) -> list[str]:
    """Honest disclosure notes for every report."""
    below, no_val = _validation_summary()
    lstm_below, lstm_no_val = _lstm_validation_summary()
    defaults, _fitted = _ensemble_summary()
    notes = [
        "Inference uses training medians for lag/roll features (no live recent "
        "history at request time); missing flags = 1; reference/threshold "
        "features from per-component training medians. Predictions are "
        "median-conditioned estimates, not forecasts from observed recent history.",
        "Served value per trained component: frozen §13 ensemble (RF + LSTM). "
        "LSTM sequences are likewise median-conditioned (training medians for "
        "value_fused/value_lag1/value_roll7; day-of-year from the 30 calendar "
        "days ending at the requested date). RF and LSTM values are shown per "
        "component.",
    ]
    if defaults:
        notes.append(
            "Ensemble weights: 11 components use validation-fitted inverse-MAE "
            "weights (frozen §13); " + ", ".join(defaults) + " use the documented "
            "0.5/0.5 equal-weight default (no validation window; NOT fitted on "
            "test). Ensemble test R² 0.978 on the common 182,952-row chronological "
            "test set (11 components with validation data; RF 0.973, LSTM 0.975, "
            "persistence 0.975).")
    if not _load_ensemble_weights():
        notes.append(
            "Ensemble weights unavailable (hybrid_config.json not found or "
            "unreadable); RF values served for all trained components.")
    if below:
        ck = _load_checkpoints() or {}
        parts = []
        for cid in below:
            m = (ck.get("rf", {}) or {}).get(cid, {}).get("metrics", {})
            vr = (m.get("val") or {}).get("R2")
            pr = (m.get("val_persistence") or {}).get("R2")
            parts.append(f"{cid} ({vr:.3f} vs {pr:.3f})" if vr is not None and pr is not None else cid)
        notes.append(
            "RF validation R² is below the persistence baseline for "
            + ", ".join(parts)
            + " — these predictions are weaker than carrying the last observed value forward.")
    if lstm_below:
        ck = _load_checkpoints() or {}
        parts = []
        for cid in lstm_below:
            m = (ck.get("lstm", {}) or {}).get(cid, {}).get("metrics", {})
            vr = (m.get("val") or {}).get("R2")
            pr = (m.get("val_persistence") or {}).get("R2")
            parts.append(f"{cid} ({vr:.3f} vs {pr:.3f})" if vr is not None and pr is not None else cid)
        notes.append(
            "LSTM validation R² is below the persistence baseline for "
            + ", ".join(parts)
            + " — these LSTM predictions are weaker than carrying the last observed value forward.")
    if no_val:
        notes.append(
            "No RF validation metrics for " + ", ".join(no_val)
            + " (no Aug–Sep 2025 validation window); served on the train-split fit only.")
    if lstm_no_val:
        notes.append(
            "No LSTM validation metrics for " + ", ".join(lstm_no_val)
            + " (no Aug–Sep 2025 validation window); LSTM trained on the train split only.")
    if _TF_IMPORT_ERROR is not None:
        notes.append(
            "LSTM unavailable at runtime: " + _TF_IMPORT_ERROR
            + "; RF values served for all trained components.")
    notes.append("Fixed reference thresholds guide interpretation only; they are not training targets.")
    if len(present) < len(RF_COMPONENTS):
        notes.append(
            f"Only {len(present)}/{len(RF_COMPONENTS)} RF model files are present in "
            f"{MODELS_DIR}; missing models are reported unavailable, never invented.")
    notes.append(
        "Coverage counts the 30 canonical components; C14/C16 are additional "
        "derived-only entries (C16 derived from the C15 ensemble prediction; C14 "
        "unavailable — no C13 model).")
    return notes


def _build_report(lat: float, lon: float, name: str, date: str) -> dict:
    _load_ref()
    _load_checkpoints()
    report = report_skeleton()
    report["analysis_id"] = f"lc-{uuid.uuid4().hex[:12]}"
    report["model_version"] = MODEL_VERSION
    report["location"] = {"lat": lat, "lon": lon, "name": name}
    now = datetime.now(timezone.utc).isoformat()
    report["time"] = {"analysis_utc": now, "analyzed_at": now,
                      "observation_period": "2015-01-01 to 2025-12-31"}

    # C15 first: C16 derives from its prediction.
    c15 = _component_result("C15", lat, lon, date)
    c15_value = c15["value"] if c15["availability"] == "available" else None
    comps = {}
    for cid in CANONICAL_COMPONENTS:
        comps[cid] = c15 if cid == "C15" else _component_result(cid, lat, lon, date)
    # Derived-only extras (not canonical components).
    comps["C14"] = _component_result("C14", lat, lon, date)
    comps["C16"] = _component_result("C16", lat, lon, date, c15_value=c15_value)
    report["components"] = comps

    n_avail = sum(1 for cid in CANONICAL_COMPONENTS
                  if comps[cid]["availability"] in ("available", "derived", "proxy", "measured"))
    present, _missing = _model_inventory()
    report["data_quality"] = {
        "coverage_pct": round(100 * n_avail / len(CANONICAL_COMPONENTS), 1),
        "n_components_available": n_avail,
        "n_components_total": len(CANONICAL_COMPONENTS),
        "notes": _data_quality_notes(n_avail, present),
    }

    # Indices — DETAILED index-wise analysis (same as v3).
    indices = {}
    index_details = {}
    for ikey in INDICES:
        idef = INDEX_DEFS[ikey]
        detail = build_index_detail(ikey, idef, comps, lat, lon)
        index_details[ikey] = detail
        indices[ikey] = {
            "key": ikey,
            "name": idef["name"],
            "category": idef["category"],
            "description": idef["description"],
            "target": idef["target"],
            "score": detail["score"],
            "label": detail["label"],
            "status": detail["status"],
            "components": idef["components"],
            "n_components_scored": sum(1 for c in detail["components"] if c["score"] is not None),
            "n_components_proxy": sum(1 for c in detail["components"] if c["availability"] == "proxy"),
            "n_components_unavailable": sum(1 for c in detail["components"] if c["availability"] == "unavailable"),
            "method": "mean of available component scores",
            "detail": detail,  # Full index-wise breakdown
        }
    report["indices"] = indices

    # HWI with full detail (same partial-coverage logic as v3).
    wsum, wtot = 0.0, 0.0
    total_weight = sum(HWI_WEIGHTS.values())
    available_indices = []
    missing_indices = []
    for ikey, w in HWI_WEIGHTS.items():
        s = indices[ikey]["score"]
        if s is not None:
            wsum += w * s
            wtot += w
            available_indices.append(ikey)
        else:
            missing_indices.append(ikey)
    hwi = round(wsum / wtot, 1) if wtot else None
    coverage_pct = round(100 * wtot / total_weight, 1) if total_weight else 0
    if hwi is not None and coverage_pct < 100:
        hwi_label = f"Partial HWI ({coverage_pct}% weight coverage)"
    elif hwi is not None:
        hwi_label = score_label(hwi)
    else:
        hwi_label = "Unavailable"
    hwi_detail = build_hwi_detail(hwi, hwi_label, indices, HWI_WEIGHTS)
    hwi_detail["weight_coverage_pct"] = coverage_pct
    hwi_detail["available_indices"] = available_indices
    hwi_detail["missing_indices"] = missing_indices
    hwi_detail["is_partial"] = coverage_pct < 100
    report["hwi"] = hwi_detail

    # Warnings aggregated from index details (naming specific components).
    warnings = []
    for ikey, detail in index_details.items():
        for w in detail["warnings"]:
            warnings.append({
                "severity": w["severity"],
                "index": ikey,
                "index_name": detail["name"],
                "component": w["component_id"],
                "component_name": w["component_name"],
                "message": w["message"],
                "confidence": "model-based",
            })
    report["warnings"] = warnings

    # Index-wise detailed analysis.
    report["index_analysis"] = index_details

    # Aggregate interventions by stakeholder level across all indices.
    agg = {"individual": [], "community": [], "industrial": [], "government": []}
    for ikey, detail in index_details.items():
        for level in agg:
            for item in detail["interventions"].get(level, []):
                agg[level].append(f"[{ikey}] {item}")
    report["recommendations"] = agg

    # Detailed examples aggregated.
    all_examples = []
    for ikey, detail in index_details.items():
        for ex in detail.get("examples", []):
            all_examples.append({"index": ikey, **ex})
    report["case_studies"] = all_examples

    # Predictions per index.
    report["index_predictions"] = {k: v["prediction"] for k, v in index_details.items()}

    report["analysis"] = {
        "summary": f"HWI {hwi} ({hwi_label}) at {name}. "
                   f"{n_avail}/{len(CANONICAL_COMPONENTS)} canonical components scored. "
                   f"{len(warnings)} warning(s).",
        "findings": [f"{c['name']}: {c['label']} (score {c['score']})"
                     for cid, c in comps.items()
                     if c["label"] in ("Poor", "Harmful")][:10],
        "risks": [w["component_name"] for w in warnings[:5]],
    }
    report["forecasts"] = {
        "horizon": "next 7 days (short-term only)",
        "values": [], "uncertainty": "not calibrated",
        "note": "Training data spans 2015–2025; long-term forecasts are not validated. See index_predictions for scenario-based outlooks.",
    }
    ck = _load_checkpoints() or {}
    master = ck.get("master", {}) if isinstance(ck, dict) else {}
    lstm_present, _lstm_missing = _lstm_inventory()
    artifacts: dict[str, Any] = {
        "rf_models_dir": str(MODELS_DIR),
        "rf_model_files": [f"rf_model_{cid}.joblib" for cid in present],
        "lstm_model_files": [f"lstm_model_{cid}.keras" for cid in lstm_present],
        "lstm_scalers_file": "lstm_scalers.joblib",
        "lstm_status": _lstm_status(),
        "ensemble_status": _ensemble_status,
        "ensemble_weights_source": (
            str(_resolve_hybrid_config()) if _resolve_hybrid_config() is not None
            else "hybrid_config.json not found"),
    }
    if master.get("size_bytes") is not None:
        artifacts["master_size_bytes"] = master["size_bytes"]
    if master.get("sha256_prefix"):
        artifacts["master_sha256_prefix"] = master["sha256_prefix"]
    report["provenance"] = {
        "model_artifacts": artifacts,
        "data_sources": ["master 2015–2025 (30 components)",
                         "fixed_reference_30.csv (32 canonical entries)"],
        "limitations": report["data_quality"]["notes"] + [
            "Ensemble test evidence (§14b, R² 0.978) covers the 11 components with "
            "validation data on the common test set; the 7 no-validation components "
            "use the 0.5/0.5 equal-weight default and have no ensemble test score.",
            "LSTM sequences are median-conditioned (no live history); LSTM values "
            "are estimates in the same regime as the RF median-feature inference.",
            "Median-feature inference: predictions are conditioned on training medians, not on observed recent history.",
        ],
    }

    errors = validate_report(report)
    if errors:
        raise RuntimeError(f"Report validation failed: {errors}")
    return report


def _append_jsonl(path: Path, record: dict) -> None:
    """Append one JSON line; logging must never break a response."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except Exception:
        pass


def _log_analysis(report: dict, lat: float, lon: float, name: str, date: str) -> None:
    _append_jsonl(LOG_DIR / "analysis_log.jsonl", {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "lat": lat, "lon": lon, "name": name, "date": date,
        "model_version": MODEL_VERSION,
        "analysis_id": report.get("analysis_id"),
        "components": {
            cid: {"value": c.get("value"), "rf_value": c.get("rf_value"),
                  "lstm_value": c.get("lstm_value"),
                  "ensemble_value": c.get("ensemble_value"),
                  "model_used": c.get("model_used"),
                  "availability": c.get("availability")}
            for cid, c in report.get("components", {}).items()
        },
    })


# ---------- Request models ----------

class AnalyzeRequest(BaseModel):
    lat: float
    lon: float
    name: str = "Selected location"
    date: str | None = None

    @field_validator("lat")
    @classmethod
    def _lat(cls, v):
        if not -90 <= v <= 90: raise ValueError("latitude out of range")
        return v

    @field_validator("lon")
    @classmethod
    def _lon(cls, v):
        if not -180 <= v <= 180: raise ValueError("longitude out of range")
        return v


# ---------- Routes ----------

@app.get("/")
def root():
    present, missing = _model_inventory()
    lstm_present, lstm_missing = _lstm_inventory()
    return {
        "service": "Lupus Cortex Model Service v4",
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "status": "ok" if not missing and not lstm_missing else "degraded",
        "rf_models_available": len(present),
        "rf_models_missing": missing,
        "lstm_models_available": len(lstm_present),
        "lstm_models_missing": lstm_missing,
        "ensemble_status": _ensemble_status,
        "endpoints": ["/health", "/predict", "/api/analyze", "/api/dashboard",
                      "/api/extract", "/api/scenario"],
        "docs": "/docs",
    }


@app.get("/health")
def health():
    present, missing = _model_inventory()
    lstm_present, lstm_missing = _lstm_inventory()
    stats_ok = STATS_PATH.exists()
    rf_branch = (f"operational ({len(present)} models)" if not missing
                 else f"degraded ({len(present)}/{len(RF_COMPONENTS)} models)")
    if not stats_ok:
        rf_branch = f"degraded — preprocessing stats missing: {STATS_PATH}"
    weights = _load_ensemble_weights()
    return {
        "status": "ok" if not missing and stats_ok else "degraded",
        "schema_version": SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "branches": {
            "rf": rf_branch,
            "lstm": _lstm_status() + f" (trained {_lstm_trained_count()}/18 in checkpoints)",
            "ensemble": _ensemble_status,
        },
        "rf_models_available": len(present),
        "rf_models": present,
        "rf_models_missing": missing,
        "lstm_models_available": len(lstm_present),
        "lstm_models": lstm_present,
        "lstm_models_missing": lstm_missing,
        "ensemble_weights_available": len(weights),
        "stats_file_present": stats_ok,
        "checkpoints_present": CHECKPOINTS_PATH.exists(),
        "hybrid_config_present": _resolve_hybrid_config() is not None,
    }


@app.post("/predict")
def predict(req: AnalyzeRequest):
    date = req.date or "2025-12-15"
    rf_out, lstm_out, ens_out = {}, {}, {}
    weights = _load_ensemble_weights()
    for cid in RF_COMPONENTS:
        rf_value, _err = _predict_rf(cid, req.lat, req.lon, date)
        lstm_value, _lerr = _predict_lstm(cid, date)
        rf_out[cid] = rf_value
        lstm_out[cid] = lstm_value
        w = weights.get(cid)
        if w is None:
            ens_out[cid] = rf_value
        else:
            ens_value, _used = _blend(rf_value, lstm_value, w)
            ens_out[cid] = ens_value
    return {"schema_version": SCHEMA_VERSION, "model_version": MODEL_VERSION,
            "predictions": rf_out,
            "lstm_predictions": lstm_out,
            "ensemble_predictions": ens_out,
            "ensemble_weights": {c: {"rf": w["rf"], "lstm": w["lstm"],
                                     "source": w["source"]}
                                 for c, w in weights.items()},
            "units": {c: CANONICAL_META[c][1] for c in rf_out}}


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    date = req.date or "2025-12-15"
    try:
        report = _build_report(req.lat, req.lon, req.name, date)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    _log_analysis(report, req.lat, req.lon, req.name, date)
    return report


@app.post("/api/dashboard")
def dashboard(req: AnalyzeRequest):
    """Alias of /api/analyze. Returns schema v3."""
    return analyze(req)


@app.post("/api/extract")
def extract(payload: dict):
    """Accept a data-extractor bundle (kind 'lupus-cortex-extraction').

    The bundle is stored as one JSON line in extractions.jsonl for later
    processing. This service does not verify API keys — the frontend
    verifies keys in the browser before extraction.
    """
    _append_jsonl(LOG_DIR / "extractions.jsonl", {
        "received_at": datetime.now(timezone.utc).isoformat(),
        "bundle": payload,
    })
    return {"accepted": True, "key_status": {}}


@app.post("/api/scenario")
def scenario(payload: dict):
    """Scenario analysis: baseline report + documented assumption deltas."""
    lat = float(payload.get("lat", 23.8103))
    lon = float(payload.get("lon", 90.4125))
    name = payload.get("name", "Scenario location")
    changes = payload.get("changes", {})
    date = payload.get("date") or "2025-12-15"
    try:
        baseline = _build_report(lat, lon, name, date)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "schema_version": SCHEMA_VERSION,
        "baseline": baseline,
        "scenario_changes": changes,
        "note": ("Scenario deltas are assumption-based, not model-predicted. "
                 "Supported variables: green_space_change_pct, emission_change_pct. "
                 "Unsupported variables are reported, not invented."),
        "assumptions": ["Linear response assumed for documented deltas only.",
                        "Baseline predictions use median-feature inference (see report data_quality notes)."],
    }
