// Edge Function: geocode-address
//
// The address search in the map tab calls this. We try Nominatim (OSM) first
// because it covers most well-mapped places, then fall back to the US Census
// Geocoder (USPS / TIGER) for rural US addresses Nominatim doesn't index.
// Both are free with no API key.
//
// Why server-side: the Census Geocoder returns 200 with the data but does NOT
// send an Access-Control-Allow-Origin header, so the browser silently blocks
// the response. Wrapping the call here lets us add proper CORS headers.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Hit = { lat: number; lng: number; displayName: string; source: string };
type Bias = { lat: number; lng: number };

async function queryNominatim(q: string, bias?: Bias): Promise<Hit | null> {
  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "5",
    countrycodes: "us",
    addressdetails: "0",
  });
  if (bias) {
    const pad = 2;
    params.set(
      "viewbox",
      `${bias.lng - pad},${bias.lat + pad},${bias.lng + pad},${bias.lat - pad}`,
    );
    params.set("bounded", "0");
  }
  // Nominatim requires a User-Agent identifying the app.
  const resp = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    { headers: { "User-Agent": "pointvault-geocode/1.0 (skinners1309@gmail.com)" } },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = Number(data[0].lat);
  const lng = Number(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, displayName: data[0].display_name, source: "osm" };
}

async function queryCensus(q: string): Promise<Hit | null> {
  const url =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
    `?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  const matches = data?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const m = matches[0];
  const lat = Number(m.coordinates?.y);
  const lng = Number(m.coordinates?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, displayName: m.matchedAddress || q, source: "census" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const address = String(body?.address || "").trim();
    const biasRaw = body?.bias;
    const bias: Bias | undefined =
      biasRaw &&
      Number.isFinite(Number(biasRaw.lat)) &&
      Number.isFinite(Number(biasRaw.lng))
        ? { lat: Number(biasRaw.lat), lng: Number(biasRaw.lng) }
        : undefined;

    if (!address) {
      return new Response(JSON.stringify({ error: "Missing address." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let hit: Hit | null = null;
    try {
      hit = await queryNominatim(address, bias);
    } catch (err) {
      console.warn("Nominatim error:", err);
    }
    if (!hit) {
      try {
        hit = await queryCensus(address);
      } catch (err) {
        console.warn("Census error:", err);
      }
    }

    return new Response(JSON.stringify({ match: hit }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String((err as Error)?.message || err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
