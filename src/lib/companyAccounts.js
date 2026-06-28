import { supabase } from "@/lib/supabaseClient";

export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export function getInviteTokenFromUrl(search = window.location.search) {
  return new URLSearchParams(search).get("invite") || "";
}

export function buildCompanyInviteUrl(token) {
  if (!token) return "";
  const url = new URL(window.location.origin);
  url.searchParams.set("invite", token);
  return url.toString();
}

export async function signInWithEmail(email) {
  const inviteToken = getInviteTokenFromUrl();
  const redirect = new URL(window.location.origin);
  if (inviteToken) redirect.searchParams.set("invite", inviteToken);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect.toString() },
  });
  if (error) throw error;
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// Sign up with email + password. Used by the "smart" sign-in flow as a
// fallback when password sign-in fails because the email isn't registered:
// instead of erroring at the user, we register them with the password they
// just typed. If the project requires email confirmation, the user will get a
// verification email; otherwise the session is created immediately.
export async function signUpWithPassword(email, password) {
  const inviteToken = getInviteTokenFromUrl();
  const redirect = new URL(window.location.origin);
  if (inviteToken) redirect.searchParams.set("invite", inviteToken);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirect.toString() },
  });
  if (error) throw error;
  return data;
}

// Read an invite token (per-email or open/QR) and return the inviting
// company's name + role so the sign-in screen can show "Join Acme Surveyors"
// instead of an opaque UUID. Returns { valid, company_name?, role?, reason? }.
export async function lookupInvite(token) {
  if (!token) return null;
  const { data, error } = await supabase.rpc("lookup_company_invite", {
    invite_token: token,
  });
  if (error) throw error;
  return data;
}

// One-click Google sign-in / sign-up. Requires Google to be enabled as a
// provider in the Supabase Auth → Providers settings (and the project's site
// URL added to Google's authorized redirect URIs). If a returning invite token
// is in the URL, carry it across the OAuth round-trip so the invite is still
// applied after Google sends the user back.
export async function signInWithGoogle() {
  const inviteToken = getInviteTokenFromUrl();
  const redirect = new URL(window.location.origin);
  if (inviteToken) redirect.searchParams.set("invite", inviteToken);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirect.toString() },
  });
  if (error) throw error;
  return data;
}

