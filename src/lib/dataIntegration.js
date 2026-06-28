import Papa from "papaparse";
import { supabase } from "@/lib/supabaseClient";

const STAGING_BATCH_SIZE = 250;
const PROCESS_CHUNK_SIZE = 1000;
const PROMOTE_CHUNK_SIZE = 1000;
const MAX_PROCESS_CHUNKS_PER_RUN = 5;
const MAX_PROMOTE_CHUNKS_PER_RUN = 5;
const DUPLICATE_TOLERANCE_FT = 1.0;
const ACCEPTED_IMPORT_EXTENSIONS = [".csv", ".txt"];
const IMPORT_BUCKET = "pointvault-imports";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutLikeError(error) {
  const message = String(error?.message || error?.details || error || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("canceling statement") ||
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("connection")
  );
}

async function withRetry(operation, { retries = 3, delayMs = 1000 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await operation();

    if (!result?.error) return result;

    lastError = result.error;

    if (!isTimeoutLikeError(lastError) || attempt === retries) return result;

    await sleep(delayMs * (attempt + 1));
  }

  return { data: null, error: lastError };
}

export function isImportablePointFile(file) {
  const name = String(file?.name || "").toLowerCase();
  return ACCEPTED_IMPORT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function normalizeImportFileList(fileList) {
  return Array.from(fileList || [])
    .filter(isImportablePointFile)
    .map((file) => ({
      file,
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function valueLooksNumeric(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return Number.isFinite(Number(text.replace(/[^0-9.-]+/g, "")));
}

function rowLooksLikePointNorthingEastingElevationDescription(row) {
  return (
    row.length >= 5 &&
    valueLooksNumeric(row[0]) &&
    valueLooksNumeric(row[1]) &&
    valueLooksNumeric(row[2]) &&
    valueLooksNumeric(row[3])
  );
}

function rowLooksLikePointNorthingEastingDescriptionFile(row) {
  return (
    row.length >= 5 &&
    valueLooksNumeric(row[0]) &&
    valueLooksNumeric(row[1]) &&
    valueLooksNumeric(row[2]) &&
    !valueLooksNumeric(row[3])
  );
}

export function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      dynamicTyping: false,
      worker: false,
      transform: (value) => String(value ?? "").trim(),
      complete: (results) => {
        const rawRows = results.data || [];

        if (rawRows.length === 0) {
          resolve({ data: [], meta: { fields: [], detectedFormat: "empty" } });
          return;
        }

        const firstRow = rawRows[0] || [];
        const firstCell = String(firstRow[0] ?? "").trim().toLowerCase();

        const looksLikeHeader =
          firstCell.includes("point") ||
          firstCell.includes("pt") ||
          firstCell.includes("number") ||
          firstCell.includes("id");

        if (looksLikeHeader) {
          const fields = firstRow.map((field) => String(field ?? "").trim());
          const data = rawRows.slice(1).map((row) => {
            const obj = {};
            fields.forEach((field, index) => {
              obj[field] = row[index] ?? "";
            });
            return obj;
          });
          resolve({ data, meta: { fields, detectedFormat: "header_csv" } });
          return;
        }

        if (rowLooksLikePointNorthingEastingDescriptionFile(firstRow)) {
          const fields = ["point", "northing", "easting", "description", "source_file"];
          const data = rawRows.map((row) => ({
            point: row[0] ?? "",
            northing: row[1] ?? "",
            easting: row[2] ?? "",
            description: row[3] ?? "",
            source_file: row.slice(4).join(" ").trim(),
          }));
          resolve({ data, meta: { fields, detectedFormat: "point_northing_easting_description_file" } });
          return;
        }

        if (rowLooksLikePointNorthingEastingElevationDescription(firstRow)) {
          const fields = ["point", "northing", "easting", "elevation", "description"];
          const data = rawRows.map((row) => ({
            point: row[0] ?? "",
            northing: row[1] ?? "",
            easting: row[2] ?? "",
            elevation: row[3] ?? "",
            description: row.slice(4).join(" ").trim(),
          }));
          resolve({ data, meta: { fields, detectedFormat: "point_northing_easting_elevation_description" } });
          return;
        }

        const maxColumns = Math.max(...rawRows.map((row) => row.length));
        const fields = Array.from({ length: maxColumns }, (_, index) => `column_${index + 1}`);
        const data = rawRows.map((row) => {
          const obj = {};
          fields.forEach((field, index) => {
            obj[field] = row[index] ?? "";
          });
          return obj;
        });

        resolve({ data, meta: { fields, detectedFormat: "unknown_no_header" } });
      },
      error: (error) => reject(error),
    });
  });
}

