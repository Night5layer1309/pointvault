import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  MapPin,
  Plus,
  Navigation,
  Filter,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Database,
  Layers,
  Download,
  Upload,
  Save,
  List,
  Map,
  LocateFixed,
  RefreshCw,
  Satellite,
  Target,
} from "lucide-react";
import { motion } from "framer-motion";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabaseClient";

const USER_LOCATION_KEY = "pointvault-last-user-location-v1";

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

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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
  useEffect(() => {
    if (center) map.setView(center, zoom || map.getZoom(), { animate: true });
  }, [center, zoom, map]);
  return null;
}

function GisMap({ points, selectedPoint, userLocation, followUser, onSelectPoint, basemap }) {
  const fallbackCenter = [30.7, -86.1];
  const center = userLocation ? [userLocation.lat, userLocation.lng] : fallbackCenter;

  const basemaps = {
    streets: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "&copy; OpenStreetMap contributors",
    },
    topo: {
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
    },
    aerial: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  };

  const selectedBasemap = basemaps[basemap] || basemaps.aerial;

  return (
    <Card className="overflow-hidden rounded-3xl border-0 shadow-lg">
      <CardContent className="relative h-[420px] p-0">
        <MapContainer center={center} zoom={userLocation ? 15 : 8} className="h-full w-full" scrollWheelZoom>
          <TileLayer
            attribution={selectedBasemap.attribution}
            url={selectedBasemap.url}
          />
          {followUser && userLocation && <RecenterMap center={[userLocation.lat, userLocation.lng]} zoom={16} />}
          {userLocation && (
            <Marker position={[userLocation.lat, userLocation.lng]} icon={userIcon}>
              <Popup>
                <strong>You are here</strong><br />
                Accuracy: {userLocation.accuracy ? Math.round(userLocation.accuracy) + " ft" : "unknown"}<br />
                GPS age: {userLocation.timestamp ? Math.round((Date.now() - userLocation.timestamp) / 1000) + " sec" : "unknown"}
              </Popup>
            </Marker>
          )}
          {points.map((point) => {
            if (!point.lat || !point.lng) return null;
            const selected = selectedPoint?.id === point.id;
            return (
              <Marker
                key={`${point.dbId || point.id}-${point.lat}-${point.lng}`}
                position={[Number(point.lat), Number(point.lng)]}
                icon={pointIcon(point.status, selected)}
                eventHandlers={{ click: () => onSelectPoint(point) }}
              >
                <Popup>
                  <div className="min-w-48">
                    <strong>{point.id}</strong><br />
                    {point.description || point.name}<br />
                    <span>{formatDistance(point.distanceFeet)} away</span><br />
                    <span>{point.sourceFile || point.job || "No source file"}</span>
                  </div>
                </Popup>
              </Marker>
            );
          })}
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

function PointDetail({ point, onUpdatePoint }) {
  const [newNote, setNewNote] = useState("");
  const [newStatus, setNewStatus] = useState(point.status || "found");

  useEffect(() => {
    setNewStatus(point.status || "found");
    setNewNote("");
  }, [point.id, point.status]);

  const addObservation = () => {
    if (!newNote.trim()) return;
    const today = new Date().toISOString().slice(0, 10);
    const observation = {
      date: today,
      crew: point.crew || "Field Crew",
      status: newStatus,
      note: newNote.trim(),
      synced: false,
    };
    onUpdatePoint({
      ...point,
      status: newStatus,
      lastFound: newStatus === "found" ? today : point.lastFound,
      observations: [observation, ...(point.observations || [])],
    });
    setNewNote("");
  };

  const openNavigation = () => {
    if (!point.lat || !point.lng) return;
    window.open(`https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`, "_blank");
  };

  const copyCoordinates = async () => {
    const text = `Point: ${point.id}
Lat/Long: ${point.lat}, ${point.lng}
N/E: ${point.northing}, ${point.easting}
System: ${point.coordinateSystem}
Source: ${point.sourceFile || point.job || "Unknown"}`;
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

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button onClick={openNavigation} className="rounded-2xl py-5">
              <Navigation size={16} className="mr-1" /> Navigate
            </Button>
            <Button onClick={copyCoordinates} variant="secondary" className="rounded-2xl py-5">
              <Database size={16} className="mr-1" /> Copy Coords
            </Button>
          </div>

          <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-3">
            <div className="mb-2 font-bold text-slate-900">Add Local Observation</div>
            <p className="mb-3 text-xs leading-5 text-slate-500">
              This saves only in the current screen for now. Database-backed observation sync can be added after the point loading is confirmed.
            </p>
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
              placeholder="Add field note, condition, witness ties, access info..."
              className="min-h-24 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400"
            />
            <Button onClick={addObservation} className="mt-2 w-full rounded-2xl py-5">
              <Save size={16} className="mr-2" /> Save Local Observation
            </Button>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="font-bold text-slate-900">Observation History</div>
              <span className="text-xs text-slate-500">{point.photos?.length || 0} photos</span>
            </div>
            <div className="space-y-2">
              {(point.observations || []).length === 0 && (
                <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500 ring-1 ring-slate-100">
                  No observations loaded yet.
                </div>
              )}
              {(point.observations || []).map((obs, index) => (
                <div key={index} className={`rounded-2xl p-3 text-sm ring-1 ${obs.synced ? "bg-white text-slate-700 ring-slate-100" : "bg-blue-50 text-blue-950 ring-blue-100"}`}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-500">{obs.date} · {obs.crew}</div>
                    {!obs.synced && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">LOCAL</span>}
                  </div>
                  <div className="mb-1"><StatusBadge status={obs.status} /></div>
                  {obs.note}
                </div>
              ))}
            </div>
          </div>
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
            This adds a temporary local point to the current screen. Use Supabase import for permanent batch data.
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

export default function SurveyPointAppPrototype() {
  const [points, setPoints] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [maxDistanceFeet, setMaxDistanceFeet] = useState(5280);
  const [resultLimit, setResultLimit] = useState(500);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [pointLoadMessage, setPointLoadMessage] = useState("Tap You Are Here to load nearby database points.");
  const [selectedPointId, setSelectedPointId] = useState(null);
  const [tab, setTab] = useState("map");
  const [userLocation, setUserLocation] = useState(null);
  const [followUser, setFollowUser] = useState(true);
  const [locationMessage, setLocationMessage] = useState("Tap You Are Here to use phone GPS.");
  const [gpsWatchId, setGpsWatchId] = useState(null);
  const [basemap, setBasemap] = useState("aerial");

  useEffect(() => {
    setPoints([]);
    const lastLocation = loadLastUserLocation();
    if (lastLocation) setUserLocation(lastLocation);
  }, []);

  const pointsWithDistance = useMemo(() => {
    return points.map((point) => ({
      ...point,
      distanceFeet:
        typeof point.distanceFeet === "number"
          ? point.distanceFeet
          : distanceFeet(userLocation, point),
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

  const selectedPoint = pointsWithDistance.find((point) => point.id === selectedPointId) || filteredPoints[0] || null;

  const loadNearbyPoints = async (locationOverride = userLocation) => {
    const location = locationOverride;

    if (!location) {
      setPointLoadMessage("Tap You Are Here first so the app has your GPS location.");
      return;
    }

    setLoadingPoints(true);
    setPointLoadMessage("Loading nearby points from database...");

    const { data, error } = await supabase.rpc("nearby_points", {
      user_lat: location.lat,
      user_lng: location.lng,
      radius_feet: maxDistanceFeet,
      result_limit: resultLimit,
    });

    if (error) {
      console.error(error);
      setPointLoadMessage(error.message || "Could not load nearby points.");
      setLoadingPoints(false);
      return;
    }

    const mapped = (data || []).map((row) => ({
      id: String(row.point_id || row.id),
      dbId: row.id,
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
    setSelectedPointId(mapped[0]?.id || null);
    setPointLoadMessage(`Loaded ${mapped.length.toLocaleString()} nearby points from database.`);
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

    setFollowUser(true);
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
      }
    );
  };

  const startGpsWatch = () => {
    if (!navigator.geolocation) {
      setLocationMessage("This browser does not support GPS location.");
      return;
    }

    if (gpsWatchId !== null) {
      navigator.geolocation.clearWatch(gpsWatchId);
      setGpsWatchId(null);
      setLocationMessage("Live GPS stopped.");
      return;
    }

    setLocationMessage("Starting live high-accuracy GPS...");

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        acceptGpsPosition(position, false);
      },
      (error) => {
        setLocationMessage(error.message || "Live GPS unavailable.");
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      }
    );

    setGpsWatchId(watchId);
  };

  useEffect(() => {
    return () => {
      if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    };
  }, [gpsWatchId]);

  const updatePoint = (updated) => {
    const { distanceFeet: _distanceFeet, ...clean } = updated;
    setPoints((old) => old.map((point) => (point.id === clean.id ? { ...clean, distanceFeet: updated.distanceFeet } : point)));
  };

  const addPoint = (point) => {
    setPoints((old) => [point, ...old.filter((existing) => existing.id !== point.id)]);
    setSelectedPointId(point.id);
    setTab("detail");
  };

  const importJson = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed)) {
          setPoints(parsed);
          setPointLoadMessage(`Imported ${parsed.length.toLocaleString()} local JSON points. This does not write to Supabase.`);
        }
      } catch {
        alert("Could not import JSON. Use the same format as exported from PointVault.");
      }
    };
    reader.readAsText(file);
  };

  const clearScreenPoints = () => {
    setPoints([]);
    setSelectedPointId(null);
    setPointLoadMessage("Cleared screen points. Tap You Are Here or Reload to load from Supabase.");
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto max-w-md pb-24">
        <header className="sticky top-0 z-20 border-b border-white/70 bg-slate-100/90 px-4 py-4 backdrop-blur">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Layers size={14} /> Field GIS
              </div>
              <h1 className="mt-1 text-2xl font-black tracking-tight">PointVault</h1>
            </div>
            <div className="flex items-center gap-1 rounded-full bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
              <WifiOff size={14} /> Supabase
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search point, file, description..."
                className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-3 text-sm shadow-sm outline-none focus:border-blue-400"
              />
            </div>
            <div className="relative">
              <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="h-full appearance-none rounded-2xl border border-slate-200 bg-white py-3 pl-9 pr-8 text-sm font-semibold shadow-sm outline-none focus:border-blue-400"
              >
                <option value="all">All</option>
                <option value="found">Found</option>
                <option value="suspect">Suspect</option>
                <option value="record">Record</option>
                <option value="destroyed">Destroyed</option>
              </select>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <select
              value={maxDistanceFeet}
              onChange={(event) => setMaxDistanceFeet(Number(event.target.value))}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold shadow-sm outline-none focus:border-blue-400"
            >
              <option value={500}>Within 500 ft</option>
              <option value={1000}>Within 1,000 ft</option>
              <option value={2640}>Within 1/2 mile</option>
              <option value={5280}>Within 1 mile</option>
              <option value={15840}>Within 3 miles</option>
              <option value={26400}>Within 5 miles</option>
              <option value={52800}>Within 10 miles</option>
              <option value={999999999}>No distance limit</option>
            </select>
            <Button onClick={locateUser} className="rounded-2xl px-4">
              <LocateFixed size={17} className="mr-1" /> You Are Here
            </Button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={basemap}
              onChange={(event) => setBasemap(event.target.value)}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold shadow-sm outline-none focus:border-blue-400"
            >
              <option value="aerial">Aerial imagery</option>
              <option value="streets">Street map</option>
              <option value="topo">Topo map</option>
            </select>
            <Button onClick={startGpsWatch} variant="secondary" className="rounded-2xl px-4">
              {gpsWatchId === null ? <><Target size={16} className="mr-1" /> Live GPS</> : "Stop GPS"}
            </Button>
          </div>

          <div className="mt-2 text-xs font-medium text-slate-500">{locationMessage}</div>

          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
            <select
              value={resultLimit}
              onChange={(event) => setResultLimit(Number(event.target.value))}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold shadow-sm outline-none focus:border-blue-400"
            >
              <option value={100}>Show max 100 points</option>
              <option value={250}>Show max 250 points</option>
              <option value={500}>Show max 500 points</option>
              <option value={1000}>Show max 1,000 points</option>
              <option value={2500}>Show max 2,500 points</option>
            </select>
            <Button
              onClick={() => loadNearbyPoints()}
              disabled={loadingPoints || !userLocation}
              variant="secondary"
              className="rounded-2xl px-4"
            >
              {loadingPoints ? "Loading..." : <><RefreshCw size={16} className="mr-1" /> Reload</>}
            </Button>
          </div>
          <div className="mt-2 text-xs font-medium text-slate-500">{pointLoadMessage}</div>
        </header>

        <main className="space-y-4 px-4 pt-4">
          {tab === "map" && (
            <>
              <GisMap
                points={filteredPoints}
                selectedPoint={selectedPoint}
                userLocation={userLocation}
                followUser={followUser}
                basemap={basemap}
                onSelectPoint={(point) => { setSelectedPointId(point.id); setTab("detail"); }}
              />
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <h2 className="font-bold text-slate-900">Nearest Points</h2>
                  <span className="text-xs font-semibold text-slate-500">{filteredPoints.length} shown</span>
                </div>
                {filteredPoints.length === 0 ? (
                  <Card className="rounded-3xl border-0 shadow-sm">
                    <CardContent className="p-5 text-sm leading-6 text-slate-600">
                      No points loaded. Tap <strong>You Are Here</strong>, allow GPS, then use <strong>Reload</strong>. For first testing, use <strong>No distance limit</strong> and max 100 points.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {filteredPoints.map((point) => (
                      <PointCard
                        key={`${point.dbId || point.id}-${point.lat}-${point.lng}`}
                        point={point}
                        selected={point.id === selectedPoint?.id}
                        onClick={(clicked) => { setSelectedPointId(clicked.id); setTab("detail"); }}
                      />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {tab === "list" && (
            <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="font-bold text-slate-900">Points by Distance</h2>
                <span className="text-xs font-semibold text-slate-500">{filteredPoints.length} shown</span>
              </div>
              <div className="space-y-3">
                {filteredPoints.map((point) => (
                  <PointCard
                    key={`${point.dbId || point.id}-${point.lat}-${point.lng}`}
                    point={point}
                    selected={point.id === selectedPoint?.id}
                    onClick={(clicked) => { setSelectedPointId(clicked.id); setTab("detail"); }}
                  />
                ))}
              </div>
            </section>
          )}

          {tab === "detail" && selectedPoint && <PointDetail point={selectedPoint} onUpdatePoint={updatePoint} />}
          {tab === "detail" && !selectedPoint && (
            <Card className="rounded-3xl border-0 shadow-sm">
              <CardContent className="p-5 text-sm leading-6 text-slate-600">
                No point selected yet. Load points from Supabase, then tap a point.
              </CardContent>
            </Card>
          )}
          {tab === "add" && <AddPointForm onAddPoint={addPoint} userLocation={userLocation} />}
          {tab === "sync" && (
            <Card className="rounded-3xl border-0 shadow-xl">
              <CardContent className="p-5">
                <div className="mb-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Admin / Data</div>
                  <h2 className="mt-1 text-2xl font-black text-slate-950">Data Tools</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    The main point dataset should be imported into Supabase. This screen only exports/imports the points currently loaded on this device screen.
                  </p>
                </div>
                <div className="grid gap-3">
                  <Button onClick={() => downloadJson("pointvault-current-screen-points.json", points)} className="rounded-2xl py-6">
                    <Download size={18} className="mr-2" /> Export Current Screen JSON
                  </Button>
                  <label className="flex cursor-pointer items-center justify-center rounded-2xl bg-slate-900 px-4 py-4 text-sm font-semibold text-white shadow-sm">
                    <Upload size={18} className="mr-2" /> Import Local JSON to Screen
                    <input type="file" accept="application/json,.json" className="hidden" onChange={importJson} />
                  </label>
                  <Button onClick={clearScreenPoints} variant="secondary" className="rounded-2xl py-6">
                    Clear Screen Points
                  </Button>
                </div>
                <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                  If old test points still appear, open browser DevTools Console and run <strong>localStorage.clear(); location.reload();</strong>. This version no longer loads demo points automatically.
                </div>
              </CardContent>
            </Card>
          )}
        </main>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto grid max-w-md grid-cols-5 gap-2 text-xs font-semibold text-slate-500">
          <button onClick={() => setTab("map")} className={`flex flex-col items-center gap-1 ${tab === "map" ? "text-blue-600" : ""}`}><Map size={20} /> Map</button>
          <button onClick={() => setTab("list")} className={`flex flex-col items-center gap-1 ${tab === "list" ? "text-blue-600" : ""}`}><List size={20} /> List</button>
          <button onClick={() => setTab("add")} className={`flex flex-col items-center gap-1 ${tab === "add" ? "text-blue-600" : ""}`}><Plus size={20} /> Add</button>
          <button onClick={() => setTab("detail")} className={`flex flex-col items-center gap-1 ${tab === "detail" ? "text-blue-600" : ""}`}><MapPin size={20} /> Point</button>
          <button onClick={() => setTab("sync")} className={`flex flex-col items-center gap-1 ${tab === "sync" ? "text-blue-600" : ""}`}><Database size={20} /> Data</button>
        </div>
      </nav>
    </div>
  );
}