export async function setUserPassword(password) {
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function fetchCompanyMemberships() {
  const { data, error } = await supabase
    .from("company_memberships")
    .select("id, role, status, company:companies(id, name, slug, plan_status, seat_limit, owner_id)")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createCompany({ name, slug, fullName }) {
  const { data, error } = await supabase.rpc("create_company_with_owner", {
    company_name: name,
    company_slug: slug || null,
    full_name: fullName || null,
  });
  if (error) throw error;
  return data;
}

export async function inviteCompanyMember({ companyId, email, role }) {
  const { data, error } = await supabase.rpc("invite_company_member", {
    target_company_id: companyId,
    invite_email: email,
    invite_role: role || "member",
  });
  if (error) throw error;
  return data;
}

export async function createCompanyInviteLink({ companyId, email, role }) {
  const token = await inviteCompanyMember({ companyId, email, role });
  return { token, url: buildCompanyInviteUrl(token) };
}

export async function createOpenCompanyInvite({ companyId, ttlMinutes = 1440, role = "member", maxUses = null }) {
  const { data, error } = await supabase.rpc("create_open_company_invite", {
    target_company_id: companyId,
    ttl_minutes: ttlMinutes,
    invite_role: role,
    invite_max_uses: maxUses,
  });
  if (error) throw error;
  return data;
}

export async function createOpenCompanyInviteLink({ companyId, ttlMinutes, role, maxUses }) {
  const token = await createOpenCompanyInvite({ companyId, ttlMinutes, role, maxUses });
  return { token, url: buildCompanyInviteUrl(token) };
}

export async function acceptInvite(token) {
  const { data, error } = await supabase.rpc("accept_company_invitation", {
    invite_token: token,
  });
  if (error) throw error;
  return data;
}

export async function shareCompanyPointToCommunity(companyPointId) {
  if (!companyPointId) throw new Error("Missing point ID.");
  const { data, error } = await supabase.rpc("share_company_point_to_community", {
    target_company_point_id: companyPointId,
  });
  if (error) throw error;
  return data;
}

export async function shareCompanyPointsBulk(companyPointIds) {
  const ids = Array.isArray(companyPointIds) ? companyPointIds.filter(Boolean) : [];
  if (ids.length === 0) return { shared: 0, failed: 0 };
  const { data, error } = await supabase.rpc("share_company_points_bulk", {
    target_point_ids: ids,
  });
  if (error) throw error;
  return data || { shared: 0, failed: 0 };
}

export async function shareAllCompanyPoints(companyId) {
  if (!companyId) throw new Error("No company selected.");
  const { data, error } = await supabase.rpc("share_all_company_points", {
    target_company_id: companyId,
  });
  if (error) throw error;
  return data || { shared: 0, failed: 0 };
}

// Reverse a share: flip the point back to private and remove our row from
// community_point_observations. If we were the only contributor, the
// community_point itself is deleted so it vanishes from other companies' maps.
export async function unshareCompanyPointFromCommunity(companyPointId) {
  if (!companyPointId) throw new Error("Missing point ID.");
  const { data, error } = await supabase.rpc("unshare_company_point_to_community", {
    target_company_point_id: companyPointId,
  });
  if (error) throw error;
  return data;
}

export async function unshareCompanyPointsBulk(companyPointIds) {
  const ids = Array.isArray(companyPointIds) ? companyPointIds.filter(Boolean) : [];
  if (ids.length === 0) return { unshared: 0, skipped: 0, failed: 0 };
  const { data, error } = await supabase.rpc("unshare_company_points_bulk", {
    target_point_ids: ids,
  });
  if (error) throw error;
  return data || { unshared: 0, skipped: 0, failed: 0 };
}

// Community-standing snapshot: current tier + shared/viewed counts + a few
// flags for the trust-signal card on Team & Billing.
export async function getCompanyCommunityStatus(companyId) {
  if (!companyId) return null;
  const { data, error } = await supabase.rpc("get_company_community_status", {
    target_company_id: companyId,
  });
  if (error) throw error;
  return data || null;
}

// The "I'm out / reset my data" nuclear button. Owner-only on the server.
// Wipes every point, observation, and import this company has, plus resets
// community counters, but leaves the company / team / billing alone. Raw
// files in storage are NOT deleted by this call — pass the returned
// storage_prefix to clearCompanyStorageObjects to finish the cleanup.
export async function wipeCompanyData(companyId) {
  if (!companyId) throw new Error("No company selected.");
  const { data, error } = await supabase.rpc("wipe_company_data", {
    target_company_id: companyId,
  });
  if (error) throw error;
  return data || {};
}

// Walks the pointvault-imports bucket under the given company's prefix and
// deletes every object. Storage doesn't have a "delete prefix" op so we
// list + delete in batches. Returns the total count deleted.
export async function clearCompanyStorageObjects(storagePrefix, bucket = "pointvault-imports") {
  if (!storagePrefix) return 0;
  let total = 0;
  // Recursively walks one folder level at a time. The bucket layout the app
  // writes is companyId/jobId/{raw,processed}/file, so we list at the root
  // then drill into each folder.
  const walk = async (prefix) => {
    const { data: entries, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: 1000, offset: 0 });
    if (error) throw error;
    if (!entries || entries.length === 0) return;

    const filePaths = [];
    const folderPaths = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Folders show up with no id; files have an id.
      if (entry.id) filePaths.push(path);
      else folderPaths.push(path);
    }
    for (const folder of folderPaths) await walk(folder);

    if (filePaths.length > 0) {
      // Remove in chunks so we don't blow past per-call limits.
      const chunk = 100;
      for (let i = 0; i < filePaths.length; i += chunk) {
        const slice = filePaths.slice(i, i + chunk);
        const { error: removeError } = await supabase.storage.from(bucket).remove(slice);
        if (removeError) throw removeError;
        total += slice.length;
      }
    }
  };

  await walk(storagePrefix);
  return total;
}