// Read just the first few rows as raw arrays (no header assumptions) so the UI
// can show a preview and let the user label columns.
export function previewCsvFile(file, maxRows = 6) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      dynamicTyping: false,
      worker: false,
      preview: maxRows,
      transform: (value) => String(value ?? "").trim(),
      complete: (results) => {
        const rows = (results.data || []).filter(
          (row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim() !== ""),
        );
        resolve({ rows });
      },
      error: (error) => reject(error),
    });
  });
}

// Best-effort starting mapping of field -> column index, used to pre-fill the
// column labeller. The user can override anything before uploading.
export function guessColumnMapping(rows = []) {
  if (!rows.length) return { has_header: false, columns: {} };

  const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const first = rows[0].map((cell) => String(cell ?? "").trim());
  const headerTokens = [
    "point", "pointid", "pt", "ptid", "pnt", "number", "name", "id",
    "northing", "north", "n", "y", "easting", "east", "e", "x",
    "latitude", "lat", "longitude", "long", "lng", "lon",
    "elevation", "elev", "z", "height", "description", "desc", "descript", "note", "notes", "code",
  ];
  const hasHeader = first.some((cell) => headerTokens.includes(norm(cell)));
  const columns = {};

  if (hasHeader) {
    const findIdx = (...candidates) => first.findIndex((cell) => candidates.includes(norm(cell)));
    const assign = (field, ...candidates) => {
      const index = findIdx(...candidates);
      if (index >= 0) columns[field] = index;
    };
    assign("point", "point", "pointid", "pt", "ptid", "pnt", "number", "name", "id");
    assign("northing", "northing", "north", "n", "y");
    assign("easting", "easting", "east", "e", "x");
    assign("latitude", "latitude", "lat");
    assign("longitude", "longitude", "long", "lng", "lon");
    assign("elevation", "elevation", "elev", "z", "height");
    assign("description", "description", "desc", "descript", "note", "notes", "code", "descr");
  } else {
    const numeric = (value) => Number.isFinite(Number(String(value ?? "").replace(/[^0-9.eE+-]+/g, "")));
    const sample = rows[0];
    columns.point = 0;
    columns.northing = 1;
    columns.easting = 2;
    if (sample.length >= 5 && numeric(sample[3])) {
      columns.elevation = 3;
      columns.description = 4;
    } else if (sample.length >= 4) {
      columns.description = 3;
    }
  }

  return { has_header: hasHeader, columns };
}

export function detectColumns(fields = []) {
  const normalized = fields.map((field) => ({
    original: field,
    key: String(field).trim().toLowerCase().replace(/[^a-z0-9]+/g, ""),
  }));

  const find = (...candidates) => {
    const hit = normalized.find((field) => candidates.includes(field.key));
    return hit?.original || "";
  };

  return {
    pointId: find("point", "pointid", "pt", "ptid", "pnt", "number", "name", "id"),
    description: find("description", "desc", "descript", "note", "notes", "code2", "descr"),
    code: find("code", "fieldcode", "pointcode", "pc", "feature", "symbol"),
    northing: find("northing", "north", "n", "y"),
    easting: find("easting", "east", "e", "x"),
    elevation: find("elevation", "elev", "z", "height"),
    latitude: find("latitude", "lat"),
    longitude: find("longitude", "long", "lng", "lon"),
  };
}

export function getValue(row, columnName) {
  if (!columnName) return "";
  const value = row?.[columnName];
  return value === null || value === undefined ? "" : String(value);
}

export function analyzeNorthingEasting(rows = [], columns = {}) {
  let totalRows = rows.length;
  let validRows = 0;
  let missingNorthing = 0;
  let missingEasting = 0;
  let invalidNorthing = 0;
  let invalidEasting = 0;

  for (const row of rows) {
    const northingRaw = getValue(row, columns.northing);
    const eastingRaw = getValue(row, columns.easting);

    if (!northingRaw) {
      missingNorthing += 1;
      continue;
    }

    if (!eastingRaw) {
      missingEasting += 1;
      continue;
    }

    const northing = Number(String(northingRaw).replace(/[^0-9.-]+/g, ""));
    const easting = Number(String(eastingRaw).replace(/[^0-9.-]+/g, ""));

    if (!Number.isFinite(northing)) {
      invalidNorthing += 1;
      continue;
    }

    if (!Number.isFinite(easting)) {
      invalidEasting += 1;
      continue;
    }

    validRows += 1;
  }

  return {
    totalRows,
    validRows,
    missingNorthing,
    missingEasting,
    invalidNorthing,
    invalidEasting,
    hasUsableNorthingEasting: validRows > 0,
  };
}

