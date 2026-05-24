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

export async function removeCompanyMember({ companyId, userId }) {
  const { data, error } = await supabase.rpc("remove_company_member", {
    target_company_id: companyId,
    target_user_id: userId,
  });
  if (error) throw error;
  return data;
}

export async function fetchCompanyMembers(companyId) {
  const { data: memberships, error } = await supabase
    .from("company_memberships")
    .select("id, role, status, created_at, user_id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (!memberships || memberships.length === 0) return [];

  const userIds = Array.from(new Set(memberships.map((row) => row.user_id).filter(Boolean)));
  if (userIds.length === 0) {
    return memberships.map((row) => ({ ...row, profile: null }));
  }

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .in("id", userIds);
  if (profileError) throw profileError;

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
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