// Diagnose + fix the share counter when it drifts (e.g. company_points
// flagged community don't have matching observations). Returns before/after
// numbers + a `done` flag so the UI can loop chunked calls until everything
// is repaired (per-call work is capped to avoid the 8s statement timeout on
// large gaps).
export async function repairCompanyCommunityStats(companyId, chunkSize = 200) {
  if (!companyId) throw new Error("No company selected.");
  const { data, error } = await supabase.rpc("repair_company_community_stats", {
    target_company_id: companyId,
    chunk_size: chunkSize,
  });
  if (error) throw error;
  return data || {};
}

export async function removeCompanyMember({ companyId, userId }) {
  const { data, error } = await supabase.rpc("remove_company_member", {
    target_company_id: companyId,
    target_user_id: userId,
  });
  if (error) throw error;
  return data;
}

export async function syncStripeQuantity(companyId) {
  if (!companyId) return null;
  try {
    const { data, error } = await supabase.functions.invoke("sync-stripe-quantity", {
      body: { companyId },
    });
    if (error) throw error;
    return data;
  } catch (err) {
    // Membership change already happened; we don't want to roll it back
    // if the Stripe sync fails. Log and let the caller continue.
    console.error("syncStripeQuantity failed", err);
    return null;
  }
}

export async function fetchCompanyMembers(companyId) {
  const { data: memberships, error } = await supabase
    .from("company_memberships")
    .select("id, role, status, created_at, user_id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (!memberships || memberships.length === 0) return [];

  // Resolve member names/emails/last-sign-in via the SECURITY DEFINER RPC
  // (auth.users isn't reachable from the client directly). Falls back to
  // public.profiles if the RPC fails for any reason, so the panel never
  // shows the bare UUIDs.
  let profileMap = new Map();
  try {
    const { data: profileRows, error: profileError } = await supabase.rpc(
      "get_company_member_profiles",
      { target_company_id: companyId },
    );
    if (profileError) throw profileError;
    profileMap = new Map(
      (profileRows || []).map((profile) => [
        profile.user_id,
        {
          id: profile.user_id,
          email: profile.email,
          full_name: profile.full_name,
          created_at: profile.created_at,
          last_sign_in_at: profile.last_sign_in_at,
        },
      ]),
    );
  } catch (rpcErr) {
    console.warn("get_company_member_profiles failed, falling back to public.profiles:", rpcErr);
    const userIds = Array.from(new Set(memberships.map((row) => row.user_id).filter(Boolean)));
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds);
      profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
    }
  }

  return memberships.map((row) => ({
    ...row,
    profile: profileMap.get(row.user_id) || null,
  }));
}

