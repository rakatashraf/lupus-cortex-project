#!/usr/bin/env python3
"""Launcher for the Lupus Cortex Model Service v4 (Mac run folder).

Resolves the Mac run folder, verifies the models directory and the
preprocessing stats file exist (clear error naming the missing path if
not), sets the LUPUS_V4_* environment variables the service reads, then
serves the FastAPI app on http://127.0.0.1:8100.

Usage (from a Mac Jupyter cell):
    %pip install -r requirements-v4-mac.txt
    %run run_v4_api.py

Or from a terminal in this directory:
    python run_v4_api.py

Environment overrides (all optional):
    LUPUS_V4_RUN_DIR        Mac run folder (default: /Users/mobashshira/Downloads/Lupus_Cortex_Local_GPU)
    LUPUS_V4_MODELS_DIR     models directory (default: <RUN_DIR>/lupus_output_v4/04_Trained_Models)
    LUPUS_V4_PREPROC_STATS  global_preprocess_stats.json (searched under the run folder)
    LUPUS_V4_CHECKPOINTS    checkpoints.json (searched under the run folder; optional)
    LUPUS_REF_CSV           fixed reference CSV (searched under the run folder; optional)
    LUPUS_V4_PORT           port (default: 8100)

No secrets are read or stored here.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent

# Documented Mac run folder. Used as a default candidate, not the only path:
# LUPUS_V4_RUN_DIR overrides it, and LUPUS_V4_MODELS_DIR /
# LUPUS_V4_PREPROC_STATS override the resolved paths entirely.
DEFAULT_RUN_DIR = Path("/Users/mobashshira/Downloads/Lupus_Cortex_Local_GPU")

MODELS_SUBDIR = Path("lupus_output_v4") / "04_Trained_Models"
STATS_CANDIDATES = [
    Path("lupus_output_v4") / "03_Preprocessing_Stats" / "global_preprocess_stats.json",
    Path("lupus_output_v4") / "global_preprocess_stats.json",
    Path("global_preprocess_stats.json"),
]
CHECKPOINTS_CANDIDATES = [
    Path("lupus_output_v4") / "checkpoints.json",
    Path("lupus_output_v4") / "05_Manifests" / "checkpoints.json",
    Path("checkpoints.json"),
]
REF_CANDIDATES = [
    Path("lupus_output_v4") / "reference_dataset" / "lupus_cortex_fixed_reference_30.csv",
    Path("reference_dataset") / "lupus_cortex_fixed_reference_30.csv",
    Path("lupus_output_v4") / "04_Fixed_Reference_Dataset" / "lupus_cortex_fixed_reference_30.csv",
]


def _first_existing(base: Path, candidates: list[Path]) -> Path | None:
    for rel in candidates:
        p = base / rel
        if p.exists():
            return p
    return None


def resolve() -> dict[str, Path]:
    """Resolve models dir + stats (+ optional checkpoints/ref). Raise SystemExit with a clear error."""
    run_dir_s = os.environ.get("LUPUS_V4_RUN_DIR", "")
    run_dir = Path(run_dir_s) if run_dir_s else None
    if run_dir is None:
        run_dir = DEFAULT_RUN_DIR if DEFAULT_RUN_DIR.exists() else None
    if run_dir is None or not run_dir.is_dir():
        raise SystemExit(
            "ERROR: Mac run folder not found.\n"
            f"  Looked for: {DEFAULT_RUN_DIR}\n"
            "  Set LUPUS_V4_RUN_DIR to the run folder "
            "(the folder containing lupus_output_v4/), or set "
            "LUPUS_V4_MODELS_DIR and LUPUS_V4_PREPROC_STATS directly."
        )

    models_dir_s = os.environ.get("LUPUS_V4_MODELS_DIR", "")
    models_dir = Path(models_dir_s) if models_dir_s else run_dir / MODELS_SUBDIR
    if not models_dir.is_dir():
        raise SystemExit(
            "ERROR: models directory not found.\n"
            f"  Looked for: {models_dir}\n"
            "  Expected rf_model_{C01..C30a}.joblib files there. "
            "Set LUPUS_V4_MODELS_DIR to the correct folder."
        )
    model_files = sorted(models_dir.glob("rf_model_*.joblib"))
    if not model_files:
        raise SystemExit(
            "ERROR: no RF model files in the models directory.\n"
            f"  Directory: {models_dir}\n"
            "  Expected files named rf_model_{cid}.joblib "
            "(e.g. rf_model_C01.joblib). The v4 notebook writes them to "
            "lupus_output_v4/04_Trained_Models/."
        )

    stats_path_s = os.environ.get("LUPUS_V4_PREPROC_STATS", "")
    stats_path: Path | None = Path(stats_path_s) if stats_path_s else None
    if stats_path is None:
        found = _first_existing(run_dir, STATS_CANDIDATES)
        if found is None:
            tried = "\n".join(f"  - {run_dir / c}" for c in STATS_CANDIDATES)
            raise SystemExit(
                "ERROR: preprocessing stats file not found.\n"
                "  Tried:\n" + tried + "\n"
                "  Set LUPUS_V4_PREPROC_STATS to global_preprocess_stats.json."
            )
        stats_path = found
    if not stats_path.is_file():
        raise SystemExit(
            "ERROR: preprocessing stats file not found.\n"
            f"  Looked for: {stats_path}\n"
            "  Set LUPUS_V4_PREPROC_STATS to global_preprocess_stats.json."
        )

    resolved: dict[str, Path] = {
        "LUPUS_V4_MODELS_DIR": models_dir,
        "LUPUS_V4_PREPROC_STATS": stats_path,
    }
    ck_s = os.environ.get("LUPUS_V4_CHECKPOINTS", "")
    ck: Path | None = Path(ck_s) if ck_s else _first_existing(run_dir, CHECKPOINTS_CANDIDATES)
    if ck is not None and ck.is_file():
        resolved["LUPUS_V4_CHECKPOINTS"] = ck
    else:
        print("WARNING: checkpoints.json not found under the run folder; "
              "LSTM counts and per-component validation notes will be unavailable.")
    ref_s = os.environ.get("LUPUS_REF_CSV", "")
    ref: Path | None = Path(ref_s) if ref_s else _first_existing(run_dir, REF_CANDIDATES)
    if ref is not None and ref.is_file():
        resolved["LUPUS_REF_CSV"] = ref
    else:
        print("WARNING: fixed reference CSV not found under the run folder; "
              "reports will use fallback scoring without reference thresholds.")
    return resolved


def main() -> None:
    resolved = resolve()
    for key, path in resolved.items():
        os.environ.setdefault(key, str(path))
    os.environ.setdefault("LUPUS_V4_LOG_DIR", str(SERVICE_DIR / "logs"))

    print(f"Models dir:  {resolved['LUPUS_V4_MODELS_DIR']}")
    print(f"Stats file:  {resolved['LUPUS_V4_PREPROC_STATS']}")
    if "LUPUS_V4_CHECKPOINTS" in resolved:
        print(f"Checkpoints: {resolved['LUPUS_V4_CHECKPOINTS']}")
    if "LUPUS_REF_CSV" in resolved:
        print(f"Reference:   {resolved['LUPUS_REF_CSV']}")
    print(f"Logs dir:    {os.environ['LUPUS_V4_LOG_DIR']}")

    sys.path.insert(0, str(SERVICE_DIR))
    import uvicorn

    port = int(os.environ.get("LUPUS_V4_PORT", "8100"))
    print(f"\nLupus Cortex Model Service v4 starting on http://127.0.0.1:{port}")
    print(f"Health: http://127.0.0.1:{port}/health")
    uvicorn.run("model_api_v4:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