// -----------------------------------------------------------------------------
// Storage-based imports: huge-file path
// -----------------------------------------------------------------------------

export async function createStorageImportJob({
  companyId,
  fileName,
  declaredEpsg,
  declaredCoordinateSystem,
  defaultVisibility,
  columnMapping,
  skipMarkerFilter,
}) {
  return supabase.rpc("create_storage_import_job", {
    target_company_id: companyId,
    source_file_name: fileName,
    declared_epsg: declaredEpsg ? Number(declaredEpsg) : null,
    declared_coordinate_system: declaredCoordinateSystem || null,
    default_visibility: defaultVisibility || "company",
    column_mapping_json: columnMapping || null,
    skip_marker_filter_in: Boolean(skipMarkerFilter),
  });
}

export async function uploadRawImportFile({ file, bucket = IMPORT_BUCKET, rawPath, onProgress }) {
  onProgress?.({ stage: "uploading", loaded: 0, total: file.size || 0, percent: 0 });

  const result = await supabase.storage.from(bucket).upload(rawPath, file, {
    cacheControl: "3600",
    upsert: true,
    contentType: file.type || "text/plain",
  });

  if (!result.error) {
    onProgress?.({ stage: "uploaded", loaded: file.size || 0, total: file.size || 0, percent: 100 });
  }

  return result;
}

export async function markStorageImportUploaded({ importJobId, fileSizeBytes }) {
  return supabase.rpc("mark_storage_import_uploaded", {
    target_import_job_id: importJobId,
    raw_file_size_bytes: fileSizeBytes || null,
  });
}

export async function createAndUploadStorageImport({
  companyId,
  file,
  declaredEpsg,
  declaredCoordinateSystem,
  defaultVisibility,
  columnMapping,
  skipMarkerFilter,
  onProgress,
}) {
  const { data: jobData, error: jobError } = await createStorageImportJob({
    companyId,
    fileName: file.name,
    declaredEpsg,
    declaredCoordinateSystem,
    defaultVisibility,
    columnMapping,
    skipMarkerFilter,
  });

  if (jobError) return { data: null, error: jobError };

  const uploadResult = await uploadRawImportFile({
    file,
    bucket: jobData.bucket,
    rawPath: jobData.raw_path,
    onProgress,
  });

  if (uploadResult.error) return { data: jobData, error: uploadResult.error };

  const markResult = await markStorageImportUploaded({
    importJobId: jobData.import_job_id,
    fileSizeBytes: file.size,
  });

  if (markResult.error) return { data: jobData, error: markResult.error };

  return {
    data: {
      ...jobData,
      uploaded: true,
      python_worker_status: "queued",
    },
    error: null,
  };
}

export async function getStorageImportDownloadUrl(path, bucket = IMPORT_BUCKET, expiresIn = 3600) {
  return supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
}

// Re-run the worker on a file already in storage (no re-upload). With
// skipMarkerFilter true it imports every located row (accepted + review).
export async function requeueStorageImportJob(importJobId, skipMarkerFilter = true) {
  return supabase.rpc("requeue_storage_import_job", {
    target_import_job_id: importJobId,
    skip_marker_filter_in: Boolean(skipMarkerFilter),
  });
}

// Fetch + parse one of a job's processed CSVs (e.g. review_points.csv) into row
// objects keyed by header (point, northing, easting, elevation, latitude,
// longitude, description, source_file).
export async function fetchStorageCsvRows(path, bucket = IMPORT_BUCKET) {
  const { data, error } = await getStorageImportDownloadUrl(path, bucket);
  if (error) return { rows: [], error };

  try {
    const response = await fetch(data.signedUrl);
    if (!response.ok) {
      return { rows: [], error: { message: `Could not download file (${response.status}).` } };
    }
    const text = await response.text();
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => String(header ?? "").trim().toLowerCase(),
      transform: (value) => String(value ?? "").trim(),
    });
    const rows = (parsed.data || []).filter((row) =>
      row && Object.values(row).some((cell) => String(cell ?? "").trim() !== ""),
    );
    return { rows, error: null };
  } catch (fetchError) {
    return { rows: [], error: { message: fetchError?.message || "Could not read file." } };
  }
}

