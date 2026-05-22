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
  getImportJob,
  getRecentImportJobs,
  getStorageImportDownloadUrl,
  normalizeImportFileList,
} from "@/lib/dataIntegration";

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

export function DataImportPanel({ company, membership }) {
  const [singleFile, setSingleFile] = useState(null);
  const [batchFiles, setBatchFiles] = useState([]);
  const [declaredEpsg, setDeclaredEpsg] = useState("2238");
  const [declaredCoordinateSystem, setDeclaredCoordinateSystem] = useState(
    "NAD83 / Florida North (ftUS)",
  );
  const [defaultVisibility, setDefaultVisibility] = useState("company");

  const [recentJobs, setRecentJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);

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

  const handleSingleFileChange = (event) => {
    const selected = event.target.files?.[0] || null;
    setSingleFile(selected);
    setBatchFiles([]);
    setUploadProgress(null);
    setMessage("");
    setError("");
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
  };

  const uploadOneFileToStorage = async (fileItem, index = 0, total = 1) => {
    setUploadingFileName(fileItem.relativePath || fileItem.name || fileItem.file?.name || "");
    setUploadProgress({
      fileIndex: index + 1,
      fileCount: total,
      fileName: fileItem.relativePath || fileItem.name || fileItem.file?.name || "",
      percent: 0,
    });

    const { data, error: uploadError } = await createAndUploadStorageImport({
      companyId: company.id,
      file: fileItem.file || fileItem,
      declaredEpsg,
      declaredCoordinateSystem,
      defaultVisibility,
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
    await loadRecentJobs();
    setLoading(false);
  };

  const openJob = async (job) => {
    setActiveJob(job);
    setError("");

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
                disabled={!singleFile || loading || !canImport}
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
                  disabled={loading || !canImport}
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
                onChange={(event) => setDeclaredEpsg(event.target.value)}
                placeholder="2238"
              />
            </Field>

            <Field label="Coordinate system name">
              <TextInput
                value={declaredCoordinateSystem}
                onChange={(event) => setDeclaredCoordinateSystem(event.target.value)}
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