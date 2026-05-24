import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  CreditCard,
  Database,
  Download,
  Filter,
  Layers,
  List,
  LocateFixed,
  Map,
  MapPin,
  Menu,
  Navigation,
  Plus,
  RefreshCw,
  Satellite,
  Save,
  Search,
  Send,
  Settings as SettingsIcon,
  Target,
  Upload,
  Users,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { motion } from "framer-motion";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import * as EL from "esri-leaflet";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BillingPanel,
  CompanySetupPanel,
  InvitePanel,
  SignInPanel,
  TeamPanel,
  TrialEndedGate,
} from "@/components/CompanyAccountPanel";
import { SettingsTab } from "@/components/SettingsTab";
import {
  addCommunityPointNote,
  addPointObservation,
  fetchCompanyBilling,
  fetchNearbyCompanyPoints,
  getCurrentSession,
  listCommunityPointNotes,
  listPointObservations,
  onAuthChange,
} from "@/lib/companyAccounts";
import {
  cleanupCompanyDuplicatePoints,
  deleteCompanyPoint as deleteCompanyPointRpc,
} from "@/lib/dataIntegration";
import { DataImportPanel } from "@/components/DataImportPanel";

const USER_LOCATION_KEY = "pointvault-last-user-location-v1";
const THEME_KEY = "pointvault-theme";
const PREFS_KEY = "pointvault-prefs-v1";

function loadInitialTheme() {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function loadInitialPrefs() {
  const defaults = {
    basemap: "aerial",
    radius: 5280,
    coordEpsg: "2238",
    coordName: "NAD83 / Florida North (ftUS)",
  };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

const statusMeta = {
  found: {
    label: "Found",
    icon: CheckCircle2,
    badge: "bg-emerald-100 text-emerald-800 border-emerald-200",
    color: "#10b981",
  },
  suspect: {
    label: "Suspect",
    icon: AlertTriangle,
    badge: "bg-amber-100 text-amber-800 border-amber-200",
    color: "#f59e0b",
  },
  destroyed: {
    label: "Destroyed",
    icon: XCircle,
    badge: "bg-red-100 text-red-800 border-red-200",
    color: "#ef4444",
  },
  record: {
    label: "Record Only",
    icon: Clock,
    badge: "bg-slate-100 text-slate-700 border-slate-200",
    color: "#64748b",
  },
};

const blankPoint = {
  id: "",
  dbId: "",
  name: "",
  status: "found",
  reliability: "C",
  lat: "",
  lng: "",
  northing: "",
  easting: "",
  coordinateSystem: "NAD83 / Florida North (ftUS) - EPSG:2238",
  job: "",
  sourceFile: "",
  county: "",
  crew: "",
  lastFound: new Date().toISOString().slice(0, 10),
  description: "",
  observations: [],
  photos: [],
};

function pointKey(point) {
  return String(point?.dbId || point?.id || "");
}

function loadLastUserLocation() {
  try {
    const saved = localStorage.getItem(USER_LOCATION_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (typeof parsed?.lat === "number" && typeof parsed?.lng === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceFeet(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lng);
  if ([lat1, lon1, lat2, lon2].some((value) => Number.isNaN(value))) return null;

  const earthRadiusFeet = 20902231;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusFeet * Math.asin(Math.sqrt(h));
}

function formatDistance(feet) {
  if (feet === null || feet === undefined || Number.isNaN(Number(feet))) return "--";
  const numericFeet = Number(feet);
  if (numericFeet < 1000) return `${Math.round(numericFeet).toLocaleString()} ft`;
  return `${(numericFeet / 5280).toFixed(2)} mi`;
}

function pointIcon(status, selected = false) {
  const color = (statusMeta[status] || statusMeta.record).color;
  const size = selected ? 22 : 16;
  return L.divIcon({
    className: "pointvault-marker",
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:3px solid white;border-radius:999px;box-shadow:0 3px 10px rgba(15,23,42,.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const userIcon = L.divIcon({
  className: "pointvault-user-marker",
  html: `<div style="width:22px;height:22px;background:#2563eb;border:4px solid white;border-radius:999px;box-shadow:0 0 0 10px rgba(37,99,235,.18),0 3px 10px rgba(15,23,42,.35);"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function StatusBadge({ status }) {
  const meta = statusMeta[status] || statusMeta.record;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${meta.badge}`}>
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

function ReliabilityBadge({ rating }) {
  return (
    <span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
      Reliability {rating || "?"}
    </span>
  );
}

function RecenterMap({ center, zoom }) {
  const map = useMap();
  const isFirstSnap = useRef(true);
  const lat = center?.[0];
  const lng = center?.[1];
  useEffect(() => {
    if (lat == null || lng == null) return;
    if (isFirstSnap.current) {
      map.setView([lat, lng], zoom || map.getZoom() || 16, { animate: true });
      isFirstSnap.current = false;
    } else {
      map.panTo([lat, lng], { animate: true });
    }
  }, [lat, lng, map, zoom]);
  return null;
}

function ParcelOverlay() {
  const map = useMap();

  useEffect(() => {
    const layer = EL.featureLayer({
      url: "https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
      style: () => ({
        color: "#00ffff",
        weight: 1,
        fillOpacity: 0,
        opacity: 0.85,
      }),
    }).addTo(map);

    return () => {
      map.removeLayer(layer);
    };
  }, [map]);

  return null;
}

const BASEMAPS = {
  aerial: [
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics",
    },
  ],
  hybrid: [
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics",
    },
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      attribution: "",
    },
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      attribution: "",
    },
  ],
  usgs: [
    {
      url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery &copy; U.S. Geological Survey",
      maxZoom: 19,
    },
  ],
  streets: [
    {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    },
  ],
  topo: [
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri — USGS, NOAA",
    },
  ],
};

function ClusteredPoints({ points, selectedPoint, onSelectPoint, onClusterZoom }) {
  const map = useMap();
  useEffect(() => {
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 60,
      chunkedLoading: true,
    });

    if (onClusterZoom) {
      cluster.on("clusterclick", () => onClusterZoom());
    }

    const selectedKey = pointKey(selectedPoint);
    const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);

    points.forEach((point) => {
      if (!point.lat || !point.lng) return;
      const selected = selectedKey === pointKey(point);
      const marker = L.marker([Number(point.lat), Number(point.lng)], {
        icon: pointIcon(point.status, selected),
      });
      marker.on("click", () => onSelectPoint(point));
      const popupHtml = `
        <div style="font-size:12px">
          <strong>${escapeHtml(point.id)}</strong><br/>
          ${escapeHtml(point.description || point.name || "")}<br/>
          <span>${escapeHtml(formatDistance(point.distanceFeet))} away</span><br/>
          <span>${escapeHtml(point.sourceFile || point.job || "No source file")}</span>
        </div>
      `;
      marker.bindPopup(popupHtml);
      cluster.addLayer(marker);
    });

    map.addLayer(cluster);
    return () => {
      map.removeLayer(cluster);
    };
  }, [map, points, selectedPoint, onSelectPoint]);

  return null;
}

function MapInteractionCapture({ onUserInteract }) {
  const map = useMap();
  useEffect(() => {
    if (!onUserInteract) return undefined;
    const handler = () => onUserInteract();
    const touchHandler = (event) => {
      if (event?.originalEvent?.touches?.length >= 2) onUserInteract();
    };
    map.on("dragstart", handler);
    map.on("wheel", handler);
    map.on("touchstart", touchHandler);
    return () => {
      map.off("dragstart", handler);
      map.off("wheel", handler);
      map.off("touchstart", touchHandler);
    };
  }, [map, onUserInteract]);
  return null;
}

function GpsFreshness({ userLocation }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!userLocation?.timestamp) return undefined;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [userLocation?.timestamp]);

  if (!userLocation?.timestamp) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - userLocation.timestamp) / 1000));
  let label;
  let className;
  if (elapsed < 5) {
    label = "GPS just now";
    className = "text-emerald-700";
  } else if (elapsed < 30) {
    label = `GPS ${elapsed}s ago`;
    className = "text-emerald-700";
  } else if (elapsed < 120) {
    label = `GPS ${elapsed}s ago — stale`;
    className = "text-amber-700";
  } else if (elapsed < 3600) {
    label = `GPS ${Math.floor(elapsed / 60)}m ago — no recent signal`;
    className = "text-red-700";
  } else {
    label = `GPS ${Math.floor(elapsed / 3600)}h ago — no signal`;
    className = "text-red-700";
  }
  return <span className={`text-xs font-bold ${className}`}>{label}</span>;
}

