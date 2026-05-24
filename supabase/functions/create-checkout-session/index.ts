// Edge Function: create-checkout-session
//
// Owner/admin of a company clicks "Upgrade" in the app. The client POSTs here
// with the company's UUID and the price/quantity to bill. We make sure a
// Stripe Customer exists for the company, then create a Stripe Checkout
// Session in subscription mode and return its URL. The client redirects the
// user to that URL.
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL                (auto-injected by Supabase)
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

    // Anon client tied to the caller's JWT, used only to verify identity.
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
    const { companyId, priceId, returnOrigin } = body as {
      companyId?: string;
      priceId?: string;
      returnOrigin?: string;
    };

    if (!companyId || !priceId) {
      return new Response(JSON.stringify({ error: "companyId and priceId are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Confirm the caller is an owner/admin of this company.
    const { data: membership, error: membershipError } = await admin
      .from("company_memberships")
      .select("role, status")
      .eq("company_id", companyId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return new Response(JSON.stringify({ error: "Not authorized to bill this company" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load the company + ensure a Stripe Customer exists for it.
    const { data: company, error: companyError } = await admin
      .from("companies")
      .select("id, name, stripe_customer_id")
      .eq("id", companyId)
      .single();
    if (companyError) throw companyError;

    let customerId = company.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: company.name,
        metadata: {
          company_id: company.id,
          created_by_user_id: user.id,
        },
      });
      customerId = customer.id;
      await admin.from("companies").update({ stripe_customer_id: customerId }).eq("id", company.id);
    }

    // Quantity = current active members (so the first invoice is right).
    const { data: seatRow } = await admin.rpc("company_active_seat_count", {
      target_company_id: companyId,
    });
    const quantity = Math.max(1, Number(seatRow ?? 1));

    const origin = returnOrigin || req.headers.get("origin") || "https://pointvault.vercel.app";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity }],
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          company_id: company.id,
        },
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-checkout-session error", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
