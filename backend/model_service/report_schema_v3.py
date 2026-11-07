# Vendored verbatim from the canonical v3 service (~/workspace/lupus_repo/backend/model_service/report_schema_v3.py).
# Do not edit here; change the canonical file and re-vendor.
"""
Lupus Cortex — Canonical Report Schema v3.

Replaces the incompatible schema 1.0 (gateway) / 2.1 (dashboard API) split.
Every analytical endpoint returns this schema. Versioned, validated.

Design rules:
- 30 canonical component IDs (C01-C13, C15, C17-C30b); C14/C16 are derived, not core
- Missing components are listed with availability="unavailable", NEVER invented
- Proxy/derived/scenario values are labelled as such
- Fixed reference thresholds are interpretation aids, NOT training targets
"""
from __future__ import annotations

SCHEMA_VERSION = "3.0"

# Canonical component IDs in report order (30 approved core)
# Excludes C14 and C16 (derived variables, not core components)
CANONICAL_COMPONENTS = [
    "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10",
    "C11", "C12", "C13", "C15", "C17", "C18", "C19", "C20",
    "C21", "C22", "C23", "C24", "C25", "C26", "C27", "C28", "C29a", "C29b",
    "C30a", "C30b",
]

# Nine domain indices (with v2.1-compatible display fields)
INDICES = ["AQHI", "UHVI", "GEAI", "WSII", "TAI", "HAI", "CRI", "SCI", "DRI"]

INDEX_DEFS = {
    "AQHI": {"name": "Air Quality Health Index", "category": "Atmospheric Exposure",
             "description": "Tracks particulate, gaseous, and aerosol exposure affecting population health.",
             "target": 78, "components": ["C01", "C02", "C03", "C04", "C05", "C06", "C07"]},
    "UHVI": {"name": "Urban Heat Vulnerability Index", "category": "Heat & Climate",
             "description": "Combines thermal exposure, urban form, greenery, and population vulnerability.",
             "target": 76, "components": ["C08", "C09", "C10", "C11", "C21"]},
    "GEAI": {"name": "Green Environment Accessibility Index", "category": "Ecological Condition",
             "description": "Measures vegetation condition, green-space coverage, and green-space access.",
             "target": 78, "components": ["C11", "C12", "C26"]},
    "WSII": {"name": "Water Security & Infrastructure Index", "category": "Water & Infrastructure",
             "description": "Assesses water availability, hydrological extremes, flood and drought exposure, and terrain.",
             "target": 75, "components": ["C15", "C17", "C18"],
             "derived_inputs": ["C16"],  # extreme_rainfall_indicator, derived from C15, not a core component
             "note": "C16 is computed from C15 precipitation; WSII core dependencies are C15/C17/C18"},
    "TAI": {"name": "Transport Accessibility Index", "category": "Access Systems",
            "description": "Measures road-network availability and public-transport access.",
            "target": 78, "components": ["C23", "C24"]},
    "HAI": {"name": "Healthcare Accessibility Index", "category": "Access Systems",
            "description": "Measures access to hospitals, critical infrastructure, and the population served.",
            "target": 78, "components": ["C25", "C27"]},
    "CRI": {"name": "Climate Resilience Index", "category": "Climate Resilience",
            "description": "Combines hydrological hazards, terrain, soil moisture, and disaster readiness.",
            "target": 76, "components": ["C19", "C20", "C30a", "C30b"]},
    "SCI": {"name": "Social / Urban Vulnerability Index", "category": "Social Vulnerability",
            "description": "Measures social exposure through population, urban form, access, services, and activity.",
            "target": 74, "components": ["C21", "C22", "C28", "C13"]},
    "DRI": {"name": "Disaster Readiness Index", "category": "Disaster Readiness",
            "description": "Measures preparedness alongside flood, heat, terrain, infrastructure, and population exposure.",
            "target": 76, "components": ["C30a", "C30b", "C29a", "C29b"]},
}

# HWI weights (documented, versioned)
HWI_WEIGHTS = {
    "AQHI": 0.25, "UHVI": 0.20, "HAI": 0.15, "WSII": 0.15,
    "SCI": 0.15, "GEAI": 0.10,
}
HWI_VERSION = "1.0"

SCORE_LABELS = [
    (81, 100, "Perfect"),
    (61, 80, "Well managed"),
    (41, 60, "Needs improvement"),
    (21, 40, "Poor"),
    (0, 20, "Harmful"),
]

def score_label(score: float | None) -> str:
    if score is None:
        return "Unavailable"
    for lo, hi, label in SCORE_LABELS:
        if lo <= score <= hi:
            return label
    return "Unavailable"


def report_skeleton() -> dict:
    """Empty v3 report with all required top-level keys."""
    return {
        "schema_version": SCHEMA_VERSION,
        "analysis_id": None,
        "model_version": None,
        "location": {"lat": None, "lon": None, "name": None},
        "time": {"analysis_utc": None, "observation_period": None},
        "data_quality": {"coverage_pct": None, "n_components_available": 0,
                         "n_components_total": 30, "notes": []},
        "components": {},   # canonical_id -> component result
        "indices": {},       # index key -> {score, label, components, method, coverage}
        "hwi": {"score": None, "label": None, "method": f"weighted mean v{HWI_VERSION}"},
        "analysis": {"summary": None, "findings": [], "risks": []},
        "history": {"trend": None, "anomalies": []},
        "forecasts": {"horizon": None, "values": [], "uncertainty": None, "note": None},
        "warnings": [],
        "recommendations": {"individual": [], "community": [], "industrial": [], "government": []},
        "case_studies": [],
        "provenance": {"model_artifacts": {}, "data_sources": [], "limitations": []},
    }


def validate_report(report: dict) -> list[str]:
    """Return list of validation errors (empty = valid)."""
    errors = []
    if report.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    required = ["analysis_id", "model_version", "location", "time", "data_quality",
                "components", "indices", "hwi", "analysis", "history", "forecasts",
                "warnings", "recommendations", "provenance"]
    for key in required:
        if key not in report:
            errors.append(f"missing required key: {key}")
    # Every canonical component must be present (available or explicitly unavailable)
    comps = report.get("components", {})
    for cid in CANONICAL_COMPONENTS:
        if cid not in comps:
            errors.append(f"component {cid} missing from report (must be present even if unavailable)")
        elif comps[cid].get("availability") not in ("available", "derived", "proxy", "measured", "unavailable", "scenario"):
            errors.append(f"component {cid} has invalid availability label")
    for ikey in INDICES:
        if ikey not in report.get("indices", {}):
            errors.append(f"index {ikey} missing from report")
    return errors