// Promote a user-selected set of rows (approved review rows) into company_points.
export async function promoteImportRows(importJobId, rows) {
  return supabase.rpc("promote_storage_import_rows", {
    target_import_job_id: importJobId,
    points_json: rows,
  });
}

export async function listImportStorageFiles(prefix, bucket = IMPORT_BUCKET) {
  return supabase.storage.from(bucket).list(prefix, {
    limit: 100,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  });
}

// -----------------------------------------------------------------------------
// Database-staging imports: smaller-file path retained
// -----------------------------------------------------------------------------

export async function createImportJob({
  companyId,
  fileName,
  declaredEpsg,
  declaredCoordinateSystem,
  defaultVisibility,
}) {
  return supabase.rpc("create_import_job", {
    target_company_id: companyId,
    source_file_name: fileName,
    declared_epsg: declaredEpsg ? Number(declaredEpsg) : null,
    declared_coordinate_system: declaredCoordinateSystem || null,
    default_visibility: defaultVisibility || "company",
  });
}

export async function stageImportRows({ importJobId, companyId, rows, columns, onProgress }) {
  let inserted = 0;

  for (let index = 0; index < rows.length; index += STAGING_BATCH_SIZE) {
    const batch = rows.slice(index, index + STAGING_BATCH_SIZE).map((row, batchIndex) => ({
      import_job_id: importJobId,
      company_id: companyId,
      source_row_number: index + batchIndex + 1,
      raw_point_id: getValue(row, columns.pointId),
      raw_description: getValue(row, columns.description),
      raw_code: getValue(row, columns.code),
      raw_northing: getValue(row, columns.northing),
      raw_easting: getValue(row, columns.easting),
      raw_elevation: getValue(row, columns.elevation),
      raw_latitude: getValue(row, columns.latitude),
      raw_longitude: getValue(row, columns.longitude),
      raw_json: row,
    }));

    const result = await withRetry(() => supabase.from("import_point_staging").insert(batch), {
      retries: 3,
      delayMs: 1000,
    });

    if (result.error) return { inserted, error: result.error };

    inserted += batch.length;
    onProgress?.({ inserted, total: rows.length });
    await sleep(25);
  }

  return { inserted, error: null };
}

export async function processImportJobChunk(importJobId, chunkSize = PROCESS_CHUNK_SIZE) {
  return supabase.rpc("process_import_job_chunk", {
    target_import_job_id: importJobId,
    chunk_size: chunkSize,
    duplicate_tolerance_ft: DUPLICATE_TOLERANCE_FT,
  });
}

export async function finalizeImportJobProcessing(importJobId) {
  return supabase.rpc("finalize_import_job_processing", {
    target_import_job_id: importJobId,
    duplicate_tolerance_ft: DUPLICATE_TOLERANCE_FT,
  });
}

export async function processImportJob(importJobId, onProgress, options = {}) {
  const maxChunks = Number(options.maxChunks || MAX_PROCESS_CHUNKS_PER_RUN);
  const finalizeWhenDone = options.finalizeWhenDone !== false;
  let lastResult = null;
  let chunks = 0;

  while (chunks < maxChunks) {
    const { data, error } = await withRetry(
      () => processImportJobChunk(importJobId, PROCESS_CHUNK_SIZE),
      { retries: 2, delayMs: 1500 },
    );

    if (error) return { data: lastResult, error };

    chunks += 1;
    lastResult = data || {};

    onProgress?.({
      chunks,
      processedThisChunk: Number(lastResult.processed_this_chunk || 0),
      remainingRawRows: Number(lastResult.remaining_raw_rows || 0),
      done: Boolean(lastResult.done),
      readyToFinalize: Boolean(lastResult.ready_to_finalize),
      status: lastResult.status || "processing",
    });

    if (Boolean(lastResult.done)) {
      if (!finalizeWhenDone) {
        return { data: { ...lastResult, needsMoreProcessing: false, needsFinalize: true }, error: null };
      }

      const finalized = await withRetry(() => finalizeImportJobProcessing(importJobId), {
        retries: 2,
        delayMs: 1500,
      });

      if (finalized.error) return { data: lastResult, error: finalized.error };

      return {
        data: {
          ...(finalized.data || {}),
          done: true,
          needsMoreProcessing: false,
          needsFinalize: false,
        },
        error: null,
      };
    }

    if (Number(lastResult.processed_this_chunk || 0) === 0) {
      return {
        data: lastResult,
        error: { message: "Chunk processing stopped because no rows were processed." },
      };
    }

    await sleep(200);
  }

  return {
    data: {
      ...(lastResult || {}),
      done: false,
      needsMoreProcessing: true,
      needsFinalize: false,
      message: "Processing paused to avoid timeout. Click Process/Resume again.",
    },
    error: null,
  };
}

