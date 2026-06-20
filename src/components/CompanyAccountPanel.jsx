import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  Building2,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Link as LinkIcon,
  Lock,
  Mail,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  acceptInvite,
  buildCompanyInviteUrl,
  createCompany,
  createCompanyInviteLink,
  createOpenCompanyInviteLink,
  fetchCompanyBilling,
  fetchCompanyInvites,
  fetchCompanyMembers,
  fetchCompanyMemberships,
  getInviteTokenFromUrl,
  openBillingPortal,
  removeCompanyMember,
  lookupInvite,
  signInWithEmail,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
  signOut,
  startCheckoutForCompany,
  syncStripeQuantity,
  getCompanyCommunityStatus,
  repairCompanyCommunityStats,
} from "@/lib/companyAccounts";

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function InviteQrCard({ inviteUrl, inviteToken, email }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!inviteUrl) {
      setQrDataUrl("");
      return undefined;
    }

    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl]);

  const copy = async (value, label) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    setCopyMessage(`${label} copied.`);
    window.setTimeout(() => setCopyMessage(""), 1800);
  };

  if (!inviteUrl) return null;

  return (
    <div className="mb-4 rounded-3xl border border-blue-100 bg-blue-50 p-4">
      <div className="mb-3 flex items-center gap-2 font-bold text-blue-950">
        <QrCode size={18} /> QR invite ready{email ? ` for ${email}` : ""}
      </div>
      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        <div className="flex justify-center rounded-3xl bg-white p-3 shadow-sm">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Company invite QR code" className="h-60 w-60 rounded-2xl" />
          ) : (
            <div className="flex h-60 w-60 items-center justify-center rounded-2xl bg-slate-100 text-sm text-slate-500">
              Building QR code...
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm leading-6 text-blue-950">
            Have the new user scan this with their phone camera. It opens PointVault with the invite token already filled in.
          </p>
          <div className="mt-3 rounded-2xl bg-white p-3 text-xs font-semibold text-slate-700 break-all ring-1 ring-blue-100">
            {inviteUrl}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => copy(inviteUrl, "Invite link")} variant="secondary" className="rounded-2xl px-4 py-3">
              <LinkIcon size={15} className="mr-2" /> Copy Link
            </Button>
            <Button onClick={() => copy(inviteToken, "Invite token")} variant="secondary" className="rounded-2xl px-4 py-3">
              <Copy size={15} className="mr-2" /> Copy Token
            </Button>
          </div>
          {copyMessage && <div className="mt-3 text-xs font-bold text-blue-800">{copyMessage}</div>}
        </div>
      </div>
    </div>
  );
}

