/*
PointVault DataImportPanel
Version: 0.6.0
Last updated: 2026-05-15
Purpose:
- Storage-based raw file upload for large imports
- Queues Python worker processing
- Shows worker/import job status
- Provides download links for Python output files
- Removes old browser row-staging path from the main upload flow
*/

import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cloud,
  Database,
  Download,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  createAndUploadStorageImport,
  fetchStorageCsvRows,
  getImportJob,
  getRecentImportJobs,
  getStorageImportDownloadUrl,
  guessColumnMapping,
  normalizeImportFileList,
  previewCsvFile,
  promoteImportRows,
  requeueStorageImportJob,
} from "@/lib/dataIntegration";

// Fields a column can be labelled as. point/northing/easting are required for
// the mapping to be used; the rest are optional.
const MAPPING_FIELDS = [
  { key: "point", label: "Point ID" },
  { key: "northing", label: "Northing" },
  { key: "easting", label: "Easting" },
  { key: "elevation", label: "Elevation" },
  { key: "description", label: "Description" },
];
const REQUIRED_MAPPING_FIELDS = ["point", "northing", "easting"];

function Message({ kind = "info", children }) {
  if (!children) return null;

  const styles =
    kind === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : kind === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-blue-200 bg-blue-50 text-blue-800";

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${styles}`}>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-slate-700">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      className={`rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400 ${
        props.className || ""
      }`}
    />
  );
}

function SelectInput(props) {
  return (
    <select
      {...props}
      className={`rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400 ${
        props.className || ""
      }`}
    />
  );
}

function StatCard({ label, value, note }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-black text-slate-950">
        {Number(value || 0).toLocaleString()}
      </div>
      {note && <div className="mt-1 text-xs font-semibold text-slate-500">{note}</div>}
    </div>
  );
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(value) {
  if (!value) return "Not set";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function statusClasses(status) {
  const value = String(status || "").toLowerCase();

  if (["processed", "promoted"].includes(value)) {
    return "bg-emerald-100 text-emerald-800";
  }

  if (["processing", "queued", "staged"].includes(value)) {
    return "bg-blue-100 text-blue-800";
  }

  if (["failed"].includes(value)) {
    return "bg-red-100 text-red-800";
  }

  return "bg-slate-100 text-slate-700";
}

function JobBadge({ children }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-black uppercase text-slate-700">
      {children}
    </span>
  );
}

function ColumnMapper({ fileName, previewRows, mapping, onChange, appliesToBatch }) {
  const columnCount = useMemo(
    () => previewRows.reduce((max, row) => Math.max(max, row.length), 0),
    [previewRows],
  );

  const fieldAtColumn = (index) =>
    Object.keys(mapping.columns).find((field) => mapping.columns[field] === index) || "";

  const setColumnField = (index, field) => {
    const nextColumns = {};
    for (const [existingField, existingIndex] of Object.entries(mapping.columns)) {
      if (existingIndex === index) continue; // clear whatever was on this column
      if (existingField === field) continue; // a field can only map to one column
      nextColumns[existingField] = existingIndex;
    }
    if (field) nextColumns[field] = index;
    onChange({ ...mapping, columns: nextColumns });
  };

  const dataRows = mapping.has_header ? previewRows.slice(1) : previewRows;
  const missingRequired = REQUIRED_MAPPING_FIELDS.filter((field) => !(field in mapping.columns));

  return (
    <div className="mt-4 rounded-3xl border border-blue-200 bg-blue-50/60 p-4">
      <div className="flex items-center gap-2 font-black text-slate-950">
        <FileSpreadsheet size={18} /> Label your columns
      </div>
      <p className="mt-1 text-xs font-semibold leading-5 text-slate-600">
        Preview of {fileName ? <span className="font-mono">{fileName}</span> : "your file"}. Tell us
        what each column is so points aren't wrongly rejected.
        {appliesToBatch ? " These labels apply to every file in the batch." : ""}
      </p>

      <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <input
          type="checkbox"
          checked={mapping.has_header}
          onChange={(event) => onChange({ ...mapping, has_header: event.target.checked })}
        />
        First row is a header (skip it)
      </label>

      <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              {Array.from({ length: columnCount }).map((_, index) => (
                <th key={index} className="border-b-2 border-slate-200 p-1 align-top">
                  <SelectInput
                    value={fieldAtColumn(index)}
                    onChange={(event) => setColumnField(index, event.target.value)}
                    className="!px-2 !py-2 text-xs"
                  >
                    <option value="">Ignore</option>
                    {MAPPING_FIELDS.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label}
                      </option>
                    ))}
                  </SelectInput>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.slice(0, 5).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: columnCount }).map((_, colIndex) => (
                  <td
                    key={colIndex}
                    className="whitespace-nowrap border-b border-slate-100 px-3 py-1 font-mono text-slate-700"
                  >
                    {row[colIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {missingRequired.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          Label Point ID, Northing, and Easting to use your mapping. Until then we auto-detect
          columns (the current behavior).
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
          Mapping set — the worker will use your labels for this upload.
        </div>
      )}
    </div>
  );
}

const REMEMBERED_EPSG_KEY = "pv_import_epsg";
const REMEMBERED_CS_KEY = "pv_import_cs";

function readRemembered(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value != null && value !== "" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function DataImportPanel({ company, membership, defaultEpsg, defaultCoordinateSystem }) {
  const [singleFile, setSingleFile] = useState(null);
  const [batchFiles, setBatchFiles] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);
  const [columnMapping, setColumnMapping] = useState({ has_header: false, columns: {} });
  const [declaredEpsg, setDeclaredEpsg] = useState(
    () => defaultEpsg || readRemembered(REMEMBERED_EPSG_KEY, "2238"),
  );
  const [declaredCoordinateSystem, setDeclaredCoordinateSystem] = useState(
    () => defaultCoordinateSystem || readRemembered(REMEMBERED_CS_KEY, "NAD83 / Florida North (ftUS)"),
  );
  // R1: the user must actively confirm the coordinate system before upload, so
  // a wrong zone can't silently mislocate every point. Pre-checked only when the
  // current EPSG matches what they last confirmed (keeps repeat imports low-friction).
  const [coordinateConfirmed, setCoordinateConfirmed] = useState(
    () => String(defaultEpsg || readRemembered(REMEMBERED_EPSG_KEY, "")) ===
      readRemembered(REMEMBERED_EPSG_KEY, "__none__"),
  );
  // U1/U2/U6: per-upload escape hatch from the monument-code filter.
  const [skipMarkerFilter, setSkipMarkerFilter] = useState(false);
  const [defaultVisibility, setDefaultVisibility] = useState("company");

  const [recentJobs, setRecentJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);

  // Approve-without-reupload state (Phase 1 re-run + Phase 2 review picker).
  const [rerunBusy, setRerunBusy] = useState(false);
  const [reviewRows, setReviewRows] = useState(null); // null = not loaded
  const [reviewLoading, setReviewLoading] = useState(false);
  const [selectedReview, setSelectedReview] = useState(() => new Set());
  const [reviewMessage, setReviewMessage] = useState("");

  const [loading, setLoading] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState("");
  const [uploadProgress, setUploadProgress] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const canImport = ["owner", "admin", "member"].includes(membership?.role);
  const canManage = ["owner", "admin"].includes(membership?.role);

  const queuedCount = useMemo(
    () => recentJobs.filter((job) => job.python_worker_status === "queued").length,
    [recentJobs],
  );

  const processingCount = useMemo(
    () => recentJobs.filter((job) => job.python_worker_status === "processing").length,
    [recentJobs],
  );

  const processedCount = useMemo(
    () => recentJobs.filter((job) => job.python_worker_status === "processed").length,
    [recentJobs],
  );

  const failedCount = useMemo(
    () => recentJobs.filter((job) => job.python_worker_status === "failed").length,
    [recentJobs],
  );

  const selectedBatchFiles = batchFiles.length > 0;

  // Changing the declared system forces re-confirmation (R1). Confirming
  // remembers the choice so the same crew's next import is pre-checked.
  const onEpsgChange = (value) => {
    setDeclaredEpsg(value);
    setCoordinateConfirmed(false);
  };
  const onCoordinateSystemChange = (value) => {
    setDeclaredCoordinateSystem(value);
    setCoordinateConfirmed(false);
  };
  const confirmCoordinate = (checked) => {
    setCoordinateConfirmed(checked);
    if (checked) {
      try {
        window.localStorage.setItem(REMEMBERED_EPSG_KEY, String(declaredEpsg || ""));
        window.localStorage.setItem(REMEMBERED_CS_KEY, String(declaredCoordinateSystem || ""));
      } catch {
        /* localStorage unavailable — confirmation still applies for this session */
      }
    }
  };

  const loadRecentJobs = async () => {
    if (!company?.id) return;

    const { data, error: jobsError } = await getRecentImportJobs(company.id, 25);

    if (jobsError) {
      setError(jobsError.message || "Could not load recent import jobs.");
      return;
    }

    setRecentJobs(data || []);

    if (activeJob?.id) {
      const fresh = (data || []).find((job) => job.id === activeJob.id);
      if (fresh) setActiveJob(fresh);
    }
  };

  useEffect(() => {
    loadRecentJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id]);

  const loadPreviewFromFile = async (file) => {
    if (!file) {
      setPreviewRows([]);
      setColumnMapping({ has_header: false, columns: {} });
      return;
    }
    try {
      const { rows } = await previewCsvFile(file, 6);
      setPreviewRows(rows);
      setColumnMapping(guessColumnMapping(rows));
    } catch {
      setPreviewRows([]);
      setColumnMapping({ has_header: false, columns: {} });
    }
  };

  const handleSingleFileChange = (event) => {
    const selected = event.target.files?.[0] || null;
    setSingleFile(selected);
    setBatchFiles([]);
    setUploadProgress(null);
    setMessage("");
    setError("");
    loadPreviewFromFile(selected);
  };

  const handleBatchChange = (event) => {
    const files = normalizeImportFileList(event.target.files);
    setBatchFiles(files);
    setSingleFile(null);
    setUploadProgress(null);
    setMessage(
      files.length > 0
        ? `Selected ${files.length.toLocaleString()} CSV/TXT files for cloud queue.`
        : "",
    );
    setError(files.length === 0 ? "No CSV/TXT files were selected." : "");
    loadPreviewFromFile(files[0]?.file || null);
  };

  const handleFolderChange = (event) => {
    const files = normalizeImportFileList(event.target.files);
    setBatchFiles(files);
    setSingleFile(null);
    setUploadProgress(null);
    setMessage(
      files.length > 0
        ? `Loaded ${files.length.toLocaleString()} CSV/TXT files from folder for cloud queue.`
        : "",
    );
    setError(files.length === 0 ? "No CSV/TXT files found in that folder." : "");
    loadPreviewFromFile(files[0]?.file || null);
  };

  const uploadOneFileToStorage = async (fileItem, index = 0, total = 1) => {
    setUploadingFileName(fileItem.relativePath || fileItem.name || fileItem.file?.name || "");
    setUploadProgress({
      fileIndex: index + 1,
      fileCount: total,
      fileName: fileItem.relativePath || fileItem.name || fileItem.file?.name || "",
      percent: 0,
    });

    const mappingComplete = REQUIRED_MAPPING_FIELDS.every(
      (field) => columnMapping?.columns && field in columnMapping.columns,
    );

    const { data, error: uploadError } = await createAndUploadStorageImport({
      companyId: company.id,
      file: fileItem.file || fileItem,
      declaredEpsg,
      declaredCoordinateSystem,
      defaultVisibility,
      columnMapping: mappingComplete ? columnMapping : null,
      skipMarkerFilter,
      onProgress: (progress) => {
        setUploadProgress({
          fileIndex: index + 1,
          fileCount: total,
          fileName: fileItem.relativePath || fileItem.name || fileItem.file?.name || "",
          percent: progress.percent ?? 0,
          stage: progress.stage,
        });
      },
    });

    if (uploadError) {
      return {
        ok: false,
        fileItem,
        error: uploadError,
        data,
      };
    }

    return {
      ok: true,
      fileItem,
      data,
      error: null,
    };
  };

  const queueSingleFile = async () => {
    if (!company?.id) {
      setError("No company selected.");
      return;
    }

    if (!singleFile) {
      setError("Select a file first.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("Uploading raw file to PointVault cloud storage...");

    const result = await uploadOneFileToStorage(
      {
        file: singleFile,
        name: singleFile.name,
        relativePath: singleFile.name,
        size: singleFile.size,
      },
      0,
      1,
    );

    if (!result.ok) {
      setError(result.error?.message || "Could not upload file to cloud storage.");
      setLoading(false);
      return;
    }

    setMessage(
      `Queued ${singleFile.name}. The cloud worker will pick it up shortly.`,
    );

    setSingleFile(null);
    setUploadProgress(null);
    setUploadingFileName("");
    loadPreviewFromFile(null);
    await loadRecentJobs();
    setLoading(false);
  };

  const queueBatchFiles = async () => {
    if (!company?.id) {
      setError("No company selected.");
      return;
    }

    if (batchFiles.length === 0) {
      setError("Select batch files or a folder first.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage(`Uploading ${batchFiles.length.toLocaleString()} files to cloud storage...`);

    let successCount = 0;
    let failureCount = 0;

    for (let index = 0; index < batchFiles.length; index += 1) {
      const result = await uploadOneFileToStorage(batchFiles[index], index, batchFiles.length);

      if (result.ok) {
        successCount += 1;
      } else {
        failureCount += 1;
        setError(
          `Failed on ${batchFiles[index].relativePath}: ${
            result.error?.message || "Upload failed."
          }`,
        );
        break;
      }
    }

    setMessage(
      `Queued ${successCount.toLocaleString()} files for Python processing.${
        failureCount ? ` ${failureCount.toLocaleString()} failed.` : ""
      }`,
    );

    setUploadProgress(null);
    setUploadingFileName("");
    setBatchFiles([]);
    loadPreviewFromFile(null);
    await loadRecentJobs();
    setLoading(false);
  };

  const resetReviewState = () => {
    setReviewRows(null);
    setSelectedReview(new Set());
    setReviewMessage("");
  };

  const openJob = async (job) => {
    setActiveJob(job);
    setError("");
    resetReviewState();

    const { data, error: jobError } = await getImportJob(job.id);

    if (jobError) {
      setError(jobError.message || "Could not load import job.");
      return;
    }

    setActiveJob(data || job);
  };

  const refreshActiveJob = async () => {
    if (!activeJob?.id) {
      await loadRecentJobs();
      return;
    }

    const { data, error: jobError } = await getImportJob(activeJob.id);

    if (jobError) {
      setError(jobError.message || "Could not refresh import job.");
      return;
    }

    setActiveJob(data);
    await loadRecentJobs();
  };

  const openStorageFile = async (path) => {
    if (!path) return;

    const { data, error: signedUrlError } = await getStorageImportDownloadUrl(path);

    if (signedUrlError) {
      setError(signedUrlError.message || "Could not create download link.");
      return;
    }

    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    }
  };

  // Phase 1: re-run the worker on the already-uploaded file, importing every
  // located row (skips the monument filter). No re-upload.
  const rerunImportAll = async (job) => {
    if (!job?.id) return;
    const ok = window.confirm(
      "Re-run this import and bring in EVERY located point (accepted + review), " +
        "skipping the monument-code filter? Your already-uploaded file is reused — no re-upload.",
    );
    if (!ok) return;

    setRerunBusy(true);
    setError("");
    resetReviewState();
    const { error: requeueError } = await requeueStorageImportJob(job.id, true);
    setRerunBusy(false);

    if (requeueError) {
      setError(requeueError.message || "Could not re-queue the import.");
      return;
    }

    setMessage("Re-queued. The worker will reprocess your file and import all located points shortly. Use Refresh Job to watch.");
    await refreshActiveJob();
  };

  // Phase 2: load the review rows (valid coords, no recognized monument code)
  // so the user can approve individual ones.
  const loadReviewRows = async (job) => {
    if (!job?.review_storage_path) {
      setReviewMessage("No review file for this job.");
      setReviewRows([]);
      return;
    }
    setReviewLoading(true);
    setReviewMessage("");
    const { rows, error: reviewError } = await fetchStorageCsvRows(job.review_storage_path);
    setReviewLoading(false);

    if (reviewError) {
      setReviewMessage(reviewError.message || "Could not load review rows.");
      setReviewRows([]);
      return;
    }

    setReviewRows(rows);
    setSelectedReview(new Set(rows.map((_, index) => index)));
  };

  const toggleReviewRow = (index) => {
    setSelectedReview((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAllReview = () => {
    setSelectedReview((prev) =>
      prev.size === (reviewRows?.length || 0) ? new Set() : new Set((reviewRows || []).map((_, i) => i)),
    );
  };

  const approveSelectedReview = async (job) => {
    if (!job?.id || !reviewRows?.length) return;
    const chosen = reviewRows.filter((_, index) => selectedReview.has(index));
    if (chosen.length === 0) {
      setReviewMessage("Select at least one row to approve.");
      return;
    }

    setReviewLoading(true);
    setReviewMessage(`Approving ${chosen.length.toLocaleString()} point(s)...`);
    const { data, error: promoteError } = await promoteImportRows(job.id, chosen);
    setReviewLoading(false);

    if (promoteError) {
      setReviewMessage(promoteError.message || "Could not approve the selected rows.");
      return;
    }

    const inserted = Number(data?.inserted_points || 0);
    const skipped = Number(data?.skipped_points || 0);
    // Drop the approved rows from the list so they don't show again this session.
    const remaining = reviewRows.filter((_, index) => !selectedReview.has(index));
    setReviewRows(remaining);
    setSelectedReview(new Set(remaining.map((_, i) => i)));
    setReviewMessage(
      `Approved ${inserted.toLocaleString()} point(s)${
        skipped ? `, ${skipped.toLocaleString()} skipped as duplicates` : ""
      }. They're now in your company points.`,
    );
    await refreshActiveJob();
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Data Integration
              </div>

              <h2 className="mt-1 text-2xl font-black text-slate-950">
                Cloud Import Platform
              </h2>

              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Large files are uploaded to PointVault cloud storage first. The Python worker then
                downloads the raw file, cleans it, creates accepted/review/rejected/duplicate
                outputs, and uploads those processed files back under the company import folder.
              </p>
            </div>

            <Button onClick={loadRecentJobs} variant="secondary" className="rounded-2xl px-4 py-3">
              <RefreshCw size={16} className="mr-2" /> Recent Jobs
            </Button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <StatCard label="Queued" value={queuedCount} note="Waiting worker" />
            <StatCard label="Processing" value={processingCount} note="Python worker" />
            <StatCard label="Processed" value={processedCount} note="Outputs ready" />
            <StatCard label="Failed" value={failedCount} note="Needs attention" />
          </div>

        </CardContent>
      </Card>

      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Cloud size={21} className="text-slate-500" />
            <h3 className="text-xl font-black text-slate-950">
              1. Upload Raw Files to Cloud Queue
            </h3>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <label className="grid min-w-0 gap-2 overflow-hidden rounded-3xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 font-black text-slate-950">
                <Upload size={18} /> Single CSV/TXT file
              </div>

              <input
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={handleSingleFileChange}
                disabled={!canImport || loading}
                className="block w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
              />

              {singleFile && (
                <div className="rounded-2xl bg-slate-50 p-3 text-sm font-semibold text-slate-700">
                  {singleFile.name} · {formatBytes(singleFile.size)}
                </div>
              )}

              <Button
                type="button"
                onClick={queueSingleFile}
                className="rounded-2xl px-5 py-3"
                disabled={!singleFile || loading || !canImport || !coordinateConfirmed}
              >
                {loading && singleFile ? (
                  <Loader2 size={16} className="mr-2 animate-spin" />
                ) : (
                  <Cloud size={16} className="mr-2" />
                )}
                Upload + Queue
              </Button>
            </label>

            <label className="grid min-w-0 gap-2 overflow-hidden rounded-3xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 font-black text-slate-950">
                <Upload size={18} /> Batch text files
              </div>

              <input
                type="file"
                multiple
                accept=".csv,.txt,text/csv,text/plain"
                onChange={handleBatchChange}
                disabled={!canImport || loading}
                className="block w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
              />

              <div className="text-xs font-semibold leading-5 text-slate-500">
                Select many TXT files directly with Shift/Ctrl.
              </div>
            </label>

            <label className="grid min-w-0 gap-2 overflow-hidden rounded-3xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 font-black text-slate-950">
                <FolderOpen size={18} /> Entire folder
              </div>

              <input
                type="file"
                multiple
                webkitdirectory=""
                directory=""
                accept=".csv,.txt,text/csv,text/plain"
                onChange={handleFolderChange}
                disabled={!canImport || loading}
                className="block w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white"
              />

              <div className="text-xs font-semibold leading-5 text-slate-500">
                Select a whole folder. Browser support varies.
              </div>
            </label>
          </div>

          {previewRows.length > 0 && (
            <ColumnMapper
              fileName={singleFile?.name || batchFiles[0]?.name}
              previewRows={previewRows}
              mapping={columnMapping}
              onChange={setColumnMapping}
              appliesToBatch={selectedBatchFiles}
            />
          )}

          {selectedBatchFiles && (
            <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="font-black text-slate-950">
                    Selected batch: {batchFiles.length.toLocaleString()} CSV/TXT files
                  </div>
                  <div className="mt-1 text-xs font-semibold text-slate-500">
                    Each file becomes its own storage import job.
                  </div>
                </div>

                <Button
                  type="button"
                  onClick={queueBatchFiles}
                  className="rounded-2xl px-5 py-3"
                  disabled={loading || !canImport || !coordinateConfirmed}
                >
                  {loading ? (
                    <Loader2 size={16} className="mr-2 animate-spin" />
                  ) : (
                    <Cloud size={16} className="mr-2" />
                  )}
                  Upload Batch + Queue
                </Button>
              </div>

              <div className="mt-3 max-h-64 overflow-auto rounded-2xl bg-slate-50 p-3 text-xs font-semibold text-slate-600">
                {batchFiles.slice(0, 100).map((item) => (
                  <div key={item.relativePath} className="truncate rounded-xl px-3 py-2">
                    {item.relativePath} · {formatBytes(item.size)}
                  </div>
                ))}

                {batchFiles.length > 100 && (
                  <div className="rounded-xl bg-slate-100 px-3 py-2 font-black text-slate-700">
                    ...and {(batchFiles.length - 100).toLocaleString()} more files
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[220px_1fr_260px]">
            <Field label="EPSG / zone">
              <TextInput
                value={declaredEpsg}
                onChange={(event) => onEpsgChange(event.target.value)}
                placeholder="2238"
              />
            </Field>

            <Field label="Coordinate system name">
              <TextInput
                value={declaredCoordinateSystem}
                onChange={(event) => onCoordinateSystemChange(event.target.value)}
              />
            </Field>

            <Field label="Default visibility after import">
              <SelectInput
                value={defaultVisibility}
                onChange={(event) => setDefaultVisibility(event.target.value)}
              >
                <option value="company">Company private</option>
                <option value="community">Share to community after promotion</option>
              </SelectInput>
            </Field>
          </div>

          <div className="mt-4 grid gap-3">
            <label
              className={`flex items-start gap-3 rounded-2xl border p-3 text-sm ${
                coordinateConfirmed
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-300 bg-amber-50"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={coordinateConfirmed}
                onChange={(event) => confirmCoordinate(event.target.checked)}
                disabled={!canImport}
              />
              <span className="font-semibold text-slate-700">
                I confirm these points are in{" "}
                <span className="font-black text-slate-950">
                  {declaredCoordinateSystem || "the selected system"}
                </span>{" "}
                (EPSG {declaredEpsg || "?"}).
                <span className="mt-1 block text-xs font-medium text-slate-500">
                  Required before upload. If this is wrong, every point lands in the wrong place on
                  the map. For decimal latitude/longitude files, set EPSG to <strong>4326</strong>.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={skipMarkerFilter}
                onChange={(event) => setSkipMarkerFilter(event.target.checked)}
                disabled={!canImport}
              />
              <span className="font-semibold text-slate-700">
                Import every located point (skip the monument-code filter)
                <span className="mt-1 block text-xs font-medium text-slate-500">
                  Turn on for coordinate-only or non-survey files. Off (default) keeps only rows with
                  a recognized monument code (IR, CIR, REBAR…); the rest go to review.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-4 grid gap-2">
            {uploadProgress && (
              <Message kind="info">
                Uploading {uploadProgress.fileIndex} of {uploadProgress.fileCount}:{" "}
                {uploadProgress.fileName} · {Number(uploadProgress.percent || 0).toFixed(0)}%
              </Message>
            )}

            {uploadingFileName && !uploadProgress && (
              <Message kind="info">Working on {uploadingFileName}...</Message>
            )}

            <Message>{message}</Message>
            <Message kind="error">{error}</Message>
          </div>
        </CardContent>
      </Card>

      {activeJob && (
        <Card className="rounded-3xl border-0 shadow-xl">
          <CardContent className="p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Active Import Job
                </div>
                <h3 className="mt-1 text-xl font-black text-slate-950">
                  {activeJob.source_file_name || "Untitled import"}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-black uppercase ${statusClasses(
                      activeJob.status,
                    )}`}
                  >
                    {activeJob.status || "unknown"}
                  </span>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-black uppercase ${statusClasses(
                      activeJob.python_worker_status,
                    )}`}
                  >
                    Worker: {activeJob.python_worker_status || "not started"}
                  </span>
                  <JobBadge>{activeJob.import_mode || "unknown mode"}</JobBadge>
                </div>
              </div>

              <Button
                type="button"
                onClick={refreshActiveJob}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <RefreshCw size={16} className="mr-2" /> Refresh Job
              </Button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <StatCard label="Total rows" value={activeJob.total_rows} note="Python count" />
              <StatCard label="Accepted" value={activeJob.accepted_rows} note="Clean output" />
              <StatCard label="Rejected" value={activeJob.rejected_rows} note="Review/reject" />
              <StatCard label="Duplicates" value={activeJob.duplicate_rows} note="Skipped" />
            </div>

            {activeJob.coordinate_warning && (
              <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-900">
                ⚠️ {activeJob.coordinate_warning}
              </div>
            )}

            {activeJob.import_centroid_lat != null && activeJob.import_centroid_lng != null && (
              <div className="mt-3 rounded-2xl bg-slate-50 p-3 text-sm font-semibold text-slate-600">
                Imported points center near{" "}
                <a
                  className="font-black text-blue-700 underline"
                  target="_blank"
                  rel="noreferrer"
                  href={`https://www.google.com/maps?q=${activeJob.import_centroid_lat},${activeJob.import_centroid_lng}`}
                >
                  {Number(activeJob.import_centroid_lat).toFixed(5)},{" "}
                  {Number(activeJob.import_centroid_lng).toFixed(5)}
                </a>
                . Open it to confirm that's the right area — if it's in the ocean or the wrong
                state, the EPSG/zone was wrong.
              </div>
            )}

            <div className="mt-4 grid gap-2 text-sm font-semibold text-slate-600">
              <div className="rounded-2xl bg-slate-50 p-3">
                <span className="font-black text-slate-950">Worker message:</span>{" "}
                {activeJob.python_worker_message || "No worker message yet."}
              </div>

              <details className="rounded-2xl bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-slate-500">
                  Storage path
                </summary>
                <div className="mt-2 break-all text-xs font-mono text-slate-600">
                  {activeJob.raw_storage_path || "Not uploaded"}
                </div>
              </details>

              <div className="rounded-2xl bg-slate-50 p-3">
                <span className="font-black text-slate-950">Created:</span>{" "}
                {formatDate(activeJob.created_at)} ·{" "}
                <span className="font-black text-slate-950">Uploaded:</span>{" "}
                {formatDate(activeJob.storage_uploaded_at)} ·{" "}
                <span className="font-black text-slate-950">Finished:</span>{" "}
                {formatDate(activeJob.python_finished_at)}
              </div>
            </div>

            <div className="mt-4 grid gap-2 md:grid-cols-3">
              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.accepted_storage_path)}
                disabled={!activeJob.accepted_storage_path}
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> Accepted CSV
              </Button>

              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.review_storage_path)}
                disabled={!activeJob.review_storage_path}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> Review CSV
              </Button>

              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.rejected_storage_path)}
                disabled={!activeJob.rejected_storage_path}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> Rejected CSV
              </Button>

              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.duplicate_storage_path)}
                disabled={!activeJob.duplicate_storage_path}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> Duplicates CSV
              </Button>

              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.kml_storage_path)}
                disabled={!activeJob.kml_storage_path}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> KML
              </Button>

              <Button
                type="button"
                onClick={() => openStorageFile(activeJob.summary_storage_path)}
                disabled={!activeJob.summary_storage_path}
                variant="secondary"
                className="rounded-2xl px-4 py-3"
              >
                <Download size={16} className="mr-2" /> Summary JSON
              </Button>
            </div>

            {activeJob.import_mode === "storage_python" && activeJob.raw_storage_path && canImport && (
              <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-4">
                <div className="font-black text-slate-950">Approve points that didn't auto-import</div>
                <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                  "Review" rows have valid coordinates but no recognized monument code. Approve them
                  without re-uploading — your original file is still in cloud storage. (Rows in
                  "Rejected" have no usable coordinates and need the data fixed + re-uploaded.)
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => rerunImportAll(activeJob)}
                    disabled={rerunBusy}
                    className="rounded-2xl px-4 py-3"
                  >
                    {rerunBusy ? (
                      <Loader2 size={16} className="mr-2 animate-spin" />
                    ) : (
                      <RefreshCw size={16} className="mr-2" />
                    )}
                    Re-run &amp; import all located points
                  </Button>

                  <Button
                    type="button"
                    onClick={() => loadReviewRows(activeJob)}
                    disabled={reviewLoading || !activeJob.review_storage_path}
                    variant="secondary"
                    className="rounded-2xl px-4 py-3"
                  >
                    {reviewLoading ? (
                      <Loader2 size={16} className="mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 size={16} className="mr-2" />
                    )}
                    Review &amp; approve individually
                  </Button>
                </div>

                {reviewMessage && (
                  <div className="mt-3">
                    <Message kind="info">{reviewMessage}</Message>
                  </div>
                )}

                {reviewRows && reviewRows.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={toggleAllReview}
                        className="text-xs font-bold uppercase tracking-wide text-blue-700 underline"
                      >
                        {selectedReview.size === reviewRows.length ? "Clear all" : "Select all"}
                      </button>
                      <Button
                        type="button"
                        onClick={() => approveSelectedReview(activeJob)}
                        disabled={reviewLoading || selectedReview.size === 0}
                        className="rounded-2xl px-4 py-2"
                      >
                        <CheckCircle2 size={15} className="mr-2" />
                        Approve selected ({selectedReview.size.toLocaleString()})
                      </Button>
                    </div>

                    <div className="max-h-72 overflow-auto rounded-2xl border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-slate-100 font-black text-slate-700">
                          <tr>
                            <th className="px-2 py-2"> </th>
                            <th className="px-2 py-2">Point</th>
                            <th className="px-2 py-2">Description</th>
                            <th className="px-2 py-2">Location</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reviewRows.map((row, index) => {
                            const loc = row.latitude && row.longitude
                              ? `${row.latitude}, ${row.longitude}`
                              : `${row.northing || "?"} / ${row.easting || "?"}`;
                            return (
                              <tr key={index} className="border-t border-slate-100 odd:bg-white even:bg-slate-50">
                                <td className="px-2 py-2">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={selectedReview.has(index)}
                                    onChange={() => toggleReviewRow(index)}
                                  />
                                </td>
                                <td className="px-2 py-2 font-semibold text-slate-800">{row.point || "—"}</td>
                                <td className="px-2 py-2 text-slate-600">{row.description || "—"}</td>
                                <td className="px-2 py-2 font-mono text-slate-500">{loc}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {reviewRows && reviewRows.length === 0 && !reviewLoading && (
                  <div className="mt-3 text-xs font-semibold text-slate-500">
                    No review rows to approve for this job.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-xl font-black text-slate-950">Recent Cloud Import Jobs</h3>
              <p className="mt-1 text-sm text-slate-600">
                Click a job to view raw/processed storage paths and download Python worker outputs.
              </p>
            </div>

            <Button onClick={loadRecentJobs} variant="secondary" className="rounded-2xl px-4 py-3">
              <RefreshCw size={16} className="mr-2" /> Refresh
            </Button>
          </div>

          <div className="mt-4 grid gap-2">
            {recentJobs.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
                No import jobs loaded yet.
              </div>
            )}

            {recentJobs.map((job) => (
              <button
                key={job.id}
                onClick={() => openJob(job)}
                className={`rounded-2xl border bg-white p-4 text-left transition hover:border-blue-300 hover:shadow-md ${
                  activeJob?.id === job.id ? "border-blue-400 shadow-md" : "border-slate-200"
                }`}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-black text-slate-950">
                      {job.source_file_name || "Untitled import"}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-500">
                      {formatDate(job.created_at)}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">
                      Job {String(job.id || "").slice(0, 8) || "—"}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs font-bold">
                    <span
                      className={`rounded-full px-2 py-1 ${statusClasses(job.status)}`}
                    >
                      {job.status || "unknown"}
                    </span>

                    <span
                      className={`rounded-full px-2 py-1 ${statusClasses(
                        job.python_worker_status,
                      )}`}
                    >
                      Worker {job.python_worker_status || "not_started"}
                    </span>

                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-700">
                      A {Number(job.accepted_rows || 0).toLocaleString()}
                    </span>

                    <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700">
                      R {Number(job.rejected_rows || 0).toLocaleString()}
                    </span>

                    <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">
                      D {Number(job.duplicate_rows || 0).toLocaleString()}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}