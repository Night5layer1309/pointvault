import fs from "fs";
import Papa from "papaparse";
import proj4 from "proj4";

const inputPath = "data/MASTER_POINTS_NW_FLORIDA.txt";
const outputPath = "data/pointvault-import.csv";
const rejectedPath = "data/pointvault-rejected-rows.json";

// NAD83 / Florida North (ftUS), EPSG:2238.
// We still need to verify this with known field points.
proj4.defs(
  "EPSG:2238",
  "+proj=lcc +lat_0=29 +lon_0=-84.5 +lat_1=30.75 +lat_2=29.5833333333333 +x_0=600000.0000000001 +y_0=0 +datum=NAD83 +units=us-ft +no_defs +type=crs"
);

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8");
const lineCount = raw.split(/\r\n|\n|\r/).length;

console.log(`Reading: ${inputPath}`);
console.log(`Raw file size: ${raw.length.toLocaleString()} characters`);
console.log(`Approx line count: ${lineCount.toLocaleString()}`);
console.log("First 200 characters:");
console.log(raw.slice(0, 200));

const parsed = Papa.parse(raw, {
  header: true,
  skipEmptyLines: true,
  transformHeader: (header) => header.trim(),
});

console.log(`Papa parsed rows: ${parsed.data.length.toLocaleString()}`);

if (parsed.errors.length) {
  console.log("CSV parse errors, first 10:");
  console.log(parsed.errors.slice(0, 10));
}

const converted = [];
const rejected = [];

for (const [index, row] of parsed.data.entries()) {
  const pointId = String(row.Point || "").trim();
  const northing = Number(row.Northing);
  const easting = Number(row.Easting);
  const description = String(row.Description || "").trim();
  const sourceFile = String(row.File || "").trim();

  if (!pointId || !Number.isFinite(northing) || !Number.isFinite(easting)) {
    rejected.push({
      rowNumber: index + 2,
      reason: "Missing point id, northing, or easting",
      row,
    });
    continue;
  }

  const [longitude, latitude] = proj4("EPSG:2238", "EPSG:4326", [
    easting,
    northing,
  ]);

  converted.push({
    point_id: pointId,
    name: `${pointId} - ${description || "Point"}`,
    status: "found",
    reliability: "C",
    latitude: latitude.toFixed(8),
    longitude: longitude.toFixed(8),
    northing: northing.toFixed(3),
    easting: easting.toFixed(3),
    coordinate_system: "NAD83 / Florida North (ftUS) - EPSG:2238",
    job: sourceFile.replace(/\.txt$/i, ""),
    county: "",
    crew: "",
    last_found: "",
    description,
    source_file: sourceFile,
  });
}

const csv = Papa.unparse(converted);

fs.writeFileSync(outputPath, csv);
fs.writeFileSync(rejectedPath, JSON.stringify(rejected.slice(0, 500), null, 2));

console.log("");
console.log(`Converted points: ${converted.length.toLocaleString()}`);
console.log(`Rejected rows: ${rejected.length.toLocaleString()}`);
console.log(`Wrote: ${outputPath}`);
console.log(`Wrote rejected sample: ${rejectedPath}`);

if (converted.length) {
  console.log("");
  console.log("First converted row:");
  console.log(converted[0]);
}

if (converted.length <= 1) {
  console.log("");
  console.log("WARNING: Only 1 or fewer points converted.");
  console.log("Check that data/MASTER_POINTS_NW_FLORIDA.txt is the full master file and not a partial copy.");
}