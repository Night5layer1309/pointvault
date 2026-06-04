# Import robustness — verification corpus

Upload each file in the **Data Import** panel against the LIVE worker after deploy.
Unless noted, set **EPSG 2238 / NAD83 Florida North (ftUS)** and tick the confirm box.

| File | Upload settings | Expected AFTER the fix | Was BEFORE the fix |
|---|---|---|---|
| 00_happy_florida_markers.csv | EPSG 2238, filter ON (default) | 5 accepted, centroid in N. Florida | 5 accepted (unchanged) |
| R3_latlong_markers.csv | **EPSG 4326**, filter default | 4 accepted, centroid ~30.439, -84.280 | **0 / rejected (impossible)** |
| R2_bad_epsg.csv | **EPSG 99999**, filter default | Job fails with a clear "Unknown … EPSG 99999" message | Cryptic crash / whole job dead |
| U1_coords_only.csv | EPSG 2238, **toggle ON** | 4 accepted | **0 accepted (all to review)** |
| U1_coords_only.csv | EPSG 2238, toggle OFF | 0 accepted / 4 review (intended) | 0 accepted |
| U3_semicolon.csv | EPSG 2238 | 3 accepted | **0 (everything rejected)** |
| U3_tab.txt | EPSG 2238 | 2 accepted | **0 (everything rejected)** |
| U4_units_and_thousands.csv | EPSG 2238 | 2 accepted | **0 (numbers rejected)** |
| U5_xy_header.csv | EPSG 2238 | 3 accepted | Header row leaked in / mismapped |

R1 (wrong-region guard) is verified by the UI itself: the upload button stays
disabled until you tick the **"I confirm these points are in …"** box, and every
finished job shows **"Imported points center near <lat,lng>"** plus a ⚠️ warning
if they land on null-island or span a huge area.
