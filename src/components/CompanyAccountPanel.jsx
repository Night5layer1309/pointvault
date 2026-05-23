import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  Building2,
  Copy,
  Link as LinkIcon,
  Mail,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
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
  fetchCompanyInvites,
  fetchCompanyMembers,
  fetchCompanyMemberships,
  getInviteTokenFromUrl,
  signInWithEmail,
  signOut,
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
  const inviteToken = getInviteTokenFromUrl();
  const [message, setMessage] = useState(
    inviteToken
      ? "Sign in with the email address that was invited. Your invite will be waiting after the magic link opens."
      : "Sign in with a magic link to access your company points."
  );
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      await signInWithEmail(email.trim());
      setMessage("Magic link sent. Check your email to finish signing in.");
    } catch (error) {
      setMessage(error.message || "Could not send magic link.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
      <Card className="w-full rounded-3xl border-0 shadow-xl">
        <CardContent className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="rounded-2xl bg-slate-900 p-3 text-white"><Building2 size={24} /></div>
            <div>
              <h1 className="text-2xl font-black text-slate-950">PointVault</h1>
              <p className="text-sm text-slate-500">Company account sign-in</p>
            </div>
          </div>
          {inviteToken && (
            <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-semibold text-blue-950 break-all">
              Invite detected: {inviteToken}
            </div>
          )}
          <p className="mb-4 text-sm leading-6 text-slate-600">{message}</p>
          <input
            className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button onClick={submit} disabled={sending} className="w-full rounded-2xl py-5">
            <Mail size={16} className="mr-2" /> {sending ? "Sending..." : "Send Magic Link"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function CompanySetupPanel({ session, onReady }) {
  const [memberships, setMemberships] = useState([]);
  const [companyName, setCompanyName] = useState("");
  const [fullName, setFullName] = useState(session?.user?.user_metadata?.full_name || "");
  const [inviteToken, setInviteToken] = useState(getInviteTokenFromUrl());
  const [message, setMessage] = useState(
    inviteToken
      ? "QR invite detected. Confirm the token below to join the company."
      : "Create a company workspace, or accept an invite from another survey company."
  );
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await fetchCompanyMemberships();
      setMemberships(rows);
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
    try {
      const company = await createCompany({ name: companyName.trim(), slug: slugify(companyName), fullName });
      setMessage(`Created ${company.name}.`);
      await load();
    } catch (error) {
      setMessage(error.message || "Could not create company.");
    }
  };

  const accept = async () => {
    if (!inviteToken.trim()) return;
    try {
      await acceptInvite(inviteToken.trim());
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("invite");
      window.history.replaceState({}, "", cleanUrl.toString());
      setMessage("Invite accepted.");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not accept invite.");
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-slate-600">Loading company account...</div>;
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <Card className="rounded-3xl border-0 shadow-xl">
        <CardContent className="p-6">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Company Account</div>
              <h1 className="mt-1 text-3xl font-black text-slate-950">Set up PointVault</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
            </div>
            <Button onClick={signOut} variant="secondary" className="rounded-2xl px-4 py-3">Sign out</Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 p-4">
              <div className="mb-3 flex items-center gap-2 font-bold text-slate-950"><Plus size={18} /> Create company</div>
              <input className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              <input className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Your name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              <Button onClick={create} className="w-full rounded-2xl py-5">Create Workspace</Button>
            </div>
            <div className="rounded-3xl border border-slate-200 p-4">
              <div className="mb-3 flex items-center gap-2 font-bold text-slate-950"><ShieldCheck size={18} /> Accept invite</div>
              <input className="mb-3 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-400" placeholder="Invite token" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} />
              <Button onClick={accept} variant="secondary" className="w-full rounded-2xl py-5">Accept Invite</Button>
            </div>
          </div>
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

  return (
    <Card className="rounded-3xl border-0 shadow-lg">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold text-slate-950"><Users size={18} /> Team</div>
            <p className="mt-1 text-xs text-slate-500">{company.name} seats: {members.length}/{company.seat_limit}</p>
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
  );
}