export async function promoteImportJobChunk(importJobId, chunkSize = PROMOTE_CHUNK_SIZE) {
  return supabase.rpc("promote_import_job_chunk", {
    target_import_job_id: importJobId,
    chunk_size: chunkSize,
    duplicate_tolerance_ft: DUPLICATE_TOLERANCE_FT,
  });
}

export async function promoteImportJob(importJobId, onProgress, options = {}) {
  const maxChunks = Number(options.maxChunks || MAX_PROMOTE_CHUNKS_PER_RUN);
  let lastResult = null;
  let chunks = 0;
  let totalPromotedThisRun = 0;
  let totalSkippedThisRun = 0;

  while (chunks < maxChunks) {
    const { data, error } = await withRetry(
      () => promoteImportJobChunk(importJobId, PROMOTE_CHUNK_SIZE),
      { retries: 2, delayMs: 1500 },
    );

    if (error) return { data: lastResult, error };

    chunks += 1;
    lastResult = data || {};
    totalPromotedThisRun += Number(lastResult.promoted_this_chunk || 0);
    totalSkippedThisRun += Number(lastResult.skipped_duplicate_rows || 0);

    onProgress?.({
      chunks,
      promotedThisChunk: Number(lastResult.promoted_this_chunk || 0),
      totalPromotedThisRun,
      skippedDuplicateRows: totalSkippedThisRun,
      remainingAcceptedRows: Number(lastResult.remaining_accepted_rows || 0),
      done: Boolean(lastResult.done),
      status: lastResult.status || "processing",
    });

    if (Boolean(lastResult.done)) {
      return {
        data: { ...lastResult, done: true, needsMorePromotion: false, totalPromotedThisRun, totalSkippedThisRun },
        error: null,
      };
    }

    await sleep(200);
  }

  return {
    data: {
      ...(lastResult || {}),
      done: false,
      needsMorePromotion: true,
      totalPromotedThisRun,
      totalSkippedThisRun,
      message: "Promotion paused to avoid timeout. Click Promote Accepted again to continue.",
    },
    error: null,
  };
}

export async function shareImportJobToCommunity(importJobId) {
  return supabase.rpc("share_import_job_to_community", { target_import_job_id: importJobId });
}

export async function getImportJob(importJobId) {
  return supabase.from("import_jobs").select("*").eq("id", importJobId).single();
}

export async function getRecentImportJobs(companyId, limit = 10) {
  return supabase
    .from("import_jobs")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
}