export async function fetchCompanyInvites(companyId) {
  const { data, error } = await supabase
    .from("company_invites")
    .select("id, email, role, token, accepted_at, expires_at, created_at, max_uses, uses")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchCompanyBilling(companyId) {
  const { data, error } = await supabase.rpc("company_billing_snapshot", {
    target_company_id: companyId,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data[0] || null) : data;
}

export async function startCheckoutForCompany(companyId) {
  const priceId = import.meta.env.VITE_STRIPE_PRICE_ID?.trim();
  if (!priceId || !priceId.startsWith("price_")) {
    throw new Error("VITE_STRIPE_PRICE_ID is missing or malformed.");
  }
  const { data, error } = await supabase.functions.invoke("create-checkout-session", {
    body: {
      companyId,
      priceId,
      returnOrigin: window.location.origin,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("Stripe Checkout did not return a URL.");
  window.location.href = data.url;
}

export async function openBillingPortal(companyId) {
  const { data, error } = await supabase.functions.invoke("create-portal-session", {
    body: {
      companyId,
      returnOrigin: window.location.origin,
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("Stripe portal did not return a URL.");
  window.location.href = data.url;
}

export async function listPointObservations(companyPointId) {
  if (!companyPointId) return [];
  const { data, error } = await supabase.rpc("list_point_observations", {
    target_company_point_id: companyPointId,
  });
  if (error) throw error;
  return data || [];
}

export async function addPointObservation({ companyPointId, status, body }) {
  const { data, error } = await supabase.rpc("add_point_observation", {
    target_company_point_id: companyPointId,
    observation_status: status,
    observation_body: body || "",
  });
  if (error) throw error;
  return data;
}

export async function listCommunityPointNotes({ communityPointId, companyId }) {
  const { data, error } = await supabase.rpc("list_community_point_notes", {
    target_community_point_id: communityPointId,
    target_company_id: companyId,
  });
  if (error) throw error;
  return data || [];
}

export async function addCommunityPointNote({ communityPointId, companyId, body }) {
  const { data, error } = await supabase.rpc("add_community_point_note", {
    target_community_point_id: communityPointId,
    target_company_id: companyId,
    note_body: body,
  });
  if (error) throw error;
  return data;
}

export async function fetchNearbyCompanyPoints({
  companyId,
  location,
  radiusFeet = 999999999,
  resultLimit = 5000,
  scope = "all",
}) {
  if (!companyId) {
    return {
      data: [],
      error: {
        message: "No company selected.",
      },
    };
  }

  if (!location?.lat || !location?.lng) {
    return {
      data: [],
      error: {
        message: "No GPS/user location available.",
      },
    };
  }

  const { data, error } = await supabase.rpc("nearby_visible_points", {
    target_company_id: companyId,
    user_lat: Number(location.lat),
    user_lng: Number(location.lng),
    radius_feet: Number(radiusFeet || 999999999),
    result_limit: Number(resultLimit || 5000),
    requested_scope: scope,
  });

  if (error) {
    return { data: [], error };
  }

  const normalized = (data || []).map((point) => ({
    ...point,
    id: point.id,
    point_id: point.point_id,
    name: point.name || point.point_id || point.marker_type || "Point",
    description: point.description || "",
    marker_type: point.marker_type || "",
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    lat: Number(point.latitude),
    lng: Number(point.longitude),
    northing: point.northing,
    easting: point.easting,
    elevation: point.elevation,
    distance_feet: point.distance_feet,
    details_locked: point.details_locked,
    coordinates_locked: point.coordinates_locked,
    visibility: point.visibility,
    access_level: point.access_level,
  }));

  return {
    data: normalized,
    error: null,
  };
}

// "Show all my points" — desktop view that returns every company point
// regardless of distance, so the user can pan the map and see everything.
// Excludes community-pool points from other companies (those still browse
// by area). Capped server-side at 100,000.
export async function fetchAllCompanyPoints({ companyId, resultLimit = 50000 }) {
  if (!companyId) {
    return { data: [], error: { message: "No company selected." } };
  }
  const { data, error } = await supabase.rpc("all_company_points", {
    target_company_id: companyId,
    result_limit: Number(resultLimit) || 50000,
  });
  if (error) return { data: [], error };

  const normalized = (data || []).map((point) => ({
    ...point,
    id: point.id,
    point_id: point.point_id,
    name: point.name || point.point_id || point.marker_type || "Point",
    description: point.description || "",
    marker_type: point.marker_type || "",
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    lat: Number(point.latitude),
    lng: Number(point.longitude),
    northing: point.northing,
    easting: point.easting,
    elevation: point.elevation,
    distance_feet: point.distance_feet,
    details_locked: point.details_locked,
    coordinates_locked: point.coordinates_locked,
    visibility: point.visibility,
    access_level: point.access_level,
  }));

  return { data: normalized, error: null };
}
