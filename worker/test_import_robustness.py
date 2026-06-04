"""Local sanity tests for the worker's parsing/cleaning (no Supabase needed).
Run: python test_import_robustness.py
"""
import tempfile
from pathlib import Path

import pointvault_storage_worker as w


def check(name, got, want):
    ok = got == want
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    return ok


def write(tmp, name, text):
    p = Path(tmp) / name
    p.write_text(text, encoding="utf-8")
    return p


def write_bytes(tmp, name, data: bytes):
    p = Path(tmp) / name
    p.write_bytes(data)
    return p


def clean(tmp, raw_file, skip=False):
    out = Path(tmp) / "out"
    out.mkdir(exist_ok=True)
    return w.clean_point_file(raw_file, out, None, skip)


fails = 0
with tempfile.TemporaryDirectory() as tmp:
    # ---- safe_float (U4) ----
    fails += not check("safe_float plain", w.safe_float("1234.5"), 1234.5)
    fails += not check("safe_float unit suffix", w.safe_float("1234.5ft"), 1234.5)
    fails += not check("safe_float thousands", w.safe_float("1,234,567.89"), 1234567.89)
    fails += not check("safe_float negative", w.safe_float("-12.5"), -12.5)
    fails += not check("safe_float ambiguous multidot", w.safe_float("1.234.567"), None)
    fails += not check("safe_float junk", w.safe_float("abc"), None)
    fails += not check("safe_float empty", w.safe_float("  "), None)

    # ---- detect_delimiter (U3) ----
    fails += not check("delim comma", w.detect_delimiter("a,b,c\n1,2,3"), ",")
    fails += not check("delim tab", w.detect_delimiter("a\tb\tc"), "\t")
    fails += not check("delim semicolon", w.detect_delimiter("a;b;c"), ";")
    fails += not check("delim whitespace", w.detect_delimiter("a  b   c"), " ")

    # ---- header detection: standard ----
    f = write(tmp, "std.csv", "point,northing,easting,elevation,description\n1,1000.0,2000.0,50,IR\n2,1001,2001,51,CIR\n")
    rows = w.read_point_rows(f)
    fails += not check("std header rowcount", len(rows), 2)
    fails += not check("std header N/E", (rows[0]["northing"], rows[0]["easting"]), ("1000.0", "2000.0"))

    # ---- header detection: X/Y/Z + Name (U5) ----
    f = write(tmp, "xy.csv", "Name,Y,X,Z,Desc\nP1,1000,2000,50,IR\nP2,1001,2001,51,REBAR\n")
    rows = w.read_point_rows(f)
    fails += not check("xy header rowcount", len(rows), 2)
    fails += not check("xy header maps Y->northing", rows[0]["northing"], "1000")
    fails += not check("xy header maps X->easting", rows[0]["easting"], "2000")

    # ---- lat/long header (R3) ----
    f = write(tmp, "ll.csv", "point,latitude,longitude,description\n1,30.4383,-84.2807,IR\n2,30.4390,-84.2810,CIR\n")
    rows = w.read_point_rows(f)
    fails += not check("latlong parsed", (rows[0]["latitude"], rows[0]["longitude"]), ("30.4383", "-84.2807"))
    res = clean(tmp, f)
    fails += not check("latlong accepted (was impossible before)", res.accepted_rows, 2)

    # ---- BOM (U5) ----
    f = write_bytes(tmp, "bom.csv", b"\xef\xbb\xbfpoint,northing,easting,description\n1,1000,2000,IR\n")
    rows = w.read_point_rows(f)
    fails += not check("BOM header recognized -> 1 data row", len(rows), 1)
    fails += not check("BOM N parsed", rows[0]["northing"], "1000")

    # ---- semicolon-delimited (U3) ----
    f = write(tmp, "semi.csv", "point;northing;easting;description\n1;1000;2000;IR\n2;1001;2001;CIR\n")
    res = clean(tmp, f)
    fails += not check("semicolon accepted", res.accepted_rows, 2)

    # ---- tab-delimited (U3) ----
    f = write(tmp, "tab.txt", "point\tnorthing\teasting\tdescription\n1\t1000\t2000\tIR\n")
    res = clean(tmp, f)
    fails += not check("tab accepted", res.accepted_rows, 1)

    # ---- coords-only, no description (U1) ----
    f = write(tmp, "coords.csv", "1,1000.0,2000.0\n2,1001.0,2001.0\n3,1002.0,2002.0\n")
    res_off = clean(tmp, f, skip=False)
    fails += not check("coords-only filter OFF -> 0 accepted (all review)", res_off.accepted_rows, 0)
    res_on = clean(tmp, f, skip=True)
    fails += not check("coords-only filter ON -> all accepted", res_on.accepted_rows, 3)

print()
print("ALL PASS" if fails == 0 else f"{fails} FAILURE(S)")
