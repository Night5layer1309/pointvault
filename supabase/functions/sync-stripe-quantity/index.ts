// Edge Function: sync-stripe-quantity
//
// Called by the client after a membership change (invite accepted, member
// removed) to make sure the Stripe subscription quantity matches the
// company's current active member count. Without this, customers add
// members and don't get billed for the extra seats until next renewal
// (revenue leakage) -- or remove members and keep paying for ghost seats.
//
// Safe to call any time:
//   - If the company has no Stripe subscription (free tier / trialing
//     without checkout), the function is a no-op
//   - If quantities already match, Stripe accepts the update as idempotent
//   - Any signed-in member of the company can trigger a sync; you don't
//     have to be owner/admin (worst case is the quantity gets corrected
//     to the truth, which is what we always want)
//
// Stripe handles proration via proration_behavior='create_prorations':
// mid-cycle additions show as prorated charges on the next invoice;
// removals show as prorated credits.
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL                (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   SUPABASE_ANON_KEY           (auto-injected)

import Stripe from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const { companyId } = body as { companyId?: string };
    if (!companyId) {
      return new Response(JSON.stringify({ error: "companyId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Caller must be an active member of the company (any role -- a member
    // who just accepted their invite needs to be able to trigger a sync).
    const { data: membership, error: membershipError } = await admin
      .from("company_memberships")
      .select("role, status")
      .eq("company_id", companyId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) {
      return new Response(JSON.stringify({ error: "Not a member of this company" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: company, error: companyError } = await admin
      .from("companies")
      .select("stripe_subscription_id")
      .eq("id", companyId)
      .single();
    if (companyError) throw companyError;

    // No subscription = free tier or trial. Nothing to sync, success.
    if (!company.stripe_subscription_id) {
      return new Response(JSON.stringify({
        synced: false,
        reason: "no_active_subscription",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: seatCount, error: seatErr } = await admin.rpc("company_active_seat_count", {
      target_company_id: companyId,
    });
    if (seatErr) throw seatErr;
    const desiredQuantity = Math.max(1, Number(seatCount ?? 1));

    const subscription = await stripe.subscriptions.retrieve(company.stripe_subscription_id);
    const item = subscription.items?.data?.[0];
    if (!item) {
      throw new Error("Stripe subscription has no items to update");
    }

    if (item.quantity === desiredQuantity) {
      return new Response(JSON.stringify({
        synced: true,
        quantity: desiredQuantity,
        changed: false,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, quantity: desiredQuantity }],
      proration_behavior: "create_prorations",
    });

    return new Response(JSON.stringify({
      synced: true,
      quantity: desiredQuantity,
      changed: true,
      previous_quantity: item.quantity,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("sync-stripe-quantity error", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
