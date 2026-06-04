"""
PointVault Python Storage Worker - no Supabase Python package needed
Version: 0.5.0
Last updated: 2026-06-03
Notes:
- Robust parsing (v0.5.0): auto-detects comma/tab/semicolon/whitespace
  delimiters, strips a UTF-8 BOM, tolerant number parsing (unit suffixes and
  thousands separators), and broader header detection (X/Y/Z, lat/long, codes).
- Latitude/longitude inputs are now first-class: a row with valid lat/long is
  accepted even with no northing/easting. The DB transforms lat/long straight
  to WGS84; projected northing/easting still use the job's declared EPSG.
- skip_marker_filter (per-upload toggle): when set, every located row is
  accepted so coordinate-only / non-survey files import in full. Default off
  keeps the monument-code filter.
- Smarter monument filter: recognizes AXLE and more monument types, and a real
  marker code (IR/CIR/NID/AXLE/...) is accepted even when it sits in a tree,
  fence, or under EOC. Location words no longer veto valid markers.
- Honors a user-supplied column_mapping on the import job (label-the-columns
  feature). Falls back to auto-detect when no mapping is present.
- Automatically loads .env.worker from the project folder.
- Uses requests instead of the Supabase Python package.
- Downloads raw import files from Supabase Storage.
- Runs the starter cleaner.
- Uploads accepted/review/rejected/duplicate/KML/summary files back to Storage.
- Inserts accepted cleaned points directly into company_points through smaller RPC chunks.
- Reduced insert batch size to avoid Supabase statement timeouts.

Install only:
  python -m pip install requests

Environment file:
  .env.worker

Required values inside .env.worker:
  POINTVAULT_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
  POINTVAULT_SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY

Run:
  python pointvault_storage_worker.py

Important:
- Use the SERVICE ROLE key only on your private machine/server.
- Never put the service role key in the React app.
- Replace clean_point_file(...) with your existing Python cleaner code when ready.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import signal
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests


def _handle_termination(signum: int, _frame) -> None:
    raise KeyboardInterrupt(f"Received signal {signum}")


signal.signal(signal.SIGTERM, _handle_termination)


def load_worker_env(env_path: str = ".env.worker") -> None:
    path = Path(env_path)
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and value and key not in os.environ:
            os.environ[key] = value


load_worker_env()

SUPABASE_URL = os.environ.get("POINTVAULT_SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("POINTVAULT_SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "pointvault-imports"
POLL_SECONDS = 10
POINT_INSERT_BATCH_SIZE = 250


@dataclass
class CleanResult:
    total_rows: int
    accepted_rows: int
    rejected_rows: int
    duplicate_rows: int
    accepted_file: Path
    review_file: Path
    rejected_file: Path
    duplicate_file: Path
    summary_file: Path
    kml_file: Path | None = None


class PointVaultApi:
    def __init__(self, url: str, service_role_key: str):
        self.url = url.rstrip("/")
        self.headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        }
        self.upload_headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
        }

    def rpc(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        response = requests.post(
            f"{self.url}/rest/v1/rpc/{name}",
            headers=self.headers,
            json=payload or {},
            timeout=120,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"RPC {name} failed: {response.status_code} {response.text}")
        if not response.text:
            return None
        return response.json()

    def download_storage_file(self, bucket: str, path: str) -> bytes:
        response = requests.get(
            f"{self.url}/storage/v1/object/{bucket}/{path}",
            headers=self.upload_headers,
            timeout=300,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Storage download failed: {response.status_code} {response.text}")
        return response.content

    def upload_storage_file(self, bucket: str, path: str, local_path: Path, content_type: str) -> str:
        with local_path.open("rb") as file_handle:
            response = requests.post(
                f"{self.url}/storage/v1/object/{bucket}/{path}",
                headers={
                    **self.upload_headers,
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
                data=file_handle.read(),
                timeout=300,
            )
        if response.status_code >= 400:
            raise RuntimeError(f"Storage upload failed: {response.status_code} {response.text}")
        return path


_NUMERIC_CLEAN_RE = re.compile(r"[^0-9eE.+-]")


def safe_float(value: Any) -> float | None:
    text = str(value).strip()
    if not text:
        return None

    # Fast path: a clean number.
    try:
        return float(text)
    except (TypeError, ValueError):
        pass

    # Permissive fallback so the worker accepts what the browser preview shows
    # as usable: strip unit suffixes ("1234.5ft"), thousands commas
    # ("1,234,567.89"), and stray symbols. If the result is still ambiguous
    # (e.g. multiple dots from European thousands) we REJECT rather than guess,
    # because a wrong coordinate is worse than a rejected row.
    cleaned = _NUMERIC_CLEAN_RE.sub("", text)
    if cleaned in ("", "+", "-", ".") or cleaned.count(".") > 1:
        return None
    try:
        return float(cleaned)
    except (TypeError, ValueError):
        return None


def detect_delimiter(sample: str) -> str:
    """Pick the delimiter from the first non-empty line.

    Total stations and European exports often use tab or semicolon; some
    coordinate dumps are whitespace-delimited. Defaults to comma. Returns the
    literal " " sentinel to mean 'split on runs of whitespace'.
    """
    for line in sample.splitlines():
        if not line.strip():
            continue
        counts = {d: line.count(d) for d in (",", "\t", ";", "|")}
        best = max(counts, key=counts.get)
        if counts[best] > 0:
            return best
        if len(line.split()) > 1:
            return " "
        return ","
    return ","


def split_rows(text: str) -> list[list[str]]:
    """Tokenize file text into rows, auto-detecting the delimiter."""
    delimiter = detect_delimiter(text)
    rows: list[list[str]] = []

    if delimiter == " ":
        for line in text.splitlines():
            if line.strip():
                rows.append(line.split())
        return rows

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for row in reader:
        if row and any(str(cell).strip() for cell in row):
            rows.append(row)
    return rows


def normalize_description(value: str) -> str:
    return str(value or "").strip().upper()


MARKER_TOKENS = [
    "IP",
    "IR",
    "CIR",
    "REBAR",
    "RBR",
    "RBC",
    "ROD",
    "PIPE",
    "CM",
    "CONC MON",
    "CONCRETE MONUMENT",
    "MON",
    "NID",
    "PRM",
    "MAG",
    "PK",
    "NAIL",
    "60D",
    "SPIKE",
    "RR SPIKE",
    "RRSPIKE",
    "AXLE",
    "HUB",
    "LWH",
    "DISK",
    "DISC",
    "BRASS",
    "X CUT",
    "XCUT",
    "BM",
    "BENCH",
    "TBM",
    "CONTROL",
]


def is_marker_description(description: str) -> bool:
    """
    Decide whether a row describes a real survey monument worth keeping.

    A recognized monument code (IR, CIR, NID, AXLE, ...) wins even when the
    description also says *where* it sits -- "IN TREE", "IN OAK", "ON FENCE",
    "UNDER EOC" are locations, not reasons to drop the point. Rows with no
    recognized monument code fall through to review (this still filters out
    topo shots, house corners, utilities, and anything unfamiliar).
    """
    d = normalize_description(description)
    if not d:
        return False
    return any(token in d for token in MARKER_TOKENS)


def read_rows_with_mapping(raw_rows: list[list[str]], column_mapping: dict[str, Any]) -> list[dict[str, str]]:
    """
    Use the explicit column_mapping the user set in the uploader, so we map
    columns by their labels instead of guessing the layout.

    column_mapping shape: {"has_header": bool, "columns": {field: column_index}}
    """
    columns = (column_mapping or {}).get("columns") or {}
    has_header = bool((column_mapping or {}).get("has_header"))
    data_rows = raw_rows[1:] if has_header else raw_rows

    def cell(raw: list[str], field: str) -> str:
        index = columns.get(field)
        if index is None:
            return ""
        return raw[index].strip() if 0 <= index < len(raw) else ""

    rows: list[dict[str, str]] = []
    for raw in data_rows:
        rows.append(
            {
                "point": cell(raw, "point"),
                "northing": cell(raw, "northing"),
                "easting": cell(raw, "easting"),
                "elevation": cell(raw, "elevation"),
                "latitude": cell(raw, "latitude"),
                "longitude": cell(raw, "longitude"),
                "description": cell(raw, "description"),
                "source_file": "",
            }
        )
    return rows


def read_point_rows(raw_file: Path, column_mapping: dict[str, Any] | None = None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    # encoding="utf-8-sig" strips a leading BOM so the first header cell isn't
    # "﻿point"; split_rows auto-detects comma/tab/semicolon/whitespace.
    text = raw_file.read_text(encoding="utf-8-sig", errors="ignore")
    raw_rows = split_rows(text)

    if not raw_rows:
        return []

    # If the user labelled the columns at upload time, trust those labels.
    if column_mapping and (column_mapping.get("columns") or {}):
        mapped = read_rows_with_mapping(raw_rows, column_mapping)
        for row in mapped:
            if not row.get("source_file"):
                row["source_file"] = raw_file.name
        return mapped

    def norm(cell: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(cell).strip().lower())

    header_tokens = {
        "point", "pointid", "pt", "ptid", "pnt", "number", "name", "id",
        "northing", "north", "n", "y", "easting", "east", "e", "x",
        "elevation", "elev", "z", "height",
        "latitude", "lat", "longitude", "long", "lng", "lon",
        "description", "desc", "descript", "note", "notes", "code",
    }
    first_norm = [norm(cell) for cell in raw_rows[0]]
    has_header = any(token in header_tokens for token in first_norm)

    if has_header:
        def find(*candidates: str) -> int | None:
            for index, key in enumerate(first_norm):
                if key in candidates:
                    return index
            return None

        col = {
            "point": find("point", "pointid", "pt", "ptid", "pnt", "number", "name", "id"),
            "northing": find("northing", "north", "n", "y"),
            "easting": find("easting", "east", "e", "x"),
            "elevation": find("elevation", "elev", "z", "height"),
            "latitude": find("latitude", "lat"),
            "longitude": find("longitude", "long", "lng", "lon"),
            "description": find("description", "desc", "descript", "note", "notes", "code"),
        }

        def cell(raw: list[str], field: str) -> str:
            index = col.get(field)
            return raw[index].strip() if index is not None and 0 <= index < len(raw) else ""

        for raw in raw_rows[1:]:
            rows.append(
                {
                    "point": cell(raw, "point"),
                    "northing": cell(raw, "northing"),
                    "easting": cell(raw, "easting"),
                    "elevation": cell(raw, "elevation"),
                    "latitude": cell(raw, "latitude"),
                    "longitude": cell(raw, "longitude"),
                    "description": cell(raw, "description"),
                    "source_file": raw_file.name,
                }
            )
        return rows

    for raw in raw_rows:
        # Need at least point + northing + easting. Coordinate-only files
        # (3 columns, no description/elevation) used to be dropped entirely.
        if len(raw) < 3:
            continue

        point = raw[0].strip()
        northing = raw[1].strip() if len(raw) > 1 else ""
        easting = raw[2].strip() if len(raw) > 2 else ""
        fourth = raw[3].strip() if len(raw) > 3 else ""

        if safe_float(fourth) is not None and len(raw) >= 5:
            elevation = fourth
            description = " ".join(cell.strip() for cell in raw[4:] if cell.strip())
            source_file = raw_file.name
        else:
            elevation = ""
            description = fourth
            source_file = " ".join(cell.strip() for cell in raw[4:] if cell.strip()) or raw_file.name

        rows.append(
            {
                "point": point,
                "northing": northing,
                "easting": easting,
                "elevation": elevation,
                "latitude": "",
                "longitude": "",
                "description": description,
                "source_file": source_file,
            }
        )

    return rows


def grid_key(northing: float, easting: float, tolerance_ft: float = 1.0) -> tuple[int, int]:
    return (int(northing // tolerance_ft), int(easting // tolerance_ft))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = ["point", "northing", "easting", "elevation", "latitude", "longitude", "description", "source_file"]
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def write_kml(path: Path, rows: list[dict[str, Any]]) -> None:
    kml_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
        '<name>PointVault Processed Points</name>',
        '<!-- Replace this placeholder with your existing KML output logic. -->',
        '</Document></kml>',
    ]
    newline = chr(10)
    path.write_text(newline.join(kml_lines) + newline, encoding="utf-8")


def clean_point_file(
    raw_file: Path,
    output_dir: Path,
    column_mapping: dict[str, Any] | None = None,
    skip_marker_filter: bool = False,
) -> CleanResult:
    rows = read_point_rows(raw_file, column_mapping)

    accepted: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    seen: dict[tuple, dict[str, Any]] = {}

    for row in rows:
        n = safe_float(row.get("northing"))
        e = safe_float(row.get("easting"))
        lat = safe_float(row.get("latitude"))
        lng = safe_float(row.get("longitude"))
        description = row.get("description", "")

        has_ne = n is not None and e is not None
        has_latlng = (
            lat is not None and -90.0 <= lat <= 90.0
            and lng is not None and -180.0 <= lng <= 180.0
        )

        # A row needs SOME usable location: projected northing/easting OR
        # geographic latitude/longitude. Lat/long files used to be rejected.
        if not has_ne and not has_latlng:
            rejected.append(row)
            continue

        # When skip_marker_filter is on (coordinate-only / non-survey uploads)
        # every located row is accepted; otherwise a recognized monument code
        # is still required and the rest fall through to manual review.
        if not skip_marker_filter and not is_marker_description(description):
            review.append(row)
            continue

        # Dedup by projected grid when available, else by a ~1ft lat/long grid
        # (6 decimal places of a degree ~= 0.11m).
        if has_ne:
            key: tuple = grid_key(n, e, tolerance_ft=1.0)
        else:
            key = ("ll", round(lat, 6), round(lng, 6))

        if key in seen:
            duplicates.append(row)
            continue

        seen[key] = row
        accepted.append(row)

    accepted_file = output_dir / "accepted_points.csv"
    review_file = output_dir / "review_points.csv"
    rejected_file = output_dir / "rejected_points.csv"
    duplicate_file = output_dir / "duplicate_points.csv"
    summary_file = output_dir / "import_summary.json"
    kml_file = output_dir / "output.kml"

    write_csv(accepted_file, accepted)
    write_csv(review_file, review)
    write_csv(rejected_file, rejected)
    write_csv(duplicate_file, duplicates)
    write_kml(kml_file, accepted)

    summary = {
        "total_rows": len(rows),
        "accepted_rows": len(accepted),
        "review_rows": len(review),
        "rejected_rows": len(rejected),
        "duplicate_rows": len(duplicates),
        "raw_file": raw_file.name,
    }

    summary_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    return CleanResult(
        total_rows=len(rows),
        accepted_rows=len(accepted),
        rejected_rows=len(rejected) + len(review),
        duplicate_rows=len(duplicates),
        accepted_file=accepted_file,
        review_file=review_file,
        rejected_file=rejected_file,
        duplicate_file=duplicate_file,
        summary_file=summary_file,
        kml_file=kml_file,
    )


def read_csv_dicts(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        reader = csv.DictReader(f)
        return [dict(row) for row in reader]


def insert_accepted_points_into_pointvault(
    api: PointVaultApi,
    import_job_id: str,
    accepted_file: Path,
    batch_size: int = POINT_INSERT_BATCH_SIZE,
) -> tuple[int, int]:
    rows = read_csv_dicts(accepted_file)

    api.rpc(
        "clear_company_points_for_storage_import",
        {
            "target_import_job_id": import_job_id,
        },
    )

    total_inserted = 0
    total_skipped = 0

    for index in range(0, len(rows), batch_size):
        batch = rows[index:index + batch_size]

        result = api.rpc(
            "insert_storage_import_points_chunk",
            {
                "target_import_job_id": import_job_id,
                "points_json": batch,
                "duplicate_tolerance_ft": 1.0,
            },
        )

        total_inserted += int((result or {}).get("inserted_points") or 0)
        total_skipped += int((result or {}).get("skipped_points") or 0)

        print(
            f"Inserted {total_inserted:,} accepted points "
            f"({total_skipped:,} skipped duplicates)"
        )

    return total_inserted, total_skipped


def process_one_job(api: PointVaultApi) -> bool:
    claim = api.rpc("claim_next_storage_import_job", {})
    job = (claim or {}).get("job")

    if not job:
        print("No queued PointVault import jobs.")
        return False

    job_id = job["id"]
    bucket = job.get("bucket") or BUCKET
    raw_path = job["raw_storage_path"]
    prefix = job["prefix"]
    column_mapping = job.get("column_mapping")
    skip_marker_filter = bool(job.get("skip_marker_filter"))

    print(f"Processing import job {job_id}")
    print(f"Downloading {raw_path}")

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            raw_file = tmpdir / Path(raw_path).name
            output_dir = tmpdir / "processed"
            output_dir.mkdir(parents=True, exist_ok=True)

            raw_bytes = api.download_storage_file(bucket, raw_path)
            raw_file.write_bytes(raw_bytes)

            result = clean_point_file(raw_file, output_dir, column_mapping, skip_marker_filter)

            processed_prefix = f"{prefix}/processed"
            accepted_path = api.upload_storage_file(
                bucket,
                f"{processed_prefix}/accepted_points.csv",
                result.accepted_file,
                "text/csv",
            )
            review_path = api.upload_storage_file(
                bucket,
                f"{processed_prefix}/review_points.csv",
                result.review_file,
                "text/csv",
            )
            rejected_path = api.upload_storage_file(
                bucket,
                f"{processed_prefix}/rejected_points.csv",
                result.rejected_file,
                "text/csv",
            )
            duplicate_path = api.upload_storage_file(
                bucket,
                f"{processed_prefix}/duplicate_points.csv",
                result.duplicate_file,
                "text/csv",
            )
            summary_path = api.upload_storage_file(
                bucket,
                f"{processed_prefix}/import_summary.json",
                result.summary_file,
                "application/json",
            )
            kml_path = None
            if result.kml_file and result.kml_file.exists():
                kml_path = api.upload_storage_file(
                    bucket,
                    f"{processed_prefix}/output.kml",
                    result.kml_file,
                    "application/vnd.google-earth.kml+xml",
                )

            inserted_points, skipped_points = insert_accepted_points_into_pointvault(
                api,
                job_id,
                result.accepted_file,
            )

            api.rpc(
                "mark_storage_import_processed",
                {
                    "target_import_job_id": job_id,
                    "accepted_path": accepted_path,
                    "review_path": review_path,
                    "rejected_path": rejected_path,
                    "duplicate_path": duplicate_path,
                    "kml_path": kml_path,
                    "summary_path": summary_path,
                    "total_rows": result.total_rows,
                    "accepted_rows": result.accepted_rows,
                    "rejected_rows": result.rejected_rows,
                    "duplicate_rows": result.duplicate_rows,
                    "cleaned_file_size_bytes": result.accepted_file.stat().st_size,
                    "worker_message": (
                        "Python cleaner finished. "
                        f"Promoted {inserted_points:,} points into PointVault "
                        f"({skipped_points:,} skipped)."
                    ),
                },
            )

            print(
                f"Promoted {inserted_points:,} points into PointVault "
                f"({skipped_points:,} skipped)."
            )
            print(f"Finished import job {job_id}")
            return True

    except Exception as exc:
        message = f"Python worker failed: {exc}"
        print(message)
        api.rpc(
            "mark_storage_import_failed",
            {
                "target_import_job_id": job_id,
                "worker_message": message,
            },
        )
        return True

    except BaseException as exc:
        message = f"Worker interrupted by {type(exc).__name__} before job completed."
        print(message)
        try:
            api.rpc(
                "mark_storage_import_failed",
                {
                    "target_import_job_id": job_id,
                    "worker_message": message,
                },
            )
        except Exception:
            pass
        raise


def main() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "Set POINTVAULT_SUPABASE_URL and POINTVAULT_SUPABASE_SERVICE_ROLE_KEY first."
        )

    api = PointVaultApi(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    while True:
        did_work = process_one_job(api)
        if not did_work:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()

