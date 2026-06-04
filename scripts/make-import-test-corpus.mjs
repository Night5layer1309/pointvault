// Generates an adversarial import test corpus: one small file per failure mode
// the 2026-06-03 import-robustness fixes address. Upload each against the live
// worker after deploy and confirm the "Expected after fix" column in README.md.
//
// Run: node scripts/make-import-test-corpus.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'PointVault - import-tests')
fs.mkdirSync(outDir, { recursive: true })

const write = (name, text) => {
  fs.writeFileSync(path.join(outDir, name), text, 'utf8')
  return name
}

// --- Happy path (baseline): standard FL North header CSV with monument codes.
write(
  '00_happy_florida_markers.csv',
  [
    'point,northing,easting,elevation,description',
    '1,620100.50,1645200.10,42.1,IR',
    '2,620150.25,1645260.80,42.4,CIR',
    '3,620205.00,1645320.00,43.0,REBAR',
    '4,620260.75,1645390.40,43.2,CONC MON',
    '5,620320.00,1645450.00,43.5,NID',
  ].join('\n') + '\n',
)

// --- R3: decimal latitude/longitude. Was IMPOSSIBLE on the worker path.
write(
  'R3_latlong_markers.csv',
  [
    'point,latitude,longitude,description',
    '1,30.43810,-84.28090,IR',
    '2,30.43855,-84.28010,CIR',
    '3,30.43900,-84.27950,REBAR',
    '4,30.43960,-84.27880,MAG NAIL',
  ].join('\n') + '\n',
)

// --- R2: deliberately bogus EPSG. Upload with EPSG set to 99999.
write(
  'R2_bad_epsg.csv',
  [
    'point,northing,easting,description',
    '1,620100.50,1645200.10,IR',
    '2,620150.25,1645260.80,CIR',
  ].join('\n') + '\n',
)

// --- U1: coordinate-only, NO description column. Was 0 imported (all review).
write(
  'U1_coords_only.csv',
  [
    '1,620100.50,1645200.10',
    '2,620150.25,1645260.80',
    '3,620205.00,1645320.00',
    '4,620260.75,1645390.40',
  ].join('\n') + '\n',
)

// --- U3: semicolon-delimited (European / total-station export).
write(
  'U3_semicolon.csv',
  [
    'point;northing;easting;description',
    '1;620100.50;1645200.10;IR',
    '2;620150.25;1645260.80;CIR',
    '3;620205.00;1645320.00;REBAR',
  ].join('\n') + '\n',
)

// --- U3: tab-delimited (literal tabs).
write(
  'U3_tab.txt',
  [
    ['point', 'northing', 'easting', 'description'].join('\t'),
    ['1', '620100.50', '1645200.10', 'IR'].join('\t'),
    ['2', '620150.25', '1645260.80', 'CIR'].join('\t'),
  ].join('\n') + '\n',
)

// --- U4: unit suffixes + quoted thousands separators.
write(
  'U4_units_and_thousands.csv',
  [
    'point,northing,easting,description',
    '1,"620,100.50ft","1,645,200.10ft",IR',
    '2,"620,150.25 ft","1,645,260.80 ft",CIR',
  ].join('\n') + '\n',
)

// --- U5: non-standard header names (Name / Y / X / Z / Desc).
write(
  'U5_xy_header.csv',
  [
    'Name,Y,X,Z,Desc',
    'P1,620100.50,1645200.10,42.1,IR',
    'P2,620150.25,1645260.80,42.4,CIR',
    'P3,620205.00,1645320.00,43.0,REBAR',
  ].join('\n') + '\n',
)

write(
  'README.md',
  `# Import robustness — verification corpus

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
`,
)

console.log('Wrote import test corpus to:', outDir)
for (const f of fs.readdirSync(outDir)) console.log('  ', f)
