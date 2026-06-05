// Honest, lightweight coordinate-system hints for the importer.
//
// We deliberately do NOT try to guess the projected State Plane zone from raw
// northing/easting — that's mathematically ambiguous (the same numbers are
// valid coordinates in several zones/states, so it confidently mislocates).
// What we CAN do reliably:
//   1. Lat/long: decimal degrees are unmistakable (range check).
//   2. Filename hint: when a file/folder is named with a state + zone direction
//      (e.g. "Florida West ..."), suggest that zone. Fires only on a clear
//      match — otherwise we fall back to the user's current/remembered zone and
//      let them set it per file.
import { COORDINATE_SYSTEMS, COORDINATE_SYSTEM_BY_EPSG } from "@/lib/coordinateSystems";

function num(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[^0-9.+\-eE]/g, "");
  if (
    cleaned === "" || cleaned === "+" || cleaned === "-" || cleaned === "." ||
    (cleaned.match(/\./g) || []).length > 1
  ) {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Pull up to `limit` numeric coordinate pairs from preview rows (arrays),
// using a field->columnIndex map.
function samplePairs(rows, columns, limit = 40) {
  const out = [];
  for (const row of rows) {
    const northing = num(columns.northing != null ? row[columns.northing] : undefined);
    const easting = num(columns.easting != null ? row[columns.easting] : undefined);
    const latitude = num(columns.latitude != null ? row[columns.latitude] : undefined);
    const longitude = num(columns.longitude != null ? row[columns.longitude] : undefined);
    if (northing == null && easting == null && latitude == null && longitude == null) continue;
    out.push({ northing, easting, latitude, longitude });
    if (out.length >= limit) break;
  }
  return out;
}

export function looksLikeLatLong(rows, columns) {
  const pairs = samplePairs(rows, columns);
  let usable = 0;
  let degreeLike = 0;
  for (const p of pairs) {
    const lat = p.latitude != null ? p.latitude : p.northing;
    const lng = p.longitude != null ? p.longitude : p.easting;
    if (lat == null || lng == null) continue;
    usable += 1;
    // In-range AND not tiny (a State Plane coordinate is in the 100,000s+).
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (Math.abs(lat) > 1 || Math.abs(lng) > 1)) {
      degreeLike += 1;
    }
  }
  return usable > 0 && degreeLike / usable >= 0.9;
}

// Build a filename-hint index once: normalized "<state> <direction>" phrase ->
// preferred system (ftUS first, then ft, then meters). Skips UTM/compound.
const DIRECTION = /\b(north|south|east|west|central|old)\b/;
function normalizePhrase(name) {
  return name
    .replace(/^NAD8[37]\s*\/\s*/, "")
    .replace(/\s*\((ftus|ft|m)\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

const HINT_INDEX = (() => {
  const byPhrase = new Map();
  const unitRank = (name) => (/\(ftus\)/i.test(name) ? 0 : /\(ft\)/i.test(name) ? 1 : 2);
  for (const s of COORDINATE_SYSTEMS) {
    if (s.group !== "nad83" && s.group !== "nad27") continue; // skip UTM/latlon
    if (/utm/i.test(s.name) || /height/i.test(s.name)) continue;
    const phrase = normalizePhrase(s.name);
    if (!phrase || phrase.length < 4) continue;
    const existing = byPhrase.get(phrase);
    if (!existing || unitRank(s.name) < unitRank(existing.name)) {
      byPhrase.set(phrase, s);
    }
  }
  // Longest phrases first so "north carolina" wins over a bare state match.
  return [...byPhrase.entries()].sort((a, b) => b[0].length - a[0].length);
})();

export function filenameZoneHint(filename, { preferMeters = false } = {}) {
  if (!filename) return null;
  const hay = String(filename).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const wantsMeters = preferMeters || /\b(meter|metre|meters|metres)\b/.test(hay);
  for (const [phrase, sys] of HINT_INDEX) {
    // Multi-word zone phrases must contain a direction to avoid weak matches.
    if (!hay.includes(phrase)) continue;
    if (DIRECTION.test(phrase) || phrase.split(" ").length >= 2) {
      // honor a meters hint by swapping to the same-named meters variant
      if (wantsMeters) {
        const m = COORDINATE_SYSTEMS.find(
          (c) => normalizePhrase(c.name) === phrase && /\(m\)$/.test(c.name),
        );
        if (m) return { epsg: m.epsg, name: m.name };
      }
      return { epsg: sys.epsg, name: sys.name };
    }
  }
  return null;
}

// One call the UI uses per file. Returns the suggested zone + why.
// reason: 'latlong' | 'filename' | 'default'
export function suggestZoneForFile({ rows, columns, filename, fallbackEpsg }) {
  if (rows && rows.length && looksLikeLatLong(rows, columns)) {
    const sys = COORDINATE_SYSTEM_BY_EPSG.get("4326");
    return { epsg: 4326, name: sys ? sys.name : "WGS 84", reason: "latlong" };
  }
  const hint = filenameZoneHint(filename);
  if (hint) return { epsg: hint.epsg, name: hint.name, reason: "filename" };

  const fb = COORDINATE_SYSTEM_BY_EPSG.get(String(fallbackEpsg));
  return { epsg: fallbackEpsg, name: fb ? fb.name : `EPSG ${fallbackEpsg}`, reason: "default" };
}
