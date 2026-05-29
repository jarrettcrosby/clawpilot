#!/usr/bin/env python3
"""Sync pipeline data from Maton Google Sheets into local normalized JSON.

Writes:
- data/pipeline/raw/last-sync.json (or PIPELINE_RAW_PATH)
- data/pipeline/normalized/current.json (or PIPELINE_NORMALIZED_PATH)
"""

from __future__ import annotations

import json
import os
import pathlib
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_RAW = ROOT / "data" / "pipeline" / "raw"
DATA_NORM = ROOT / "data" / "pipeline" / "normalized"
LOG_FILE = ROOT / "data" / "logs" / "pipeline-events.jsonl"

# honor environment overrides for dev runtime
ENV_PIPELINE_RAW = os.environ.get("PIPELINE_RAW_PATH")
ENV_PIPELINE_NORM = os.environ.get("PIPELINE_NORMALIZED_PATH")

SHEET_ID = "1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY"
BASE_URL = os.environ.get("MATON_BASE_URL", "https://gateway.maton.ai").rstrip("/")

KEY_PATHS = [
    pathlib.Path.home() / ".openclaw" / "workspace" / "credentials" / "maton_api_key.txt",
    ROOT / "credentials" / "maton_api_key.txt",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_key() -> str:
    for p in KEY_PATHS:
        if p.exists():
            key = p.read_text(encoding="utf-8").strip()
            if key:
                return key
    raise RuntimeError("Maton API key not found in expected locations")


def request_json(path: str, key: str) -> tuple[int, dict]:
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw) if raw else {}
        except Exception:
            return e.code, {"error": raw[:2000]}


def read_range(range_a1: str, key: str) -> list[list[str]]:
    path = f"/google-sheets/v4/spreadsheets/{SHEET_ID}/values/{urllib.parse.quote(range_a1, safe='!():')}"
    status, data = request_json(path, key)
    if status != 200:
        raise RuntimeError(f"Range fetch failed {range_a1}: HTTP {status} {str(data)[:400]}")
    return data.get("values", [])


def parse_money(v: str) -> float:
    try:
        return float((v or "").replace("$", "").replace(",", "").strip() or 0)
    except Exception:
        return 0.0


def parse_percent(v: str) -> int:
    try:
        return int((v or "").replace("%", "").strip() or 0)
    except Exception:
        return 0


def map_opportunity(row: list[str], idx: int) -> dict:
    # B..M from Opportunities sheet layout currently in use
    return {
        "id": f"opp_{idx+1}",
        "priority": (row[0] if len(row) > 0 else "").strip(),
        "name": (row[1] if len(row) > 1 else "").strip(),
        "owner": (row[2] if len(row) > 2 else "").strip(),
        "organization": (row[3] if len(row) > 3 else "").strip(),
        "status": (row[4] if len(row) > 4 else "").strip(),
        "stage": (row[5] if len(row) > 5 else "").strip(),
        "lossReason": (row[6] if len(row) > 6 else "").strip(),
        "source": (row[7] if len(row) > 7 else "").strip(),
        "valueRaw": (row[8] if len(row) > 8 else "").strip(),
        "value": parse_money(row[8] if len(row) > 8 else ""),
        "probability": parse_percent(row[9] if len(row) > 9 else ""),
        "expectedClose": (row[10] if len(row) > 10 else "").strip(),
        "notes": (row[11] if len(row) > 11 else "").strip(),
    }


def log_event(action: str, result: str, detail: dict | None = None) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": now_iso(),
        "module": "pipeline-sync-script",
        "action": action,
        "result": result,
        "detail": detail or {},
    }
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def verify_target(path: pathlib.Path, max_age_seconds: int = 120) -> tuple[bool, str]:
    """Verify target exists and was updated recently (default: 2 minutes)."""
    if not path.exists():
        return False, f"Target file does not exist: {path}"
    mtime = path.stat().st_mtime
    age = time.time() - mtime
    if age > max_age_seconds:
        return False, f"Target file is older than {max_age_seconds}s ({int(age)}s): {path}"
    return True, "ok"


def main() -> int:
    DATA_RAW.mkdir(parents=True, exist_ok=True)
    DATA_NORM.mkdir(parents=True, exist_ok=True)

    key = read_key()
    synced_at = now_iso()

    opp_rows = read_range("Opportunities!B5:M2000", key)
    org_rows = read_range("Organizations!B5:M2000", key)
    contact_rows = read_range("Contacts!B5:M2000", key)

    opportunities = [
        map_opportunity(r, i)
        for i, r in enumerate(opp_rows)
        if (len(r) > 1 and (r[1] or "").strip())
    ]

    normalized = {
        "syncedAt": synced_at,
        "source": {
            "provider": "maton-google-sheets",
            "sheetId": SHEET_ID,
            "ranges": {
                "opportunities": "Opportunities!B5:M2000",
                "organizations": "Organizations!B5:M2000",
                "contacts": "Contacts!B5:M2000",
            },
        },
        "summary": {
            "opportunities": len(opportunities),
            "organizations": len([r for r in org_rows if len(r) > 1 and (r[1] or "").strip()]),
            "contacts": len([r for r in contact_rows if len(r) > 1 and (r[1] or "").strip()]),
            "totalOpenValue": round(sum(o.get("value", 0) for o in opportunities if o.get("status", "").lower() not in {"abandoned", "loss", "closed", "closed-lost"}), 2),
        },
        "opportunities": opportunities,
    }

    raw = {
        "syncedAt": synced_at,
        "counts": {
            "opportunityRows": len(opp_rows),
            "organizationRows": len(org_rows),
            "contactRows": len(contact_rows),
            "normalizedOpportunities": len(opportunities),
        },
        "sample": {
            "opportunitiesFirst": opp_rows[0] if opp_rows else [],
            "organizationsFirst": org_rows[0] if org_rows else [],
            "contactsFirst": contact_rows[0] if contact_rows else [],
        },
    }

    # write raw
    raw_target = pathlib.Path(ENV_PIPELINE_RAW) if ENV_PIPELINE_RAW else (DATA_RAW / "last-sync.json")
    raw_target.parent.mkdir(parents=True, exist_ok=True)
    raw_target.write_text(json.dumps(raw, indent=2), encoding="utf-8")

    # write normalized: prefer PIPELINE_NORMALIZED_PATH when set (dev direct-write)
    norm_target = pathlib.Path(ENV_PIPELINE_NORM) if ENV_PIPELINE_NORM else (DATA_NORM / "current.json")
    norm_target.parent.mkdir(parents=True, exist_ok=True)
    norm_target.write_text(json.dumps(normalized, indent=2), encoding="utf-8")

    # small verification: ensure the normalized target exists and is recent
    ok, detail = verify_target(norm_target, max_age_seconds=120)
    if not ok:
        log_event("pull", "error", {"error": detail})
        print(json.dumps({"ok": False, "error": detail}))
        return 2

    log_event("pull", "ok", normalized["summary"])
    print(json.dumps({"ok": True, "syncedAt": synced_at, "summary": normalized["summary"]}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        try:
            log_event("pull", "error", {"error": str(e)})
        finally:
            raise
