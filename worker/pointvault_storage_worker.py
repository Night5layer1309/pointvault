"""
PointVault Python Storage Worker - no Supabase Python package needed
Version: 0.3.1
Last updated: 2026-05-17
Notes:
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
import json
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests


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


def safe_float(value: Any) -> float | None:
    try:
        text = str(value).strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def normalize_description(value: str) -> str:
    return str(value or "").strip().upper()


def is_marker_description(description: str) -> bool:
    """
    Starter matcher only. Replace/expand with your existing Python rules.
    """
    d = normalize_description(description)
    accepted_tokens = [
        "IP",
        "IR",
        "CIR",
        "CM",
        "CONC MON",
        "CONCRETE MONUMENT",
        "NID",
        "PRM",
        "MAG",
        "PK",
        "NAIL",
        "60D",
        "HUB",
        "LWH",
        "BM",
        "BENCH",
        "CONTROL",
    ]
    rejected_tokens = [
        "HOUSE",
        "BUILDING",
        "EOC",
        "EDGE OF CONC",
        "EDGE CONCRETE",
        "TREE",
        "OAK",
        "PINE",
        "FENCE",
        "POWER POLE",
        "WATER METER",
        "VALVE",
        "MANHOLE",
        "TOPO",
    ]

    if any(token in d for token in rejected_tokens):
        return False
    return any(token in d for token in accepted_tokens)


def read_point_rows(raw_file: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    with raw_file.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        reader = csv.reader(f)
        raw_rows = [row for row in reader if row and any(str(cell).strip() for cell in row)]

    if not raw_rows:
        return []

    first = [cell.strip() for cell in raw_rows[0]]
    first_lower = [cell.lower() for cell in first]
    has_header = any(
        cell in {"point", "point_id", "pt", "northing", "easting", "description"}
        for cell in first_lower
    )

    if has_header:
        headers = first_lower
        for raw in raw_rows[1:]:
            item = {headers[i]: raw[i].strip() if i < len(raw) else "" for i in range(len(headers))}
            rows.append(
                {
                    "point": item.get("point") or item.get("point_id") or item.get("pt") or item.get("id") or "",
                    "northing": item.get("northing") or item.get("n") or item.get("y") or "",
                    "easting": item.get("easting") or item.get("e") or item.get("x") or "",
                    "elevation": item.get("elevation") or item.get("elev") or item.get("z") or "",
                    "description": item.get("description") or item.get("desc") or "",
                    "source_file": item.get("source_file") or item.get("file") or raw_file.name,
                }
            )
        return rows

    for raw in raw_rows:
        if len(raw) < 4:
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
                "description": description,
                "source_file": source_file,
            }
        )

    return rows


def grid_key(northing: float, easting: float, tolerance_ft: float = 1.0) -> tuple[int, int]:
    return (int(northing // tolerance_ft), int(easting // tolerance_ft))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = ["point", "northing", "easting", "elevation", "description", "source_file"]
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


def clean_point_file(raw_file: Path, output_dir: Path) -> CleanResult:
    rows = read_point_rows(raw_file)

    accepted: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    seen: dict[tuple[int, int], dict[str, Any]] = {}

    for row in rows:
        n = safe_float(row.get("northing"))
        e = safe_float(row.get("easting"))
        description = row.get("description", "")

        if n is None or e is None:
            rejected.append(row)
            continue

        if not is_marker_description(description):
            review.append(row)
            continue

        key = grid_key(n, e, tolerance_ft=1.0)
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

            result = clean_point_file(raw_file, output_dir)

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

