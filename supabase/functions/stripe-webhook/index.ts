// Edge Function: stripe-webhook
//
// Stripe POSTs subscription / invoice events here. We verify the signature
// with STRIPE_WEBHOOK_SECRET, then sync the relevant fields back onto the
// companies row using the company_id we stuffed into the subscription's
// metadata at checkout time.
//
// IMPORTANT: this function must be deployed with the --no-verify-jwt flag
// because Stripe doesn't send a Supabase JWT. Either deploy via:
//   supabase functions deploy stripe-webhook --no-verify-jwt
// or in the dashboard toggle "Verify JWT with legacy secret" to OFF for
// this function.

import Stripe from "https://esm.sh/stripe@14?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRoleKey);

async function syncSubscriptionToCompany(subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const companyId = subscription.metadata?.company_id;
  if (!companyId) {
    console.warn("Subscription missing company_id metadata", subscriptionId);
    return;
  }

  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  // Subscribed companies get an unlimited seat_limit; canceled / unpaid /
  // past_due drop back to the 1-seat free tier so the existing
  // accept_company_invitation seat guard kicks in (owner only, no invites).
  const activeLikeStatuses = ["trialing", "active"];
  const isActive = activeLikeStatuses.includes(subscription.status);

  const update: Record<string, unknown> = {
    stripe_subscription_id: subscription.id,
    stripe_subscription_status: subscription.status,
    stripe_price_id: priceId,
    stripe_current_period_end: periodEnd,
    plan_status: isActive ? "active" : subscription.status,
    seat_limit: isActive ? null : 1,
  };

  const { error } = await admin.from("companies").update(update).eq("id", companyId);
  if (error) console.error("Failed to sync subscription to company", error);
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return new Response(`Webhook signature verification failed: ${(err as Error).message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          await syncSubscriptionToCompany(String(session.subscription));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscriptionToCompany(subscription.id);
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.subscription) {
          await syncSubscriptionToCompany(String(invoice.subscription));
        }
        break;
      }
      default:
        // Unhandled event types are fine — Stripe sends a lot.
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("stripe-webhook handler error", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Unexpected error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