export function SignInPanel() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const inviteToken = getInviteTokenFromUrl();
  const [invitePreview, setInvitePreview] = useState(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Resolve the invite token to a company name (or "invalid") so the user sees
  // "Joining: Acme Surveyors" instead of a UUID.
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    lookupInvite(inviteToken)
      .then((preview) => { if (!cancelled) setInvitePreview(preview); })
      .catch(() => { if (!cancelled) setInvitePreview({ valid: false, reason: "lookup_failed" }); });
    return () => { cancelled = true; };
  }, [inviteToken]);

  const continueWithGoogle = async () => {
    setSending(true);
    setMessage("Redirecting to Google...");
    try {
      await signInWithGoogle();
      // The page will redirect; nothing to do after.
    } catch (error) {
      setMessage(error?.message || "Could not start Google sign-in.");
      setSending(false);
    }
  };

  const sendEmailLink = async (emailToUse) => {
    await signInWithEmail(emailToUse);
    setMessage(
      "Sign-in link sent. Open the email we just sent you and tap the link to finish. " +
      "Check your spam folder if you don't see it in a minute.",
    );
  };

  // The smart primary button: handles both sign-in and sign-up depending on
  // what the user typed and whether an account already exists. The user asked
  // for this UX: "if they put their email and password in and don't have an
  // account, keep password as their new password. if they don't [enter a
  // password], just send email to them."
  const continueWithEmail = async () => {
    const cleanEmail = email.trim();
    if (!cleanEmail) return;
    setSending(true);
    setMessage("");

    // No password: send a one-time sign-in link. This works for both new and
    // returning users; Supabase creates the account on first link-click.
    if (!password) {
      try {
        await sendEmailLink(cleanEmail);
      } catch (error) {
        setMessage(error?.message || "Could not send the sign-in link.");
      } finally {
        setSending(false);
      }
      return;
    }

    // Has password: try password sign-in first.
    try {
      await signInWithPassword(cleanEmail, password);
      setMessage("Signed in.");
      setSending(false);
      return;
    } catch (signInErr) {
      const errMsg = signInErr?.message || "";
      if (!/invalid login credentials|invalid email or password/i.test(errMsg)) {
        setMessage(errMsg || "Could not sign in.");
        setSending(false);
        return;
      }
      // Wrong-creds error covers both "wrong password" and "no such email".
      // Try to register them with the password they just typed.
      try {
        const result = await signUpWithPassword(cleanEmail, password);
        const identities = result?.user?.identities;
        // Supabase quirk when email confirmation is ON: signUp on an existing
        // email succeeds with user.identities === [] (no enumeration leak).
        // Treat that as "account exists, wrong password" and fall back to the
        // recovery email link.
        if (Array.isArray(identities) && identities.length === 0) {
          setMessage("That email already has an account. We just sent you a sign-in link to get back in.");
          try { await signInWithEmail(cleanEmail); } catch { /* ignore */ }
        } else if (result?.session) {
          setMessage("Account created and signed in.");
        } else {
          setMessage("Account created! Check your email to verify your address, then you're in.");
        }
      } catch (signUpErr) {
        const upMsg = signUpErr?.message || "";
        if (/already registered|user already exists/i.test(upMsg)) {
          setMessage("That email already has an account. We just sent you a sign-in link to get back in.");
          try { await signInWithEmail(cleanEmail); } catch { /* ignore */ }
        } else {
          setMessage(upMsg || "Could not create account.");
        }
      }
    } finally {
      setSending(false);
    }
  };

  // What the primary button should look like, given the state of the password field.
  const primaryLabel = password ? "Sign In or Create Account" : "Email Me a Sign-In Link";
  const PrimaryIcon = password ? null : Mail;

  // Friendly banner about the invite (or its failure).
  let inviteBanner = null;
  if (inviteToken) {
    if (invitePreview === null) {
      inviteBanner = (
        <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-semibold text-blue-950">
          Checking your invite...
        </div>
      );
    } else if (invitePreview.valid) {
      inviteBanner = (
        <div className="mb-4 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm leading-5 text-blue-950">
          <div className="font-bold">You're joining <span className="underline">{invitePreview.company_name}</span></div>
          <div className="mt-1 text-xs font-semibold opacity-80">
            Sign in (or create an account) with {invitePreview.email_locked ? "the email that was invited" : "any email"} and you'll be added to {invitePreview.company_name} automatically as {invitePreview.role === "admin" ? "an admin" : "a member"}.
          </div>
        </div>
      );
    } else {
      const reason =
        invitePreview.reason === "expired" ? "This invite has expired." :
        invitePreview.reason === "used_up" ? "This invite has already been used up." :
        invitePreview.reason === "not_found" ? "We couldn't find that invite — the link may be wrong." :
        "We couldn't verify that invite.";
      inviteBanner = (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900">
          <div className="font-bold">{reason}</div>
          <div className="mt-1 text-xs font-semibold opacity-80">
            You can still sign in and create your own company below.
          </div>
        </div>
      );
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
      <Card className="w-full rounded-3xl border-0 shadow-xl">
        <CardContent className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="rounded-2xl bg-slate-900 p-3 text-white"><Building2 size={24} /></div>
            <div>
              <h1 className="text-2xl font-black text-slate-950">PointVault</h1>
              <p className="text-sm text-slate-500">Sign in or create your account</p>
            </div>
          </div>

          {inviteBanner}

          {/* Primary: one-click Google. Most users get in with no email step. */}
          <Button
            onClick={continueWithGoogle}
            disabled={sending}
            variant="secondary"
            className="w-full rounded-2xl border border-slate-200 bg-white py-5 text-slate-900 hover:bg-slate-50"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" className="mr-3" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.2 4 9.5 8.4 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.4 0 10.3-2.1 13.9-5.5l-6.4-5.4C29.4 35 26.8 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.4 39.5 16.1 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.4 5.4C41.4 36 44 30.5 44 24c0-1.3-.1-2.4-.4-3.5z"/>
            </svg>
            Continue with Google
          </Button>

          <div className="my-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />
            or use email
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <input
            type="email"
            className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <input
            type="password"
            className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400"
            placeholder="Password (leave blank to get a sign-in link instead)"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && email.trim()) continueWithEmail(); }}
            autoComplete="current-password"
          />
          <Button
            onClick={continueWithEmail}
            disabled={sending || !email.trim()}
            className="w-full rounded-2xl py-5"
          >
            {PrimaryIcon && <PrimaryIcon size={16} className="mr-2" />}
            {primaryLabel}
          </Button>

          <p className="mt-4 text-xs leading-5 text-slate-500">
            {password
              ? "We'll sign you in if you already have an account, or create one with this password if it's your first time."
              : "Type a password to sign in or create an account in one tap. Leave it blank to get a one-time link by email instead."}
          </p>

          {message && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700">
              {message}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function CompanySetupPanel({ session, onReady }) {
  const inviteFromUrl = getInviteTokenFromUrl();
  const [companyName, setCompanyName] = useState("");
  const [fullName, setFullName] = useState(
    session?.user?.user_metadata?.full_name
      || session?.user?.user_metadata?.name
      || "",
  );
  const [inviteToken, setInviteToken] = useState(inviteFromUrl);
  const [invitePreview, setInvitePreview] = useState(null);
  // When an invite is in the URL we lead with Join. Otherwise lead with Create
  // and let the user expand the "have an invite?" path if they need it.
  const [mode, setMode] = useState(inviteFromUrl ? "join" : "create");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  // Look up the company name behind the invite token so the join card says
  // "Joining Acme Surveyors" instead of "Confirm your invite token".
  useEffect(() => {
    const cleanToken = (inviteToken || "").trim();
    if (!cleanToken) {
      setInvitePreview(null);
      return undefined;
    }
    let cancelled = false;
    lookupInvite(cleanToken)
      .then((preview) => { if (!cancelled) setInvitePreview(preview); })
      .catch(() => { if (!cancelled) setInvitePreview({ valid: false, reason: "lookup_failed" }); });
    return () => { cancelled = true; };
  }, [inviteToken]);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await fetchCompanyMemberships();
      if (rows[0]?.company) onReady(rows[0].company, rows[0]);
    } catch (error) {
      setMessage(error.message || "Could not load company memberships.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!companyName.trim()) return;
    setWorking(true);
    setMessage("");
    try {
      // Fall back to the email's local part if the user didn't fill in a name
      // (e.g. came in via the magic-link path and never set user_metadata).
      const nameForCreate = fullName.trim() || (session?.user?.email || "").split("@")[0] || "Owner";
      const company = await createCompany({
        name: companyName.trim(),
        slug: slugify(companyName),
        fullName: nameForCreate,
      });
      setMessage(`Created ${company.name}.`);
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create company.");
    } finally {
      setWorking(false);
    }
  };

  const accept = async () => {
    if (!inviteToken.trim()) return;
    setWorking(true);
    setMessage("");
    try {
      const acceptedCompanyId = await acceptInvite(inviteToken.trim());
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("invite");
      window.history.replaceState({}, "", cleanUrl.toString());
      setMessage("Invite accepted.");
      await load();
      // Bump Stripe subscription quantity so the new seat shows up on
      // the next invoice. Non-blocking; the membership is already saved.
      if (acceptedCompanyId) {
        syncStripeQuantity(acceptedCompanyId);
      }
    } catch (error) {
      setMessage(error.message || "Could not accept invite.");
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-slate-600">Loading...</div>;
  }

  const isJoin = mode === "join";

  return (
    <div className="mx-auto min-h-screen max-w-xl px-4 py-10">
      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-6">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {isJoin ? "Join a company" : "Welcome"}
              </div>
              <h1 className="mt-1 text-3xl font-black text-slate-950">
                {isJoin ? "Accept your invite" : "Name your company"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {isJoin
                  ? "We detected an invite. Confirm to join the company that invited you."
                  : "One line and you're in. Pick the name your crew uses for billing & invites — you can change it later."}
              </p>
            </div>
            <Button onClick={signOut} variant="secondary" className="rounded-2xl px-4 py-3">Sign out</Button>
          </div>

          {isJoin ? (
            <div className="space-y-3">
              {invitePreview?.valid && (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-5 text-blue-950">
                  <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Joining</div>
                  <div className="mt-1 text-xl font-black">{invitePreview.company_name}</div>
                  <div className="mt-1 text-xs font-semibold opacity-80">
                    You'll join as {invitePreview.role === "admin" ? "an admin" : "a member"}.
                  </div>
                </div>
              )}
              {invitePreview && !invitePreview.valid && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-900">
                  {invitePreview.reason === "expired"
                    ? `That invite expired${invitePreview.company_name ? ` (for ${invitePreview.company_name})` : ""}. Ask for a fresh one or create your own company.`
                    : invitePreview.reason === "used_up"
                      ? `That invite has been used up${invitePreview.company_name ? ` (for ${invitePreview.company_name})` : ""}. Ask the company owner for a new link.`
                      : invitePreview.reason === "not_found"
                        ? "We couldn't find that invite. Double-check the code, or create your own company."
                        : "We couldn't verify that invite."}
                </div>
              )}
              <input
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400"
                placeholder="Invite token"
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value)}
              />
              <Button onClick={accept} disabled={working || !inviteToken.trim() || invitePreview?.valid === false} className="w-full rounded-2xl py-5">
                <ShieldCheck size={16} className="mr-2" /> {invitePreview?.valid ? `Join ${invitePreview.company_name}` : "Join Company"}
              </Button>
              <button
                type="button"
                onClick={() => { setMode("create"); setMessage(""); }}
                className="w-full text-center text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
              >
                Or create your own company instead
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-base outline-none focus:border-blue-400"
                placeholder="Company name (e.g. Acme Surveyors)"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && companyName.trim()) create(); }}
                autoFocus
              />
              <details className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
                <summary className="cursor-pointer font-semibold text-slate-600">Your name (optional)</summary>
                <input
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
                <p className="mt-2 text-[11px] leading-4 text-slate-500">
                  Shown to teammates on your profile. We'll use your email if you skip this.
                </p>
              </details>
              <Button onClick={create} disabled={working || !companyName.trim()} className="w-full rounded-2xl py-5">
                <Plus size={16} className="mr-2" /> Create Company
              </Button>
              <button
                type="button"
                onClick={() => { setMode("join"); setMessage(""); }}
                className="w-full text-center text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
              >
                Have an invite code from another company? Join instead
              </button>
            </div>
          )}

          {message && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700">
              {message}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function CompanySwitcher({ memberships, activeCompanyId, onChange }) {
  if (memberships.length <= 1) return null;
  return (
    <select className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm" value={activeCompanyId || ""} onChange={(e) => onChange(e.target.value)}>
      {memberships.map((membership) => <option key={membership.id} value={membership.company.id}>{membership.company.name}</option>)}
    </select>
  );
}

export function TrialEndedGate({ company, membership, billing }) {
  const canAdmin = ["owner", "admin"].includes(membership?.role);
  const trialEnded = billing?.trial_ends_at
    ? new Date(billing.trial_ends_at).toLocaleDateString()
    : "recently";
  const dataRetentionEnd = billing?.trial_ends_at
    ? new Date(new Date(billing.trial_ends_at).getTime() + 60 * 24 * 60 * 60 * 1000).toLocaleDateString()
    : "at least 60 days from now";

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-10">
      <Card className="w-full rounded-3xl border-0 shadow-xl">
        <CardContent className="p-6">
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <Lock size={28} />
            </div>
            <h1 className="mt-4 text-2xl font-black text-slate-950">Your free trial has ended</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              <strong>{company?.name}</strong>'s 7-day trial ended on <strong>{trialEnded}</strong>.
              Map, points, observations, and imports are paused until you subscribe.
            </p>
            <div className="mt-3 rounded-2xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-900">
              <Clock size={14} className="mr-1 inline" />
              Your data is safe through <strong>{dataRetentionEnd}</strong>. Subscribe before then and
              you'll pick up exactly where you left off — no data loss.
            </div>
          </div>

          <div className="mt-6">
            {canAdmin ? (
              <BillingPanel company={company} canAdmin={canAdmin} />
            ) : (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                Only the company owner or an admin can subscribe. Ask them to open PointVault and
                click <strong>Upgrade</strong> in the Billing card.
              </div>
            )}
          </div>

          <Button onClick={signOut} variant="secondary" className="mt-6 w-full rounded-2xl py-3">
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function BillingBadge({ status }) {
  const label = status ? status.replace(/_/g, " ") : "free";
  const tone = status === "active" || status === "trialing"
    ? "bg-emerald-100 text-emerald-800"
    : status === "past_due" || status === "incomplete" || status === "unpaid"
      ? "bg-amber-100 text-amber-900"
      : status === "canceled" || status === "incomplete_expired"
        ? "bg-red-100 text-red-800"
        : "bg-slate-100 text-slate-700";
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-black uppercase ${tone}`}>{label}</span>
  );
}

export function BillingPanel({ company, canAdmin }) {
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!company?.id || !canAdmin) return;
    setLoading(true);
    setError("");
    try {
      const snapshot = await fetchCompanyBilling(company.id);
      setBilling(snapshot);
    } catch (err) {
      setError(err?.message || "Could not load billing.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing")) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("billing");
      window.history.replaceState({}, "", cleanUrl.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, canAdmin]);

  if (!canAdmin) return null;

  const onUpgrade = async () => {
    setWorking(true);
    setError("");
    try {
      await startCheckoutForCompany(company.id);
    } catch (err) {
      setError(err?.message || "Could not start checkout.");
      setWorking(false);
    }
  };

  const onManage = async () => {
    setWorking(true);
    setError("");
    try {
      await openBillingPortal(company.id);
    } catch (err) {
      setError(err?.message || "Could not open billing portal.");
      setWorking(false);
    }
  };

  const status = billing?.stripe_subscription_status || null;
  const isActive = status === "active" || status === "trialing";
  const seatCount = Number(billing?.active_seat_count ?? 0);
  const monthly = (seatCount * 10).toFixed(2);
  const periodEndLabel = billing?.stripe_current_period_end
    ? new Date(billing.stripe_current_period_end).toLocaleDateString()
    : null;

  return (
    <Card className="rounded-3xl border-0 shadow-lg">
      <CardContent className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-bold text-slate-950">
            <CreditCard size={18} /> Billing
            {!loading && <BillingBadge status={status} />}
          </div>
          <Button onClick={load} variant="secondary" className="rounded-2xl px-3 py-2"><RefreshCw size={15} /></Button>
        </div>

        {!isActive && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm leading-6 text-slate-700">
              Subscribe to unlock unlimited team members. <strong>$10/month per active member</strong> —
              your current count is <strong>{seatCount}</strong>, so the first invoice would be <strong>${monthly}</strong>.
              Add or remove members anytime; Stripe prorates the next invoice.
            </p>
            <Button onClick={onUpgrade} disabled={working} className="mt-3 rounded-2xl px-4 py-3">
              <ExternalLink size={15} className="mr-2" />
              {working ? "Opening Stripe..." : "Upgrade — open Stripe Checkout"}
            </Button>
          </div>
        )}

        {isActive && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
            <div className="flex items-center gap-2 font-bold">
              <CheckCircle2 size={16} /> Subscription active
            </div>
            <div className="mt-2">
              Billing <strong>{seatCount}</strong> active member{seatCount === 1 ? "" : "s"} at $10/month
              {" "}= <strong>${monthly}/mo</strong>.
              {periodEndLabel && <> Next invoice on <strong>{periodEndLabel}</strong>.</>}
            </div>
            <Button onClick={onManage} disabled={working} variant="secondary" className="mt-3 rounded-2xl px-4 py-3">
              <ExternalLink size={15} className="mr-2" />
              {working ? "Opening Stripe..." : "Manage Billing"}
            </Button>
          </div>
        )}

        {status && !isActive && (
          <div className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            Subscription status: {status}. Use Manage Billing to update payment details.
            <Button onClick={onManage} disabled={working} variant="secondary" className="ml-2 rounded-2xl px-3 py-2">
              Manage Billing
            </Button>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">{error}</div>
        )}
      </CardContent>
    </Card>
  );
}

const TIER_META = {
  private: {
    label: "Private",
    color: "slate",
    summary: "Community sharing isn't on yet. Your company points are visible only to you and your crew.",
  },
  viewing_only: {
    label: "Viewing only",
    color: "slate",
    summary: "You can see community markers (location only) on the map. Share a point to unlock more.",
  },
  low_contribution: {
    label: "Low contribution",
    color: "amber",
    summary: "You can see community markers with description and marker type. Share 100+ points to upgrade to Contributor.",
  },
  contributor: {
    label: "Contributor",
    color: "blue",
    summary: "Full community access: exact coordinates, descriptions, status, reliability. Keep your share/view ratio above 1-in-4 to reach Balanced.",
  },
  balanced: {
    label: "Balanced",
    color: "emerald",
    summary: "Top tier. You contribute as much as you take. Full access to every community marker.",
  },
};

const TIER_COLOR_CLASSES = {
  slate: "border-slate-200 bg-slate-50 text-slate-800",
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
};

export function CommunityStandingPanel({ company }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState(null);

  const load = async () => {
    if (!company?.id) return;
    setLoading(true);
    setError("");
    try {
      const next = await getCompanyCommunityStatus(company.id);
      setStatus(next);
    } catch (err) {
      setError(err?.message || "Could not load community standing.");
    } finally {
      setLoading(false);
    }
  };

  const runRepair = async () => {
    if (!company?.id) return;
    setRepairBusy(true);
    setError("");
    setRepairResult(null);
    let totalRepaired = 0;
    let lastResult = null;
    const maxIterations = 200; // belt-and-suspenders cap (200 * 200 = 40k)
    try {
      for (let i = 0; i < maxIterations; i += 1) {
        const result = await repairCompanyCommunityStats(company.id, 200);
        lastResult = result;
        totalRepaired += Number(result.observations_repaired || 0);
        setRepairResult({ ...result, observations_repaired: totalRepaired });
        if (result.done || Number(result.observations_repaired || 0) === 0) break;
      }
      // Final snapshot
      if (lastResult) setRepairResult({ ...lastResult, observations_repaired: totalRepaired });
      await load();
    } catch (err) {
      setError(err?.message || "Repair failed.");
    } finally {
      setRepairBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [company?.id]);

  if (!company?.id) return null;

  const tier = status?.tier || "private";
  const meta = TIER_META[tier] || TIER_META.private;
  const shared = Number(status?.shared_count || 0);
  const viewed = Number(status?.viewed_count || 0);
  const ratio = viewed > 0 ? (shared / viewed) : null;

  let progressNote = null;
  if (tier === "viewing_only") {
    progressNote = "Share your first point to unlock Low Contribution tier.";
  } else if (tier === "low_contribution") {
    const need = Math.max(0, 100 - shared);
    progressNote = `Share ${need.toLocaleString()} more point${need === 1 ? "" : "s"} to reach Contributor tier.`;
  } else if (tier === "contributor") {
    progressNote = "Keep your share/view ratio at 1:4 or better to reach Balanced tier.";
  } else if (tier === "balanced") {
    progressNote = "You're at the top tier. Thanks for contributing.";
  }

  return (
    <Card className="rounded-3xl border-0 shadow-xl">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Community Standing</div>
            <h3 className="mt-1 text-xl font-black text-slate-950">Your share of the pool</h3>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-black uppercase ${TIER_COLOR_CLASSES[meta.color]}`}>
            {meta.label}
          </span>
        </div>

        <p className="mt-3 text-sm leading-6 text-slate-700">{meta.summary}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase text-slate-400">Contributed</div>
            <div className="mt-1 text-2xl font-black text-slate-950">{shared.toLocaleString()}</div>
            <div className="mt-1 text-xs font-semibold text-slate-500">Points shared</div>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase text-slate-400">Viewed</div>
            <div className="mt-1 text-2xl font-black text-slate-950">{viewed.toLocaleString()}</div>
            <div className="mt-1 text-xs font-semibold text-slate-500">Community lookups you've done</div>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase text-slate-400">Ratio</div>
            <div className="mt-1 text-2xl font-black text-slate-950">{ratio === null ? "—" : `${ratio.toFixed(2)}x`}</div>
            <div className="mt-1 text-xs font-semibold text-slate-500">Shared per viewed</div>
          </div>
        </div>

        {progressNote && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3 text-xs font-semibold text-slate-700">
            {progressNote}
          </div>
        )}

        {status?.access_override && (
          <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-xs font-semibold text-blue-900">
            Tier manually set to <strong>{status.access_override}</strong> by admin override.
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">
            Number looks wrong? Run repair — it walks every point flagged as community,
            recreates any missing observation rows, and recomputes the counter.
          </p>
          <Button
            onClick={runRepair}
            disabled={repairBusy}
            variant="secondary"
            className="shrink-0 rounded-2xl px-3 py-2 text-xs"
          >
            {repairBusy ? "Repairing..." : "Refresh / Repair"}
          </Button>
        </div>

        {repairResult && (
          <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-900">
            <div className="font-black">
              Counter updated: {Number(repairResult.old_counter || 0).toLocaleString()} → {Number(repairResult.new_counter || 0).toLocaleString()}
            </div>
            <div className="mt-1 grid gap-1 opacity-90">
              <div>Company points flagged as community: {Number(repairResult.flagged_company_points || 0).toLocaleString()}</div>
              <div>Observation rows before repair: {Number(repairResult.observations_before || 0).toLocaleString()}</div>
              <div>Missing observations created: {Number(repairResult.observations_repaired || 0).toLocaleString()}</div>
              <div>Observation rows after repair: {Number(repairResult.observations_after || 0).toLocaleString()}</div>
            </div>
            {Number(repairResult.flagged_company_points || 0) !== Number(repairResult.observations_after || 0) && (
              <div className="mt-2 text-amber-900">
                ⚠️ Still a gap of {Math.abs(Number(repairResult.flagged_company_points || 0) - Number(repairResult.observations_after || 0)).toLocaleString()} between flagged points and observations — some points may have failed to share (e.g. missing geometry). Run audit on your imports if this persists.
              </div>
            )}
          </div>
        )}

        {loading && <div className="mt-3 text-xs font-semibold text-slate-500">Loading...</div>}
        {error && <div className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">{error}</div>}
      </CardContent>
    </Card>
  );
}

export function TeamPanel({ company, membership }) {
  const [members, setMembers] = useState([]);
  const [message, setMessage] = useState("");
  const [removingUserId, setRemovingUserId] = useState(null);
  const canAdmin = ["owner", "admin"].includes(membership?.role);
  const callerRole = membership?.role;
  const callerUserId = membership?.user_id;

  const load = async () => {
    if (!company?.id || !canAdmin) return;
    try {
      const memberRows = await fetchCompanyMembers(company.id);
      setMembers(memberRows);
    } catch (error) {
      setMessage(error.message || "Could not load company members.");
    }
  };

  useEffect(() => { load(); }, [company?.id, membership?.role]);

  const removeMember = async (row) => {
    const displayName = row.profile?.full_name || row.profile?.email || row.user_id;
    if (!window.confirm(`Remove ${displayName} from ${company.name}? They'll lose access immediately. Their past observations and field notes stay with the company.`)) {
      return;
    }
    setRemovingUserId(row.user_id);
    setMessage("");
    try {
      await removeCompanyMember({ companyId: company.id, userId: row.user_id });
      await load();
      // Drop Stripe subscription quantity by one (next invoice will
      // prorate). Fire-and-forget; the member is already gone from the
      // DB.
      syncStripeQuantity(company.id);
    } catch (error) {
      setMessage(error.message || "Could not remove member.");
    } finally {
      setRemovingUserId(null);
    }
  };

  const canRemove = (row) => {
    if (!canAdmin) return false;
    if (row.user_id === callerUserId) return false;
    if (row.role === "owner") return false;
    if (callerRole === "admin" && row.role === "admin") return false;
    return true;
  };

  if (!canAdmin) return null;

  const seatLimitLabel = company.seat_limit === null || company.seat_limit === undefined
    ? "unlimited"
    : String(company.seat_limit);

  return (
    <Card className="rounded-3xl border-0 shadow-lg">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold text-slate-950"><Users size={18} /> Team members</div>
            <p className="mt-1 text-xs text-slate-500">{company.name} seats: {members.length}/{seatLimitLabel}</p>
          </div>
          <Button onClick={load} variant="secondary" className="rounded-2xl px-3 py-2"><RefreshCw size={15} /></Button>
        </div>

        {message && <div className="mb-3 rounded-2xl bg-red-50 p-3 text-xs font-semibold text-red-800 break-all">{message}</div>}

        <div className="space-y-2">
          {members.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              No members loaded yet. Use the Invite tab to add your team.
            </div>
          )}
          {members.map((row) => {
            const name = row.profile?.full_name || row.profile?.email || row.user_id;
            const removable = canRemove(row);
            const removing = removingUserId === row.user_id;
            return (
              <div key={row.id} className="flex items-center justify-between gap-2 rounded-2xl bg-slate-50 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{name}</span>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-slate-700">{row.role}</span>
                  {removable && (
                    <button
                      onClick={() => removeMember(row)}
                      disabled={removing}
                      className="rounded-full border border-red-200 bg-white p-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
                      title={`Remove ${name}`}
                      aria-label={`Remove ${name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function InvitePanel({ company, membership }) {
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [latestInvite, setLatestInvite] = useState(null);
  const [message, setMessage] = useState("");
  const canAdmin = ["owner", "admin"].includes(membership?.role);

  const load = async () => {
    if (!company?.id || !canAdmin) return;
    try {
      const inviteRows = await fetchCompanyInvites(company.id);
      setInvites(inviteRows);
    } catch (error) {
      setMessage(error.message || "Could not load invites.");
    }
  };

  useEffect(() => { load(); }, [company?.id, membership?.role]);

  const invite = async () => {
    if (!email.trim()) return;
    try {
      const invitedEmail = email.trim();
      const inviteLink = await createCompanyInviteLink({ companyId: company.id, email: invitedEmail, role });
      setLatestInvite({ ...inviteLink, email: invitedEmail, role });
      setMessage("Invite created. Share the QR code or copy the link below.");
      setEmail("");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create invite.");
    }
  };

  const generateOpenInvite = async () => {
    try {
      const inviteLink = await createOpenCompanyInviteLink({
        companyId: company.id,
        ttlMinutes: 1440,
        role: "member",
        maxUses: null,
      });
      setLatestInvite({ ...inviteLink, email: "", role: "member" });
      setMessage("Team QR ready. Show it to anyone you want to join — good for 24 hours.");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create open invite.");
    }
  };

  if (!canAdmin) return null;

  return (
    <Card className="rounded-3xl border-0 shadow-lg">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-bold text-slate-950"><Send size={18} /> Invite team members</div>
          <Button onClick={load} variant="secondary" className="rounded-2xl px-3 py-2"><RefreshCw size={15} /></Button>
        </div>

        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-bold text-slate-950">Open team QR</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Show this to your team — anyone can scan to join. Good for 24 hours, unlimited scans.
            </p>
          </div>
          <Button onClick={generateOpenInvite} className="rounded-2xl px-4 py-3">
            <QrCode size={15} className="mr-2" /> Generate Team QR
          </Button>
        </div>

        <div className="mb-4 grid gap-2 md:grid-cols-[1fr_auto_auto]">
          <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="newuser@company.com (specific person)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="rounded-2xl border border-slate-200 px-3 py-3 text-sm" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="admin">Admin</option></select>
          <Button onClick={invite} variant="secondary" className="rounded-2xl px-4 py-3"><Send size={15} className="mr-2" /> Invite</Button>
        </div>

        {message && <div className="mb-3 rounded-2xl bg-blue-50 p-3 text-xs font-semibold text-blue-900 break-all">{message}</div>}
        {latestInvite && <InviteQrCard inviteUrl={latestInvite.url} inviteToken={latestInvite.token} email={latestInvite.email} />}

        <div className="space-y-2">
          {invites
            .filter((inviteRow) => {
              const isExpired = inviteRow.expires_at && new Date(inviteRow.expires_at) < new Date();
              const isUsedUp = inviteRow.max_uses !== null && inviteRow.uses >= inviteRow.max_uses;
              return !isExpired && !isUsedUp;
            })
            .map((inviteRow) => {
              const url = buildCompanyInviteUrl(inviteRow.token);
              const usageLabel = inviteRow.max_uses === null
                ? `${inviteRow.uses} joined (unlimited)`
                : `${inviteRow.uses}/${inviteRow.max_uses} used`;
              const expiresLabel = inviteRow.expires_at
                ? `expires ${new Date(inviteRow.expires_at).toLocaleString()}`
                : "no expiry";
              return (
                <div key={inviteRow.id} className="rounded-2xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-bold">
                    {inviteRow.email
                      ? `Pending: ${inviteRow.email} as ${inviteRow.role}`
                      : `Open team invite (${inviteRow.role})`}
                  </div>
                  <div className="mt-1 text-amber-700">{usageLabel} · {expiresLabel}</div>
                  <div className="mt-1 break-all">{url}</div>
                </div>
              );
            })}
        </div>
      </CardContent>
    </Card>
  );
}

export function CompanyAdminPanel({ company, membership }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [latestInvite, setLatestInvite] = useState(null);
  const [message, setMessage] = useState("");
  const canAdmin = ["owner", "admin"].includes(membership?.role);

  const load = async () => {
    if (!company?.id || !canAdmin) return;
    try {
      const [memberRows, inviteRows] = await Promise.all([fetchCompanyMembers(company.id), fetchCompanyInvites(company.id)]);
      setMembers(memberRows);
      setInvites(inviteRows);
    } catch (error) {
      setMessage(error.message || "Could not load company admin data.");
    }
  };

  useEffect(() => { load(); }, [company?.id, membership?.role]);

  const invite = async () => {
    if (!email.trim()) return;
    try {
      const invitedEmail = email.trim();
      const inviteLink = await createCompanyInviteLink({ companyId: company.id, email: invitedEmail, role });
      setLatestInvite({ ...inviteLink, email: invitedEmail, role });
      setMessage("Invite created. Share the QR code or copy the link below.");
      setEmail("");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create invite.");
    }
  };

  const generateOpenInvite = async () => {
    try {
      const inviteLink = await createOpenCompanyInviteLink({
        companyId: company.id,
        ttlMinutes: 1440,
        role: "member",
        maxUses: null,
      });
      setLatestInvite({ ...inviteLink, email: "", role: "member" });
      setMessage("Team QR ready. Show it to anyone you want to join — good for 24 hours.");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create open invite.");
    }
  };

  if (!canAdmin) return null;

  const seatLimitLabel = company.seat_limit === null || company.seat_limit === undefined
    ? "unlimited"
    : String(company.seat_limit);

  return (
    <div className="space-y-4">
      <BillingPanel company={company} canAdmin={canAdmin} />

      <Card className="rounded-3xl border-0 shadow-lg">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-bold text-slate-950"><Users size={18} /> Team</div>
              <p className="mt-1 text-xs text-slate-500">{company.name} seats: {members.length}/{seatLimitLabel}</p>
            </div>
            <Button onClick={load} variant="secondary" className="rounded-2xl px-3 py-2"><RefreshCw size={15} /></Button>
          </div>

        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-bold text-slate-950">Open team QR</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Show this to your team — anyone can scan to join. Good for 24 hours, unlimited scans.
            </p>
          </div>
          <Button onClick={generateOpenInvite} className="rounded-2xl px-4 py-3">
            <QrCode size={15} className="mr-2" /> Generate Team QR
          </Button>
        </div>

        <div className="mb-4 grid gap-2 md:grid-cols-[1fr_auto_auto]">
          <input className="rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="newuser@company.com (specific person)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="rounded-2xl border border-slate-200 px-3 py-3 text-sm" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="admin">Admin</option></select>
          <Button onClick={invite} variant="secondary" className="rounded-2xl px-4 py-3"><Send size={15} className="mr-2" /> Invite</Button>
        </div>

        {message && <div className="mb-3 rounded-2xl bg-blue-50 p-3 text-xs font-semibold text-blue-900 break-all">{message}</div>}
        {latestInvite && <InviteQrCard inviteUrl={latestInvite.url} inviteToken={latestInvite.token} email={latestInvite.email} />}

        <div className="space-y-2">
          {members.map((row) => (
            <div key={row.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2 text-sm">
              <span>{row.profile?.full_name || row.profile?.email || row.user_id}</span>
              <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-slate-700">{row.role}</span>
            </div>
          ))}
          {invites
            .filter((inviteRow) => {
              const isExpired = inviteRow.expires_at && new Date(inviteRow.expires_at) < new Date();
              const isUsedUp = inviteRow.max_uses !== null && inviteRow.uses >= inviteRow.max_uses;
              return !isExpired && !isUsedUp;
            })
            .map((inviteRow) => {
              const url = buildCompanyInviteUrl(inviteRow.token);
              const usageLabel = inviteRow.max_uses === null
                ? `${inviteRow.uses} joined (unlimited)`
                : `${inviteRow.uses}/${inviteRow.max_uses} used`;
              const expiresLabel = inviteRow.expires_at
                ? `expires ${new Date(inviteRow.expires_at).toLocaleString()}`
                : "no expiry";
              return (
                <div key={inviteRow.id} className="rounded-2xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="font-bold">
                    {inviteRow.email
                      ? `Pending: ${inviteRow.email} as ${inviteRow.role}`
                      : `Open team invite (${inviteRow.role})`}
                  </div>
                  <div className="mt-1 text-amber-700">{usageLabel} · {expiresLabel}</div>
                  <div className="mt-1 break-all">{url}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