function MapCenterTracker({ onCenterChange }) {
  const map = useMap();
  useEffect(() => {
    if (!onCenterChange) return undefined;
    const report = () => {
      const c = map.getCenter();
      onCenterChange({ lat: c.lat, lng: c.lng });
    };
    map.on("moveend", report);
    report();
    return () => map.off("moveend", report);
  }, [map, onCenterChange]);
  return null;
}

function MapFlyToTarget({ target }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    if (target.bounds) {
      map.fitBounds(target.bounds, { padding: [40, 40], maxZoom: target.maxZoom || 17 });
    } else {
      map.setView([target.lat, target.lng], target.zoom || 17, { animate: true });
    }
  }, [target, map]);
  return null;
}

function GisMap({ points, selectedPoint, userLocation, followUser, onUserPan, onMapCenterChange, flyToTarget, onSelectPoint, basemap, showParcels }) {
  const fallbackCenter = [30.7, -86.1];
  const center = userLocation ? [userLocation.lat, userLocation.lng] : fallbackCenter;
  const selectedBasemap = BASEMAPS[basemap] || BASEMAPS.aerial;

  return (
    <Card className="overflow-hidden rounded-3xl border-0 shadow-lg">
      <CardContent className="relative h-[420px] p-0">
        <MapContainer center={center} zoom={userLocation ? 15 : 8} className="h-full w-full" scrollWheelZoom>
          {selectedBasemap.map((layer, index) => {
            const layerProps = { url: layer.url, attribution: layer.attribution };
            if (layer.subdomains) layerProps.subdomains = layer.subdomains;
            if (layer.maxZoom) layerProps.maxZoom = layer.maxZoom;
            return <TileLayer key={`${basemap}-${index}`} {...layerProps} />;
          })}
          <MapInteractionCapture onUserInteract={onUserPan} />
          <MapCenterTracker onCenterChange={onMapCenterChange} />
          <MapFlyToTarget target={flyToTarget} />
          {showParcels && <ParcelOverlay />}
          {followUser && userLocation && <RecenterMap center={[userLocation.lat, userLocation.lng]} zoom={16} />}
          {userLocation && (
            <Marker position={[userLocation.lat, userLocation.lng]} icon={userIcon}>
              <Popup>
                <strong>You are here</strong>
                <br />
                Accuracy: {userLocation.accuracy ? Math.round(userLocation.accuracy) + " ft" : "unknown"}
                <br />
                GPS age: {userLocation.timestamp ? Math.round((Date.now() - userLocation.timestamp) / 1000) + " sec" : "unknown"}
              </Popup>
            </Marker>
          )}
          <ClusteredPoints
            points={points}
            selectedPoint={selectedPoint}
            onSelectPoint={onSelectPoint}
            onClusterZoom={onUserPan}
          />
        </MapContainer>
      </CardContent>
    </Card>
  );
}