export async function getImportStatusCounts(importJobId) {
  const { data, error } = await supabase
    .from("import_point_staging")
    .select("processing_status")
    .eq("import_job_id", importJobId);

  if (error) return { data: null, error };

  const counts = (data || []).reduce((acc, row) => {
    const key = row.processing_status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return { data: counts, error: null };
}

export async function getReviewGroups(importJobId) {
  const { data, error } = await supabase
    .from("import_review_groups")
    .select("*")
    .eq("import_job_id", importJobId)
    .order("row_count", { ascending: false });

  if (error) return { data: [], error };

  const groups = (data || []).map((row) => ({
    id: row.id,
    signature: row.review_signature || "unknown",
    count: Number(row.row_count || 0),
    status: row.current_status || "needs_review",
    markerType: row.suggested_marker_type || "unknown",
    reason: row.reason || "Needs review",
    samples: Array.isArray(row.sample_rows)
      ? row.sample_rows.map((sample) => ({ code: sample.point || "", description: sample.description || "" }))
      : [],
  }));

  return { data: groups, error: null };
}

export async function decideReviewGroup({ reviewGroupId, decision, markerType, saveAsCompanyAlias = true }) {
  return supabase.rpc("decide_import_review_group", {
    target_review_group_id: reviewGroupId,
    decision,
    normalized_marker_type: markerType || null,
    save_as_company_alias: saveAsCompanyAlias,
  });
}

export async function deleteCompanyPoint(pointId) {
  return supabase.rpc("delete_company_point", { target_company_point_id: pointId });
}

// Bulk delete — used by the box-select-on-map flow. Returns { deleted, failed }.
// Per-row work goes through delete_company_point so observation cleanup happens.
export async function deleteCompanyPointsBulk(pointIds) {
  const ids = Array.isArray(pointIds) ? pointIds.filter(Boolean) : [];
  if (ids.length === 0) return { data: { deleted: 0, failed: 0 }, error: null };
  return supabase.rpc("delete_company_points_bulk", { target_point_ids: ids });
}

export async function cleanupCompanyDuplicatePoints(companyId, duplicateToleranceFt = 1.0) {
  return supabase.rpc("cleanup_company_duplicate_points", {
    target_company_id: companyId,
    duplicate_tolerance_ft: duplicateToleranceFt,
  });
}

export async function processOneImportFile({
  fileItem,
  companyId,
  declaredEpsg,
  declaredCoordinateSystem,
  defaultVisibility,
  onStageProgress,
  onProcessProgress,
}) {
  const parsed = await parseCsvFile(fileItem.file);
  const rows = parsed.data || [];
  const fields = parsed.meta?.fields || Object.keys(rows[0] || {});
  const columns = detectColumns(fields);
  const coordinateCheck = analyzeNorthingEasting(rows, columns);

  if (!coordinateCheck.hasUsableNorthingEasting) {
    return {
      fileItem,
      importJobId: null,
      rows: rows.length,
      status: "failed",
      coordinateCheck,
      error: { message: "No usable northing/easting columns were detected." },
    };
  }

  const { data: importJobId, error: jobError } = await createImportJob({
    companyId,
    fileName: fileItem.relativePath,
    declaredEpsg,
    declaredCoordinateSystem,
    defaultVisibility,
  });

  if (jobError) return { fileItem, importJobId: null, rows: rows.length, status: "failed", coordinateCheck, error: jobError };

  const staged = await stageImportRows({ importJobId, companyId, rows, columns, onProgress: onStageProgress });

  if (staged.error) return { fileItem, importJobId, rows: rows.length, status: "failed", coordinateCheck, error: staged.error };

  const { data: processResult, error: processError } = await processImportJob(importJobId, onProcessProgress);

  if (processError) return { fileItem, importJobId, rows: rows.length, status: "failed", coordinateCheck, error: processError };

  return {
    fileItem,
    importJobId,
    rows: rows.length,
    status: processResult?.done ? "processed" : "processing_paused",
    result: processResult,
    coordinateCheck,
    error: null,
  };
}

export async function fetchNearbyVisiblePoints({ companyId, location, radiusFeet, resultLimit, scope = "all" }) {
  return supabase.rpc("nearby_visible_points", {
    target_company_id: companyId,
    user_lat: location.lat,
    user_lng: location.lng,
    radius_feet: radiusFeet,
    result_limit: resultLimit,
    requested_scope: scope,
  });
}

// Data Health: per-import-job audit. Returns one row per import job with
// point count, centroid, span in miles, and an is_suspicious flag for jobs
// whose points are spread > 50 miles apart (almost always an EPSG mistake).
export async function auditCompanyImportJobs(companyId) {
  if (!companyId) return { data: [], error: { message: "No company selected." } };
  const { data, error } = await supabase.rpc("audit_company_import_jobs", {
    target_company_id: companyId,
  });
  if (error) return { data: [], error };
  return { data: data || [], error: null };
}

// Wipes every company_point belonging to an import job. Used to clean up the
// fallout from a wrong-EPSG import without touching other imports.
export async function deleteStorageImportJobPoints(importJobId) {
  if (!importJobId) throw new Error("Missing import job ID.");
  const { data, error } = await supabase.rpc("delete_storage_import_job_points", {
    target_import_job_id: importJobId,
  });
  if (error) throw error;
  return data || { deleted: 0 };
}

// Calls the geocode-address edge function, which tries Nominatim first and
// falls back to the US Census Geocoder. The function runs server-side so the
// Census API's missing CORS headers don't block the browser. Returns
// { lat, lng, displayName, source } on success, or null when both miss.
export async function geocodeAddress(address, bias) {
  if (!address || !String(address).trim()) return null;
  const body = { address: String(address).trim() };
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    body.bias = { lat: Number(bias.lat), lng: Number(bias.lng) };
  }
  const { data, error } = await supabase.functions.invoke("geocode-address", { body });
  if (error) throw error;
  return data?.match || null;
}