function PointCard({ point, selected, onClick }) {
  return (
    <button onClick={() => onClick(point)} className="w-full text-left">
      <Card className={`rounded-3xl border transition ${selected ? "border-blue-400 shadow-lg" : "border-slate-200 shadow-sm hover:shadow-md"}`}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-bold text-slate-950">{point.id}</div>
              <div className="mt-1 text-sm text-slate-600">{point.description || point.name || "Unnamed point"}</div>
            </div>
            <div className="text-right text-sm font-semibold text-slate-700">{formatDistance(point.distanceFeet)}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusBadge status={point.status} />
            <ReliabilityBadge rating={point.reliability} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <MapPin size={13} />
            {point.sourceFile || point.job || "No source file"}
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

function CommunityFieldNotesSection({ point, company }) {
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  const canShow = !!company?.id
    && !!point?.id
    && ["contributor", "balanced"].includes(point.access_level);

  const load = async () => {
    if (!canShow) return;
    setLoading(true);
    setError("");
    try {
      const rows = await listCommunityPointNotes({
        communityPointId: point.id,
        companyId: company.id,
      });
      setNotes(rows);
    } catch (loadError) {
      setError(loadError.message || "Could not load field notes.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setNotes([]);
    setDraft("");
    setError("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point?.id, company?.id, point?.access_level]);

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    setError("");
    try {
      await addCommunityPointNote({
        communityPointId: point.id,
        companyId: company.id,
        body,
      });
      setDraft("");
      await load();
    } catch (postError) {
      setError(postError.message || "Could not post field note.");
    } finally {
      setPosting(false);
    }
  };

  if (!canShow) return null;

  return (
    <div className="mt-4 rounded-3xl border border-emerald-200 bg-emerald-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-bold text-emerald-950">Community Field Notes</div>
        {loading && <span className="text-xs font-semibold text-emerald-700">Loading...</span>}
      </div>
      <p className="mb-3 text-xs leading-5 text-emerald-800">
        Append-only notes from companies that have shared a point at this location.
      </p>

      <div className="mb-3 space-y-2">
        {notes.length === 0 && !loading && (
          <div className="rounded-2xl bg-white px-3 py-2 text-xs text-slate-500 ring-1 ring-emerald-100">
            No field notes yet. Be the first.
          </div>
        )}
        {notes.map((note) => (
          <div key={note.id} className="rounded-2xl bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-emerald-100">
            <div className="text-xs font-semibold text-emerald-900">
              {note.company_name || "Unknown company"}
              {note.user_email ? ` · ${note.user_email}` : ""}
              {note.created_at ? ` · ${new Date(note.created_at).toLocaleString()}` : ""}
            </div>
            <div className="mt-1 whitespace-pre-wrap leading-6">{note.body}</div>
          </div>
        ))}
      </div>

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Share what you found here. Notes are permanent (no edits, no deletes)."
        className="min-h-20 w-full rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm outline-none focus:border-emerald-500"
        maxLength={4000}
        disabled={posting}
      />
      <Button
        onClick={post}
        disabled={posting || !draft.trim()}
        className="mt-2 w-full rounded-2xl py-5"
      >
        <Save size={16} className="mr-2" /> {posting ? "Posting..." : "Post Field Note"}
      </Button>
      {error && (
        <div className="mt-2 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 ring-1 ring-red-100">
          {error}
        </div>
      )}
    </div>
  );
}

function PointDetail({ point, company, onUpdatePoint, onDeletePoint, canDeletePoints }) {
  const [newNote, setNewNote] = useState("");
  const [newStatus, setNewStatus] = useState(point.status || "found");
  const [observations, setObservations] = useState([]);
  const [observationsLoading, setObservationsLoading] = useState(false);
  const [observationError, setObservationError] = useState("");
  const [savingObservation, setSavingObservation] = useState(false);

  const canPersistObservations = !!point.dbId;

  const loadObservations = async () => {
    if (!canPersistObservations) {
      setObservations([]);
      return;
    }
    setObservationsLoading(true);
    setObservationError("");
    try {
      const rows = await listPointObservations(point.dbId);
      setObservations(rows);
    } catch (error) {
      setObservationError(error?.message || "Could not load observations.");
    } finally {
      setObservationsLoading(false);
    }
  };

  useEffect(() => {
    setNewStatus(point.status || "found");
    setNewNote("");
    loadObservations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.dbId]);

  useEffect(() => {
    setNewStatus(point.status || "found");
  }, [point.status]);

  const addObservation = async () => {
    if (!canPersistObservations) {
      setObservationError("This point isn't saved to the database yet — locally added points can't accept observations until they're imported.");
      return;
    }
    setSavingObservation(true);
    setObservationError("");
    try {
      await addPointObservation({
        companyPointId: point.dbId,
        status: newStatus,
        body: newNote.trim(),
      });
      const today = new Date().toISOString().slice(0, 10);
      onUpdatePoint({
        ...point,
        status: newStatus,
        lastFound: newStatus === "found" ? today : point.lastFound,
      });
      setNewNote("");
      await loadObservations();
    } catch (error) {
      setObservationError(error?.message || "Could not save observation.");
    } finally {
      setSavingObservation(false);
    }
  };

  const openNavigation = () => {
    if (!point.lat || !point.lng) return;
    window.open(`https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`, "_blank");
  };

  const copyCoordinates = async () => {
    const text = `Point: ${point.id}\nLat/Long: ${point.lat}, ${point.lng}\nN/E: ${point.northing}, ${point.easting}\nSystem: ${point.coordinateSystem}\nSource: ${point.sourceFile || point.job || "Unknown"}`;
    await navigator.clipboard?.writeText(text);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected Point</div>
              <h2 className="mt-1 text-2xl font-black text-slate-950">{point.id}</h2>
              <p className="mt-1 text-sm text-slate-600">{point.name}</p>
            </div>
            <ReliabilityBadge rating={point.reliability} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <StatusBadge status={point.status} />
            <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">
              {formatDistance(point.distanceFeet)} away
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">
              Last found {point.lastFound || "unknown"}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-400">Latitude</div>
              <div className="mt-1 font-bold text-slate-900">{point.lat}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-400">Longitude</div>
              <div className="mt-1 font-bold text-slate-900">{point.lng}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-400">Northing</div>
              <div className="mt-1 font-bold text-slate-900">{point.northing}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase text-slate-400">Easting</div>
              <div className="mt-1 font-bold text-slate-900">{point.easting}</div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Description</div>
            <p className="mt-2 text-sm leading-6 text-slate-700">{point.description || "No description"}</p>
            <div className="mt-3 rounded-xl bg-white p-3 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
              Source file: {point.sourceFile || point.job || "Unknown"}
            </div>
            <div className="mt-2 rounded-xl bg-white p-3 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
              Coordinate system: {point.coordinateSystem || "Unknown"}
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Button onClick={openNavigation} className="rounded-2xl py-5">
              <Navigation size={16} className="mr-1" /> Navigate
            </Button>
            <Button onClick={copyCoordinates} variant="secondary" className="rounded-2xl py-5">
              <Database size={16} className="mr-1" /> Copy Coords
            </Button>
            {canDeletePoints && point.dbId && (
              <Button
                onClick={() => onDeletePoint(point)}
                variant="secondary"
                className="rounded-2xl border border-red-200 bg-red-50 py-5 text-red-800 hover:bg-red-100"
              >
                <XCircle size={16} className="mr-1" /> Delete
              </Button>
            )}
          </div>

          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="font-bold text-slate-900">Observations</div>
              {observationsLoading && <span className="text-xs font-semibold text-slate-500">Loading...</span>}
            </div>
            <p className="mb-3 text-xs leading-5 text-slate-500">
              Saved to your company's database, syncs across your phone and PC. Each observation also updates this point's status.
            </p>

            {observations.length > 0 && (
              <div className="mb-3 space-y-2">
                {observations.slice(0, 8).map((obs) => (
                  <div key={obs.id} className="rounded-2xl bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-100">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={obs.status} />
                      <span className="font-semibold text-slate-500">
                        {obs.user_email || "Unknown"} · {obs.created_at ? new Date(obs.created_at).toLocaleString() : ""}
                      </span>
                    </div>
                    {obs.body && <div className="mt-2 whitespace-pre-wrap leading-5">{obs.body}</div>}
                  </div>
                ))}
                {observations.length > 8 && (
                  <div className="rounded-2xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
                    + {observations.length - 8} older observation{observations.length - 8 === 1 ? "" : "s"}
                  </div>
                )}
              </div>
            )}

            <select
              value={newStatus}
              onChange={(event) => setNewStatus(event.target.value)}
              className="mb-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-blue-400"
            >
              <option value="found">Found</option>
              <option value="suspect">Suspect</option>
              <option value="record">Record Only</option>
              <option value="destroyed">Destroyed</option>
            </select>
            <textarea
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
              placeholder="Field note, condition, witness ties, access info... (optional)"
              className="min-h-24 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400"
              maxLength={4000}
            />
            <Button
              onClick={addObservation}
              disabled={savingObservation || !canPersistObservations}
              className="mt-2 w-full rounded-2xl py-5"
            >
              <Save size={16} className="mr-2" />
              {savingObservation ? "Saving..." : "Save Observation"}
            </Button>
            {!canPersistObservations && (
              <div className="mt-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                This point isn't in the database yet — observations save only for points loaded from a company import.
              </div>
            )}
            {observationError && (
              <div className="mt-2 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
                {observationError}
              </div>
            )}
          </div>

          <CommunityFieldNotesSection point={point} company={company} />
        </CardContent>
      </Card>
    </motion.div>
  );
}

function AddPointForm({ onAddPoint, userLocation }) {
  const [draft, setDraft] = useState(blankPoint);

  const set = (key, value) => setDraft((old) => ({ ...old, [key]: value }));

  const useCurrentLocation = () => {
    if (!userLocation) return;
    setDraft((old) => ({ ...old, lat: userLocation.lat, lng: userLocation.lng }));
  };

  const save = () => {
    if (!draft.id.trim()) return;
    const today = new Date().toISOString().slice(0, 10);
    const point = {
      ...draft,
      id: draft.id.trim(),
      name: draft.name.trim() || `${draft.id.trim()} - Field Point`,
      lat: Number(draft.lat) || "",
      lng: Number(draft.lng) || "",
      lastFound: draft.lastFound || today,
      distanceFeet: distanceFeet(userLocation, { lat: Number(draft.lat), lng: Number(draft.lng) }),
      observations: [
        {
          date: draft.lastFound || today,
          crew: draft.crew || "Field Crew",
          status: draft.status,
          note: draft.description || "Point added locally in field.",
          synced: false,
        },
      ],
      photos: [],
    };
    onAddPoint(point);
    setDraft(blankPoint);
  };

  return (
    <Card className="rounded-3xl border-0 shadow-xl">
      <CardContent className="p-5">
        <div className="mb-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Field Entry</div>
          <h2 className="mt-1 text-2xl font-black text-slate-950">Add Local Point</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            This adds a temporary local point to the current screen. Permanent company-backed point saving can be added next.
          </p>
        </div>
        <div className="grid gap-3">
          <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Point ID, e.g. CP-301" value={draft.id} onChange={(e) => set("id", e.target.value)} />
          <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Point name / monument type" value={draft.name} onChange={(e) => set("name", e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Latitude" value={draft.lat} onChange={(e) => set("lat", e.target.value)} />
            <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Longitude" value={draft.lng} onChange={(e) => set("lng", e.target.value)} />
          </div>
          <Button onClick={useCurrentLocation} variant="secondary" className="rounded-2xl py-5" disabled={!userLocation}>
            <LocateFixed size={16} className="mr-2" /> Use Current GPS Location
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Northing" value={draft.northing} onChange={(e) => set("northing", e.target.value)} />
            <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Easting" value={draft.easting} onChange={(e) => set("easting", e.target.value)} />
          </div>
          <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Source file / job" value={draft.sourceFile} onChange={(e) => set("sourceFile", e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <select className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" value={draft.status} onChange={(e) => set("status", e.target.value)}>
              <option value="found">Found</option>
              <option value="suspect">Suspect</option>
              <option value="record">Record Only</option>
              <option value="destroyed">Destroyed</option>
            </select>
            <select className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" value={draft.reliability} onChange={(e) => set("reliability", e.target.value)}>
              <option value="A">Reliability A</option>
              <option value="B">Reliability B</option>
              <option value="C">Reliability C</option>
              <option value="D">Reliability D</option>
              <option value="X">Reliability X</option>
            </select>
          </div>
          <textarea className="min-h-28 rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Description, ties, access notes, condition..." value={draft.description} onChange={(e) => set("description", e.target.value)} />
          <Button onClick={save} className="rounded-2xl py-6 text-base">
            <Plus size={18} className="mr-2" /> Add Point Locally
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyPointState({ pointLoadMessage }) {
  return (
    <Card className="rounded-3xl border border-dashed border-slate-300 bg-white/80 shadow-sm">
      <CardContent className="p-6 text-center">
        <Target className="mx-auto text-slate-400" size={36} />
        <h3 className="mt-3 text-lg font-black text-slate-900">No points loaded yet</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{pointLoadMessage}</p>
      </CardContent>
    </Card>
  );
}

export default function SurveyPointAppPrototype() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeCompany, setActiveCompany] = useState(null);
  const [activeMembership, setActiveMembership] = useState(null);
  const [billing, setBilling] = useState(null);
  const [billingLoaded, setBillingLoaded] = useState(false);

  const [points, setPoints] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [maxDistanceFeet, setMaxDistanceFeet] = useState(() => loadInitialPrefs().radius);
  const [resultLimit, setResultLimit] = useState(500);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [mapCenter, setMapCenter] = useState(null);
  const [flyToTarget, setFlyToTarget] = useState(null);
  const [findingAddress, setFindingAddress] = useState(false);
  const [findMessage, setFindMessage] = useState("");
  const [theme, setTheme] = useState(loadInitialTheme);
  const [defaultCoordEpsg, setDefaultCoordEpsg] = useState(() => loadInitialPrefs().coordEpsg);
  const [defaultCoordName, setDefaultCoordName] = useState(() => loadInitialPrefs().coordName);
  const [pointLoadMessage, setPointLoadMessage] = useState("Tap You Are Here to load nearby company points.");
  const [selectedPointId, setSelectedPointId] = useState(null);
  const [tab, setTab] = useState("map");
  const [userLocation, setUserLocation] = useState(null);
  const [followUser, setFollowUser] = useState(true);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);

  const [locationMessage, setLocationMessage] = useState("Tap You Are Here to use phone GPS.");
  const [gpsWatchId, setGpsWatchId] = useState(null);
  const [basemap, setBasemap] = useState(() => loadInitialPrefs().basemap);
  const [showParcels, setShowParcels] = useState(false);

  useEffect(() => {
    const handler = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const installedHandler = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", installedHandler);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installedHandler);
    };
  }, []);

  const triggerInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } catch (err) { void err; }
    setInstallPrompt(null);
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { window.localStorage.setItem(THEME_KEY, theme); } catch (err) { void err; }
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          basemap,
          radius: maxDistanceFeet,
          coordEpsg: defaultCoordEpsg,
          coordName: defaultCoordName,
        }),
      );
    } catch (err) { void err; }
  }, [basemap, maxDistanceFeet, defaultCoordEpsg, defaultCoordName]);

  const updateDefaultCoord = (epsg, name) => {
    setDefaultCoordEpsg(epsg);
    setDefaultCoordName(name);
  };

  const canDeletePoints = ["owner", "admin"].includes(activeMembership?.role);

  useEffect(() => {
    const lastLocation = loadLastUserLocation();
    if (lastLocation) setUserLocation(lastLocation);
  }, []);

  useEffect(() => {
    if (!activeCompany?.id) {
      setBilling(null);
      setBillingLoaded(false);
      return;
    }
    setBillingLoaded(false);
    fetchCompanyBilling(activeCompany.id)
      .then((snapshot) => {
        setBilling(snapshot);
      })
      .catch((err) => {
        console.error("fetchCompanyBilling failed", err);
        setBilling(null);
      })
      .finally(() => setBillingLoaded(true));
  }, [activeCompany?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success" && activeCompany?.id) {
      fetchCompanyBilling(activeCompany.id)
        .then((snapshot) => setBilling(snapshot))
        .catch(() => {});
    }
  }, [activeCompany?.id]);

  useEffect(() => {
    let mounted = true;

    getCurrentSession()
      .then((nextSession) => {
        if (!mounted) return;
        setSession(nextSession);
        setAuthChecked(true);
      })
      .catch(() => {
        if (!mounted) return;
        setAuthChecked(true);
      });

    const unsubscribe = onAuthChange((nextSession) => {
      setSession(nextSession);
      setAuthChecked(true);
      if (!nextSession) {
        setActiveCompany(null);
        setActiveMembership(null);
        setPoints([]);
      }
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
    };
  }, [gpsWatchId]);

  const pointsWithDistance = useMemo(() => {
    return points.map((point) => ({
      ...point,
      distanceFeet:
        typeof point.distanceFeet === "number" ? point.distanceFeet : distanceFeet(userLocation, point),
    }));
  }, [points, userLocation]);

  const filteredPoints = useMemo(() => {
    return pointsWithDistance
      .filter((point) => status === "all" || point.status === status)
      .filter((point) => {
        const haystack = `${point.id} ${point.name} ${point.job} ${point.sourceFile} ${point.county} ${point.description} ${point.crew}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      })
      .filter((point) => {
        if (!userLocation) return true;
        if (maxDistanceFeet >= 999999999) return true;
        if (point.distanceFeet === null || point.distanceFeet === undefined) return false;
        return point.distanceFeet <= maxDistanceFeet;
      })
      .sort((a, b) => {
        if (a.distanceFeet === null && b.distanceFeet === null) return 0;
        if (a.distanceFeet === null || a.distanceFeet === undefined) return 1;
        if (b.distanceFeet === null || b.distanceFeet === undefined) return -1;
        return a.distanceFeet - b.distanceFeet;
      });
  }, [pointsWithDistance, query, status, maxDistanceFeet, userLocation]);

  const selectedPoint = pointsWithDistance.find((point) => pointKey(point) === selectedPointId) || filteredPoints[0] || null;

  const findOrGeocode = async () => {
    const q = query.trim();
    if (!q) return;
    setFindMessage("");

    const panToFilteredPoints = () => {
      if (filteredPoints.length === 0) return false;
      if (filteredPoints.length === 1) {
        const p = filteredPoints[0];
        setFlyToTarget({ lat: p.lat, lng: p.lng, zoom: 19, key: Date.now() });
      } else {
        const lats = filteredPoints.map((p) => p.lat).filter(Number.isFinite);
        const lngs = filteredPoints.map((p) => p.lng).filter(Number.isFinite);
        if (!lats.length || !lngs.length) return false;
        const bounds = [
          [Math.min(...lats), Math.min(...lngs)],
          [Math.max(...lats), Math.max(...lngs)],
        ];
        setFlyToTarget({ bounds, maxZoom: 18, key: Date.now() });
      }
      setFollowUser(false);
      setTab("map");
      setFindMessage(`Showing ${filteredPoints.length.toLocaleString()} matching point${filteredPoints.length === 1 ? "" : "s"}.`);
      return true;
    };

    const tryGeocode = async () => {
      setFindingAddress(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
        const response = await fetch(url);
        if (!response.ok) {
          setFindMessage(`Address lookup failed: HTTP ${response.status}`);
          return false;
        }
        const results = await response.json();
        if (!Array.isArray(results) || results.length === 0) return false;
        const lat = Number(results[0].lat);
        const lng = Number(results[0].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

        setQuery("");
        setFlyToTarget({ lat, lng, zoom: 17, key: Date.now() });
        setFollowUser(false);
        setTab("map");
        setFindMessage(`Found: ${results[0].display_name}`);

        try {
          await loadNearbyPoints({ lat, lng });
        } catch (loadErr) {
          console.error("loadNearbyPoints error:", loadErr);
        }
        return true;
      } catch (err) {
        console.error("Geocode error:", err);
        setFindMessage(`Address lookup failed: ${err.message || "network error"}`);
        return false;
      } finally {
        setFindingAddress(false);
      }
    };

    const multiWord = q.split(/\s+/).length > 1;

    if (multiWord) {
      if (await tryGeocode()) return;
      if (panToFilteredPoints()) return;
    } else {
      if (panToFilteredPoints()) return;
      if (await tryGeocode()) return;
    }

    setFindMessage("No matching point or address found.");
  };

  const loadNearbyPoints = async (locationOverride = null) => {
    const location = locationOverride || mapCenter || userLocation;

    if (!activeCompany?.id) {
      setPointLoadMessage("Create or join a company before loading database points.");
      return;
    }

    if (!location) {
      setPointLoadMessage("Tap You Are Here or pan the map to pick a location to search around.");
      return;
    }

    setLoadingPoints(true);
    setPointLoadMessage("Loading nearby company points from database...");

    const { data, error } = await fetchNearbyCompanyPoints({
      companyId: activeCompany.id,
      location,
      radiusFeet: maxDistanceFeet,
      resultLimit,
    });

    if (error) {
      console.error(error);
      setPointLoadMessage(error.message || "Could not load nearby company points.");
      setLoadingPoints(false);
      return;
    }

    const mapped = (data || []).map((row) => ({
      id: String(row.point_id || row.id),
      dbId: row.dbId || row.db_id || row.id,
      name: row.name || String(row.point_id || row.id),
      status: row.status || "found",
      reliability: row.reliability || "C",
      lat: row.latitude,
      lng: row.longitude,
      northing: row.northing || "",
      easting: row.easting || "",
      coordinateSystem: row.coordinate_system || "NAD83 / Florida North (ftUS) - EPSG:2238",
      job: row.job || "",
      sourceFile: row.source_file || row.job || "",
      county: row.county || "",
      crew: row.crew || "",
      lastFound: row.last_found || "",
      description: row.description || "",
      distanceFeet: typeof row.distance_feet === "number" ? row.distance_feet : Number(row.distance_feet),
      observations: [],
      photos: [],
    }));

    setPoints(mapped);
    setSelectedPointId(pointKey(mapped[0]) || null);
    setPointLoadMessage(`Loaded ${mapped.length.toLocaleString()} nearby company points from database.`);
    setLoadingPoints(false);
  };

  const acceptGpsPosition = async (position, shouldLoadPoints = false) => {
    const next = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ? position.coords.accuracy * 3.28084 : null,
      timestamp: Date.now(),
    };

    setUserLocation((current) => {
      if (!current) return next;
      if (!next.accuracy) return next;
      if (!current.accuracy) return next;
      return next.accuracy <= current.accuracy + 10 ? next : current;
    });

    localStorage.setItem(USER_LOCATION_KEY, JSON.stringify(next));
    setLocationMessage(`GPS active. Accuracy about ${next.accuracy ? Math.round(next.accuracy).toLocaleString() + " ft" : "unknown"}.`);

    if (shouldLoadPoints) await loadNearbyPoints(next);
  };

  const locateUser = () => {
    if (!navigator.geolocation) {
      setLocationMessage("This browser does not support GPS location.");
      return;
    }

    setLocationMessage("Getting high-accuracy phone GPS location...");

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await acceptGpsPosition(position, true);
      },
      (error) => {
        setLocationMessage(error.message || "GPS permission denied or unavailable.");
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      },
    );
  };

  const startGpsWatch = () => {
    if (!navigator.geolocation) {
      setLocationMessage("This browser does not support GPS location.");
      return;
    }

    if (gpsWatchId) {
      navigator.geolocation.clearWatch(gpsWatchId);
      setGpsWatchId(null);
      setLocationMessage("GPS tracking stopped.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => acceptGpsPosition(position, false),
      (error) => setLocationMessage(error.message || "GPS tracking unavailable."),
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000,
      },
    );

    setGpsWatchId(watchId);
    setLocationMessage("Live GPS tracking started.");
  };

  const updatePoint = (updatedPoint) => {
    setPoints((current) => current.map((point) => (pointKey(point) === pointKey(updatedPoint) ? updatedPoint : point)));
  };

  const addPoint = (point) => {
    setPoints((current) => [point, ...current]);
    setSelectedPointId(pointKey(point));
    setTab("detail");
  };

  const selectPoint = (point) => {
    setSelectedPointId(pointKey(point));
    setTab("detail");
  };

  const deleteCompanyPoint = async (point) => {
    if (!point?.dbId) {
      setPointLoadMessage("Only database points can be deleted.");
      return;
    }

    if (!canDeletePoints) {
      setPointLoadMessage("Only company owners and admins can delete points.");
      return;
    }

    const confirmed = window.confirm(
      `Delete point ${point.id}? This removes it from the company point database.`,
    );

    if (!confirmed) return;

    const { error } = await deleteCompanyPointRpc(point.dbId);

    if (error) {
      setPointLoadMessage(error.message || "Could not delete point.");
      return;
    }

    setPoints((current) => current.filter((existing) => pointKey(existing) !== pointKey(point)));
    setSelectedPointId(null);
    setPointLoadMessage(`Deleted point ${point.id}.`);
  };

  const cleanupDuplicateCompanyPoints = async () => {
    if (!activeCompany?.id) return;

    if (!canDeletePoints) {
      setPointLoadMessage("Only company owners and admins can clean duplicate points.");
      return;
    }

    const confirmed = window.confirm(
      "Clean duplicate company points within 1 foot? The oldest point in each duplicate group will be kept.",
    );

    if (!confirmed) return;

    const { data, error } = await cleanupCompanyDuplicatePoints(activeCompany.id, 1.0);

    if (error) {
      setPointLoadMessage(error.message || "Could not clean duplicate points.");
      return;
    }

    const deletedCount = Number(data?.deleted_duplicate_points || 0);
    setPointLoadMessage(`Cleaned ${deletedCount.toLocaleString()} duplicate company points.`);

    if (userLocation) {
      await loadNearbyPoints();
    }
  };

  const signOut = async () => {
    const { supabase } = await import("@/lib/supabaseClient");
    await supabase.auth.signOut();
    setSession(null);
    setActiveCompany(null);
    setActiveMembership(null);
    setPoints([]);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-100 p-8 text-sm font-medium text-slate-600">
        Loading PointVault...
      </div>
    );
  }

  if (!session) {
    return <SignInPanel />;
  }

  if (!activeCompany) {
    return (
      <CompanySetupPanel
        session={session}
        onReady={(company, membership) => {
          setActiveCompany(company);
          setActiveMembership(membership);
        }}
      />
    );
  }

  if (billingLoaded && billing && billing.has_access === false) {
    return <TrialEndedGate company={activeCompany} membership={activeMembership} billing={billing} />;
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-2 md:gap-3 md:px-4 md:py-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg md:h-10 md:w-10">
              <MapPin size={18} className="md:hidden" />
              <MapPin size={20} className="hidden md:block" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-black tracking-tight md:text-2xl">PointVault</h1>
              <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 md:text-xs">
                {activeCompany.name} · {activeMembership?.role || "member"}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <GpsFreshness userLocation={userLocation} />

            {/* Desktop: full button row */}
            <div className="hidden md:flex md:flex-wrap md:items-center md:gap-2">
              <Button onClick={locateUser} className="rounded-2xl px-4 py-3">
                <LocateFixed size={16} className="mr-2" /> You Are Here
              </Button>
              <Button onClick={startGpsWatch} variant="secondary" className="rounded-2xl px-4 py-3">
                <RefreshCw size={16} className="mr-2" /> {gpsWatchId ? "Stop GPS" : "Track GPS"}
              </Button>
              <Button onClick={() => loadNearbyPoints()} variant="secondary" className="rounded-2xl px-4 py-3" disabled={loadingPoints || (!userLocation && !mapCenter)}>
                <Database size={16} className="mr-2" /> {loadingPoints ? "Loading..." : "Load Points"}
              </Button>
              {canDeletePoints && (
                <Button onClick={cleanupDuplicateCompanyPoints} variant="secondary" className="rounded-2xl px-4 py-3">
                  <XCircle size={16} className="mr-2" /> Cleanup Duplicates
                </Button>
              )}
              {installPrompt && (
                <Button onClick={triggerInstall} variant="secondary" className="rounded-2xl px-4 py-3">
                  <Download size={16} className="mr-2" /> Install App
                </Button>
              )}
              <Button onClick={signOut} variant="secondary" className="rounded-2xl px-4 py-3">
                Sign Out
              </Button>
            </div>

            {/* Mobile: search icon + hamburger */}
            <button
              onClick={() => setMobileSearchOpen((v) => !v)}
              className="rounded-2xl bg-slate-100 p-2 text-slate-700 md:hidden"
              aria-label="Toggle search"
            >
              <Search size={18} />
            </button>
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-2xl bg-slate-950 p-2 text-white md:hidden"
              aria-label="Open menu"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>

        {/* Mobile slide-down search panel */}
        {mobileSearchOpen && (
          <div className="border-t border-slate-200 bg-white p-3 md:hidden">
            <div className="grid gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { findOrGeocode(); setMobileSearchOpen(false); } }}
                  placeholder="Point ID, job, OR address — press Enter"
                  className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm outline-none focus:border-blue-400"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  onClick={() => { findOrGeocode(); setMobileSearchOpen(false); }}
                  disabled={findingAddress || !query.trim()}
                  className="rounded-2xl px-3 py-2 text-xs"
                >
                  <MapPin size={14} className="mr-1" /> Find
                </Button>
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"
                >
                  <option value="all">All Statuses</option>
                  <option value="found">Found</option>
                  <option value="suspect">Suspect</option>
                  <option value="record">Record Only</option>
                  <option value="destroyed">Destroyed</option>
                </select>
                <select
                  value={maxDistanceFeet}
                  onChange={(event) => setMaxDistanceFeet(Number(event.target.value))}
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"
                >
                  <option value={1000}>1,000 ft</option>
                  <option value={5280}>1 mile</option>
                  <option value={26400}>5 miles</option>
                  <option value={999999999}>No limit</option>
                </select>
              </div>
              {findMessage && (
                <div className="text-xs font-semibold text-slate-700">{findMessage}</div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Mobile slide-in menu overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[60] md:hidden" onClick={() => setMobileMenuOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute right-0 top-0 h-full w-72 bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="font-bold text-slate-950">Menu</div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-xl bg-slate-100 p-2 text-slate-700"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mt-4 grid gap-2">
              <Button onClick={() => { locateUser(); setMobileMenuOpen(false); }} className="w-full rounded-2xl py-3">
                <LocateFixed size={16} className="mr-2" /> You Are Here
              </Button>
              <Button onClick={() => { startGpsWatch(); setMobileMenuOpen(false); }} variant="secondary" className="w-full rounded-2xl py-3">
                <RefreshCw size={16} className="mr-2" /> {gpsWatchId ? "Stop GPS" : "Track GPS"}
              </Button>
              <Button
                onClick={() => { loadNearbyPoints(); setMobileMenuOpen(false); }}
                variant="secondary"
                className="w-full rounded-2xl py-3"
                disabled={loadingPoints || (!userLocation && !mapCenter)}
              >
                <Database size={16} className="mr-2" /> {loadingPoints ? "Loading..." : "Load Points"}
              </Button>
              {installPrompt && (
                <Button onClick={() => { triggerInstall(); setMobileMenuOpen(false); }} variant="secondary" className="w-full rounded-2xl py-3">
                  <Download size={16} className="mr-2" /> Install App
                </Button>
              )}
              <div className="my-2 h-px bg-slate-200" />
              <Button onClick={signOut} variant="secondary" className="w-full rounded-2xl py-3">
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[1fr_380px]">
        <section className="space-y-4">
          <Card className="hidden rounded-3xl border-0 shadow-sm md:block">
            <CardContent className="p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-center">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") findOrGeocode(); }}
                    placeholder="Point ID, job, source file, OR an address — press Enter to find"
                    className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm outline-none focus:border-blue-400"
                  />
                </div>
                <Button
                  onClick={findOrGeocode}
                  className="rounded-2xl px-4 py-3"
                  disabled={findingAddress || !query.trim()}
                >
                  <MapPin size={16} className="mr-2" /> {findingAddress ? "Finding..." : "Find"}
                </Button>
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400"
                >
                  <option value="all">All Statuses</option>
                  <option value="found">Found</option>
                  <option value="suspect">Suspect</option>
                  <option value="record">Record Only</option>
                  <option value="destroyed">Destroyed</option>
                </select>
                <select
                  value={maxDistanceFeet}
                  onChange={(event) => setMaxDistanceFeet(Number(event.target.value))}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400"
                >
                  <option value={1000}>Within 1,000 ft</option>
                  <option value={5280}>Within 1 mile</option>
                  <option value={26400}>Within 5 miles</option>
                  <option value={999999999}>No distance limit</option>
                </select>
                <select
                  value={resultLimit}
                  onChange={(event) => setResultLimit(Number(event.target.value))}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400"
                >
                  <option value={100}>100 results</option>
                  <option value={500}>500 results</option>
                  <option value={1000}>1,000 results</option>
                  <option value={5000}>5,000 results</option>
                </select>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
                <div className="flex flex-wrap items-center gap-2">
                  <WifiOff size={15} />
                  <span>{locationMessage}</span>
                  <GpsFreshness userLocation={userLocation} />
                </div>
                <div className="font-semibold">
                  Showing {filteredPoints.length.toLocaleString()} of {points.length.toLocaleString()} loaded points
                </div>
                {findMessage && (
                  <div className="w-full text-xs font-semibold text-slate-700">{findMessage}</div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Mobile: backdrop when nav is open */}
          {mobileNavOpen && (
            <div
              className="fixed inset-0 z-20 bg-black/50 md:hidden"
              onClick={() => setMobileNavOpen(false)}
            />
          )}

          {/* Mobile: page dropdown */}
          <Card className="relative z-30 rounded-3xl border-0 shadow-sm md:hidden">
            <CardContent className="p-3">
              <button
                onClick={() => setMobileNavOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-2xl bg-slate-950 px-4 py-3 text-left text-sm font-bold text-white"
              >
                <span className="flex items-center gap-2">
                  {tab === "map" && <><Map size={16} /> Map</>}
                  {tab === "list" && <><List size={16} /> List</>}
                  {tab === "detail" && <><Target size={16} /> Detail</>}
                  {tab === "add" && <><Plus size={16} /> Add Local</>}
                  {tab === "import" && <><Upload size={16} /> Data Import</>}
                  {tab === "billing" && <><CreditCard size={16} /> Billing</>}
                  {tab === "team" && <><Users size={16} /> Team</>}
                  {tab === "invite" && <><Send size={16} /> Invite</>}
                  {tab === "settings" && <><SettingsIcon size={16} /> Settings</>}
                </span>
                <ChevronDown size={18} className={mobileNavOpen ? "rotate-180 transition" : "transition"} />
              </button>
              {mobileNavOpen && (
                <div className="mt-2 grid gap-1 rounded-2xl bg-slate-100 p-2 dark:bg-slate-900">
                  {[
                    { id: "map", label: "Map", icon: Map },
                    { id: "list", label: "List", icon: List },
                    { id: "detail", label: "Detail", icon: Target, disabled: !selectedPoint },
                    { id: "add", label: "Add Local", icon: Plus },
                    { id: "import", label: "Data Import", icon: Upload },
                    { id: "billing", label: "Billing", icon: CreditCard },
                    { id: "team", label: "Team", icon: Users },
                    { id: "invite", label: "Invite", icon: Send },
                    { id: "settings", label: "Settings", icon: SettingsIcon },
                  ].map((option) => {
                    const Icon = option.icon;
                    const active = tab === option.id;
                    let cls;
                    if (active) {
                      cls = "bg-blue-600 text-white dark:bg-blue-500";
                    } else if (option.disabled) {
                      cls = "cursor-not-allowed bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-600";
                    } else {
                      cls = "bg-white text-slate-900 hover:bg-blue-50 dark:bg-slate-700 dark:text-white dark:hover:bg-slate-600";
                    }
                    return (
                      <button
                        key={option.id}
                        disabled={option.disabled}
                        onClick={() => { setTab(option.id); setMobileNavOpen(false); }}
                        className={`flex items-center gap-2 rounded-xl px-3 py-3 text-left text-sm font-semibold ${cls}`}
                      >
                        <Icon size={16} /> {option.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Desktop: full button row */}
          <Card className="hidden rounded-3xl border-0 shadow-sm md:block">
            <CardContent className="flex flex-wrap gap-2 p-3">
              <Button onClick={() => setTab("map")} variant={tab === "map" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <Map size={16} className="mr-2" /> Map
              </Button>
              <Button onClick={() => setTab("list")} variant={tab === "list" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <List size={16} className="mr-2" /> List
              </Button>
              <Button onClick={() => setTab("detail")} variant={tab === "detail" ? "default" : "secondary"} className="rounded-2xl px-4 py-3" disabled={!selectedPoint}>
                <Target size={16} className="mr-2" /> Detail
              </Button>
              <Button onClick={() => setTab("add")} variant={tab === "add" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <Plus size={16} className="mr-2" /> Add Local
              </Button>
              <Button onClick={() => setTab("import")} variant={tab === "import" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <Upload size={16} className="mr-2" /> Data Import
              </Button>
              <Button onClick={() => setTab("billing")} variant={tab === "billing" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <CreditCard size={16} className="mr-2" /> Billing
              </Button>
              <Button onClick={() => setTab("team")} variant={tab === "team" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <Users size={16} className="mr-2" /> Team
              </Button>
              <Button onClick={() => setTab("invite")} variant={tab === "invite" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <Send size={16} className="mr-2" /> Invite
              </Button>
              <Button onClick={() => setTab("settings")} variant={tab === "settings" ? "default" : "secondary"} className="rounded-2xl px-4 py-3">
                <SettingsIcon size={16} className="mr-2" /> Settings
              </Button>
            </CardContent>
          </Card>

          {tab === "map" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={locateUser} className="rounded-2xl px-4 py-3">
                  <LocateFixed size={16} className="mr-2" /> You Are Here
                </Button>
                <Button
                  onClick={() => loadNearbyPoints(mapCenter)}
                  className="rounded-2xl px-4 py-3"
                  disabled={loadingPoints || !mapCenter || !activeCompany?.id}
                >
                  <Search size={16} className="mr-2" /> Search This Area
                </Button>
                <Button
                  onClick={() => setLayersOpen((v) => !v)}
                  variant="secondary"
                  className="rounded-2xl px-4 py-3"
                >
                  <Layers size={16} className="mr-2" /> Layers
                  <ChevronDown size={14} className={`ml-2 ${layersOpen ? "rotate-180" : ""} transition`} />
                </Button>
              </div>

              {layersOpen && (
                <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Basemap</div>
                  <div className="grid grid-cols-2 gap-1 md:grid-cols-5">
                    {[
                      { id: "aerial", label: "Aerial", icon: Satellite },
                      { id: "hybrid", label: "Hybrid", icon: Layers },
                      { id: "streets", label: "Streets", icon: Map },
                      { id: "topo", label: "Topo", icon: Layers },
                      { id: "usgs", label: "USGS Hi-Res", icon: Satellite },
                    ].map((option) => {
                      const Icon = option.icon;
                      const active = basemap === option.id;
                      return (
                        <button
                          key={option.id}
                          onClick={() => setBasemap(option.id)}
                          className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                            active ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-800 hover:bg-slate-100"
                          }`}
                        >
                          <Icon size={14} /> {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 h-px bg-slate-200" />
                  <div className="mt-3 mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Overlays & GPS</div>
                  <div className="grid grid-cols-2 gap-1 md:grid-cols-3">
                    <button
                      onClick={() => setShowParcels((v) => !v)}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                        showParcels ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-800 hover:bg-slate-100"
                      }`}
                    >
                      <span className="flex items-center gap-2"><Filter size={14} /> Parcels</span>
                      <span className="text-xs">{showParcels ? "on" : "off"}</span>
                    </button>
                    <button
                      onClick={() => setFollowUser((v) => !v)}
                      disabled={!userLocation}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                        !userLocation
                          ? "cursor-not-allowed bg-slate-100 text-slate-400"
                          : followUser
                            ? "bg-slate-950 text-white"
                            : "bg-slate-50 text-slate-800 hover:bg-slate-100"
                      }`}
                    >
                      <span className="flex items-center gap-2"><LocateFixed size={14} /> Follow GPS</span>
                      <span className="text-xs">{followUser ? "on" : "off"}</span>
                    </button>
                    {!followUser && userLocation && (
                      <button
                        onClick={() => setFollowUser(true)}
                        className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-800 hover:bg-slate-100"
                      >
                        <Target size={14} /> Recenter
                      </button>
                    )}
                  </div>
                </div>
              )}
              <GisMap
                points={filteredPoints}
                selectedPoint={selectedPoint}
                userLocation={userLocation}
                followUser={followUser}
                onUserPan={() => { if (followUser) setFollowUser(false); }}
                onMapCenterChange={setMapCenter}
                flyToTarget={flyToTarget}
                onSelectPoint={selectPoint}
                basemap={basemap}
                showParcels={showParcels}
              />
            </div>
          )}

          {tab === "list" && (
            <div className="grid gap-3 md:grid-cols-2">
              {filteredPoints.length === 0 && <EmptyPointState pointLoadMessage={pointLoadMessage} />}
              {filteredPoints.map((point) => (
                <PointCard key={`${pointKey(point)}-card`} point={point} selected={pointKey(selectedPoint) === pointKey(point)} onClick={selectPoint} />
              ))}
            </div>
          )}

          {tab === "detail" && (
            <div>
              {selectedPoint ? (
                <PointDetail
                  point={selectedPoint}
                  company={activeCompany}
                  onUpdatePoint={updatePoint}
                  onDeletePoint={deleteCompanyPoint}
                  canDeletePoints={canDeletePoints}
                />
              ) : (
                <EmptyPointState pointLoadMessage={pointLoadMessage} />
              )}
            </div>
          )}

          {tab === "add" && <AddPointForm onAddPoint={addPoint} userLocation={userLocation} />}

          {tab === "import" && (
            <DataImportPanel
              company={activeCompany}
              membership={activeMembership}
              onImportPromoted={() => loadNearbyPoints()}
              defaultEpsg={defaultCoordEpsg}
              defaultCoordinateSystem={defaultCoordName}
            />
          )}

          {tab === "billing" && (
            <BillingPanel company={activeCompany} canAdmin={canDeletePoints} />
          )}

          {tab === "team" && (
            <TeamPanel company={activeCompany} membership={activeMembership} />
          )}

          {tab === "invite" && (
            <InvitePanel company={activeCompany} membership={activeMembership} />
          )}

          {tab === "settings" && (
            <SettingsTab
              theme={theme}
              onThemeChange={setTheme}
              defaultBasemap={basemap}
              onDefaultBasemapChange={setBasemap}
              defaultRadius={maxDistanceFeet}
              onDefaultRadiusChange={setMaxDistanceFeet}
              defaultCoordEpsg={defaultCoordEpsg}
              onDefaultCoordChange={updateDefaultCoord}
              session={session}
            />
          )}
        </section>

        <aside className="space-y-4">
          <Card className="rounded-3xl border-0 shadow-xl">
            <CardContent className="p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Field Status</div>
              <h2 className="mt-1 text-2xl font-black text-slate-950">Nearby Work</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{pointLoadMessage}</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase text-slate-400">Loaded</div>
                  <div className="mt-1 text-2xl font-black">{points.length.toLocaleString()}</div>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase text-slate-400">Visible</div>
                  <div className="mt-1 text-2xl font-black">{filteredPoints.length.toLocaleString()}</div>
                </div>
              </div>
              <Button onClick={() => loadNearbyPoints()} className="mt-4 w-full rounded-2xl py-5" disabled={loadingPoints || (!userLocation && !mapCenter)}>
                <Upload size={16} className="mr-2" /> Reload Company Points
              </Button>
              {canDeletePoints && (
                <Button onClick={cleanupDuplicateCompanyPoints} variant="secondary" className="mt-2 w-full rounded-2xl py-5">
                  <XCircle size={16} className="mr-2" /> Cleanup Duplicate Points
                </Button>
              )}
            </CardContent>
          </Card>

          {selectedPoint ? (
            <PointDetail
              point={selectedPoint}
              company={activeCompany}
              onUpdatePoint={updatePoint}
              onDeletePoint={deleteCompanyPoint}
              canDeletePoints={canDeletePoints}
            />
          ) : (
            <EmptyPointState pointLoadMessage={pointLoadMessage} />
          )}
        </aside>
      </main>
    </div>
  );
}
