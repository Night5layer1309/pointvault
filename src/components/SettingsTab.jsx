import React, { useState } from "react";
import { BookOpen, FileText, KeyRound, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { setUserPassword } from "@/lib/companyAccounts";

const RADIUS_OPTIONS = [
  { value: 1000, label: "Within 1,000 ft" },
  { value: 5280, label: "Within 1 mile" },
  { value: 26400, label: "Within 5 miles" },
  { value: 999999999, label: "No distance limit" },
];

const BASEMAP_OPTIONS = [
  { value: "aerial", label: "Aerial (Esri)" },
  { value: "hybrid", label: "Hybrid" },
  { value: "streets", label: "Streets" },
  { value: "topo", label: "Topo" },
  { value: "usgs", label: "USGS Hi-Res" },
];

// NAD83 / State Plane (US Survey Feet) zones for all CONUS states, grouped by state.
// EPSG codes from the NAD83 (1986) State Plane family. If a specific code is off
// for a customer's workflow, edit just that row — the rest stay intact.
const COORD_SYSTEM_GROUPS = [
  { state: "Alabama", zones: [
    { epsg: "2759", name: "Alabama East (ftUS)" },
    { epsg: "2760", name: "Alabama West (ftUS)" },
  ]},
  { state: "Arizona", zones: [
    { epsg: "2762", name: "Arizona East (ftIntl)" },
    { epsg: "2763", name: "Arizona Central (ftIntl)" },
    { epsg: "2764", name: "Arizona West (ftIntl)" },
  ]},
  { state: "Arkansas", zones: [
    { epsg: "3433", name: "Arkansas North (ftUS)" },
    { epsg: "3434", name: "Arkansas South (ftUS)" },
  ]},
  { state: "California", zones: [
    { epsg: "2225", name: "California zone 1 (ftUS)" },
    { epsg: "2226", name: "California zone 2 (ftUS)" },
    { epsg: "2227", name: "California zone 3 (ftUS)" },
    { epsg: "2228", name: "California zone 4 (ftUS)" },
    { epsg: "2229", name: "California zone 5 (ftUS)" },
    { epsg: "2230", name: "California zone 6 (ftUS)" },
  ]},
  { state: "Colorado", zones: [
    { epsg: "2231", name: "Colorado North (ftUS)" },
    { epsg: "2232", name: "Colorado Central (ftUS)" },
    { epsg: "2233", name: "Colorado South (ftUS)" },
  ]},
  { state: "Connecticut", zones: [
    { epsg: "2234", name: "Connecticut (ftUS)" },
  ]},
  { state: "Delaware", zones: [
    { epsg: "2235", name: "Delaware (ftUS)" },
  ]},
  { state: "Florida", zones: [
    { epsg: "2238", name: "Florida North (ftUS)" },
    { epsg: "2237", name: "Florida East (ftUS)" },
    { epsg: "2239", name: "Florida West (ftUS)" },
  ]},
  { state: "Georgia", zones: [
    { epsg: "2240", name: "Georgia East (ftUS)" },
    { epsg: "2241", name: "Georgia West (ftUS)" },
  ]},
  { state: "Idaho", zones: [
    { epsg: "2242", name: "Idaho East (ftUS)" },
    { epsg: "2243", name: "Idaho Central (ftUS)" },
    { epsg: "2244", name: "Idaho West (ftUS)" },
  ]},
  { state: "Illinois", zones: [
    { epsg: "3435", name: "Illinois East (ftUS)" },
    { epsg: "3436", name: "Illinois West (ftUS)" },
  ]},
  { state: "Indiana", zones: [
    { epsg: "2245", name: "Indiana East (ftUS)" },
    { epsg: "2246", name: "Indiana West (ftUS)" },
  ]},
  { state: "Iowa", zones: [
    { epsg: "3417", name: "Iowa North (ftUS)" },
    { epsg: "3418", name: "Iowa South (ftUS)" },
  ]},
  { state: "Kansas", zones: [
    { epsg: "3419", name: "Kansas North (ftUS)" },
    { epsg: "3420", name: "Kansas South (ftUS)" },
  ]},
  { state: "Kentucky", zones: [
    { epsg: "2246", name: "Kentucky North (ftUS)" },
    { epsg: "2247", name: "Kentucky South (ftUS)" },
    { epsg: "3088", name: "Kentucky Single Zone (ftUS)" },
  ]},
  { state: "Louisiana", zones: [
    { epsg: "3451", name: "Louisiana North (ftUS)" },
    { epsg: "3452", name: "Louisiana South (ftUS)" },
    { epsg: "3453", name: "Louisiana Offshore (ftUS)" },
  ]},
  { state: "Maine", zones: [
    { epsg: "26847", name: "Maine East (ftUS)" },
    { epsg: "26848", name: "Maine West (ftUS)" },
  ]},
  { state: "Maryland", zones: [
    { epsg: "2248", name: "Maryland (ftUS)" },
  ]},
  { state: "Massachusetts", zones: [
    { epsg: "2249", name: "Massachusetts Mainland (ftUS)" },
    { epsg: "2250", name: "Massachusetts Island (ftUS)" },
  ]},
  { state: "Michigan", zones: [
    { epsg: "2251", name: "Michigan North (ftIntl)" },
    { epsg: "2252", name: "Michigan Central (ftIntl)" },
    { epsg: "2253", name: "Michigan South (ftIntl)" },
  ]},
  { state: "Minnesota", zones: [
    { epsg: "26849", name: "Minnesota North (ftUS)" },
    { epsg: "26850", name: "Minnesota Central (ftUS)" },
    { epsg: "26851", name: "Minnesota South (ftUS)" },
  ]},
  { state: "Mississippi", zones: [
    { epsg: "2254", name: "Mississippi East (ftUS)" },
    { epsg: "2255", name: "Mississippi West (ftUS)" },
  ]},
  { state: "Missouri", zones: [
    { epsg: "26896", name: "Missouri East (ftUS)" },
    { epsg: "26897", name: "Missouri Central (ftUS)" },
    { epsg: "26898", name: "Missouri West (ftUS)" },
  ]},
  { state: "Montana", zones: [
    { epsg: "2256", name: "Montana (ftIntl)" },
  ]},
  { state: "Nebraska", zones: [
    { epsg: "26852", name: "Nebraska (ftUS)" },
  ]},
  { state: "Nevada", zones: [
    { epsg: "3421", name: "Nevada East (ftUS)" },
    { epsg: "3422", name: "Nevada Central (ftUS)" },
    { epsg: "3423", name: "Nevada West (ftUS)" },
  ]},
  { state: "New Hampshire", zones: [
    { epsg: "3437", name: "New Hampshire (ftUS)" },
  ]},
  { state: "New Jersey", zones: [
    { epsg: "3424", name: "New Jersey (ftUS)" },
  ]},
  { state: "New Mexico", zones: [
    { epsg: "2257", name: "New Mexico East (ftUS)" },
    { epsg: "2258", name: "New Mexico Central (ftUS)" },
    { epsg: "2259", name: "New Mexico West (ftUS)" },
  ]},
  { state: "New York", zones: [
    { epsg: "2260", name: "New York East (ftUS)" },
    { epsg: "2261", name: "New York Central (ftUS)" },
    { epsg: "2262", name: "New York West (ftUS)" },
    { epsg: "2263", name: "New York Long Island (ftUS)" },
  ]},
  { state: "North Carolina", zones: [
    { epsg: "2264", name: "North Carolina (ftUS)" },
  ]},
  { state: "North Dakota", zones: [
    { epsg: "2265", name: "North Dakota North (ftIntl)" },
    { epsg: "2266", name: "North Dakota South (ftIntl)" },
  ]},
  { state: "Ohio", zones: [
    { epsg: "3753", name: "Ohio North (ftUS)" },
    { epsg: "3754", name: "Ohio South (ftUS)" },
  ]},
  { state: "Oklahoma", zones: [
    { epsg: "2267", name: "Oklahoma North (ftUS)" },
    { epsg: "2268", name: "Oklahoma South (ftUS)" },
  ]},
  { state: "Oregon", zones: [
    { epsg: "2269", name: "Oregon North (ftIntl)" },
    { epsg: "2270", name: "Oregon South (ftIntl)" },
  ]},
  { state: "Pennsylvania", zones: [
    { epsg: "2271", name: "Pennsylvania North (ftUS)" },
    { epsg: "2272", name: "Pennsylvania South (ftUS)" },
  ]},
  { state: "Rhode Island", zones: [
    { epsg: "3438", name: "Rhode Island (ftUS)" },
  ]},
  { state: "South Carolina", zones: [
    { epsg: "2273", name: "South Carolina (ftIntl)" },
  ]},
  { state: "South Dakota", zones: [
    { epsg: "4457", name: "South Dakota North (ftUS)" },
    { epsg: "3455", name: "South Dakota South (ftUS)" },
  ]},
  { state: "Tennessee", zones: [
    { epsg: "2274", name: "Tennessee (ftUS)" },
  ]},
  { state: "Texas", zones: [
    { epsg: "2275", name: "Texas North (ftUS)" },
    { epsg: "2276", name: "Texas North Central (ftUS)" },
    { epsg: "2277", name: "Texas Central (ftUS)" },
    { epsg: "2278", name: "Texas South Central (ftUS)" },
    { epsg: "2279", name: "Texas South (ftUS)" },
  ]},
  { state: "Utah", zones: [
    { epsg: "2921", name: "Utah North (ftIntl)" },
    { epsg: "2922", name: "Utah Central (ftIntl)" },
    { epsg: "2923", name: "Utah South (ftIntl)" },
  ]},
  { state: "Vermont", zones: [
    { epsg: "5646", name: "Vermont (ftUS)" },
  ]},
  { state: "Virginia", zones: [
    { epsg: "2283", name: "Virginia North (ftUS)" },
    { epsg: "2284", name: "Virginia South (ftUS)" },
  ]},
  { state: "Washington", zones: [
    { epsg: "2285", name: "Washington North (ftUS)" },
    { epsg: "2286", name: "Washington South (ftUS)" },
  ]},
  { state: "West Virginia", zones: [
    { epsg: "26869", name: "West Virginia North (ftUS)" },
    { epsg: "26870", name: "West Virginia South (ftUS)" },
  ]},
  { state: "Wisconsin", zones: [
    { epsg: "2287", name: "Wisconsin North (ftUS)" },
    { epsg: "2288", name: "Wisconsin Central (ftUS)" },
    { epsg: "2289", name: "Wisconsin South (ftUS)" },
  ]},
  { state: "Wyoming", zones: [
    { epsg: "3736", name: "Wyoming East (ftUS)" },
    { epsg: "3737", name: "Wyoming East Central (ftUS)" },
    { epsg: "3738", name: "Wyoming West Central (ftUS)" },
    { epsg: "3739", name: "Wyoming West (ftUS)" },
  ]},
];

const COORD_SYSTEM_FLAT = COORD_SYSTEM_GROUPS.flatMap((group) => group.zones);

function SectionTabs({ section, onSection }) {
  const tabs = [
    { id: "settings", label: "Settings", icon: SettingsIcon },
    { id: "legal", label: "Legal", icon: FileText },
    { id: "howto", label: "How-To", icon: BookOpen },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = section === tab.id;
        return (
          <Button
            key={tab.id}
            onClick={() => onSection(tab.id)}
            variant={active ? "default" : "secondary"}
            className="rounded-2xl px-4 py-3"
          >
            <Icon size={16} className="mr-2" /> {tab.label}
          </Button>
        );
      })}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <div className="font-bold text-slate-950 dark:text-slate-100">{label}</div>
        {hint && <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function PasswordRow({ session }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("info");

  const email = session?.user?.email || "Signed in";

  const save = async () => {
    if (pw.length < 8) {
      setMessage("Password must be at least 8 characters.");
      setKind("error");
      return;
    }
    if (pw !== pw2) {
      setMessage("Passwords don't match.");
      setKind("error");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await setUserPassword(pw);
      setPw("");
      setPw2("");
      setMessage("Password saved. Next time you sign in, you can use email + password instead of a magic link.");
      setKind("success");
    } catch (error) {
      setMessage(error?.message || "Could not save password.");
      setKind("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center gap-2 font-bold text-slate-950 dark:text-slate-100">
        <KeyRound size={16} /> Sign-in password
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
        Set or change a password so you can sign in without the magic-link email every time.
        Account: <span className="font-semibold">{email}</span>
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input
          type="password"
          value={pw}
          onChange={(event) => setPw(event.target.value)}
          placeholder="New password (min 8)"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          autoComplete="new-password"
        />
        <input
          type="password"
          value={pw2}
          onChange={(event) => setPw2(event.target.value)}
          placeholder="Confirm new password"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          autoComplete="new-password"
        />
        <Button onClick={save} disabled={saving || !pw || !pw2} className="rounded-2xl px-4 py-3">
          {saving ? "Saving..." : "Save Password"}
        </Button>
      </div>
      {message && (
        <div
          className={`mt-3 rounded-2xl px-3 py-2 text-xs font-semibold ${
            kind === "error"
              ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
              : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}

function SettingsBody({ theme, onThemeChange, defaultBasemap, onDefaultBasemapChange, defaultRadius, onDefaultRadiusChange, defaultCoordEpsg, onDefaultCoordChange, session }) {
  return (
    <div className="space-y-3">
      <PasswordRow session={session} />

      <Row label="Theme" hint="Switch between light and dark mode. Saved to this browser.">
        <div className="flex gap-2">
          <Button
            onClick={() => onThemeChange("light")}
            variant={theme === "light" ? "default" : "secondary"}
            className="rounded-2xl px-4 py-3"
          >
            <Sun size={16} className="mr-2" /> Light
          </Button>
          <Button
            onClick={() => onThemeChange("dark")}
            variant={theme === "dark" ? "default" : "secondary"}
            className="rounded-2xl px-4 py-3"
          >
            <Moon size={16} className="mr-2" /> Dark
          </Button>
        </div>
      </Row>

      <Row label="Default basemap" hint="The map will start with this basemap each time you open the app.">
        <select
          value={defaultBasemap}
          onChange={(event) => onDefaultBasemapChange(event.target.value)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          {BASEMAP_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </Row>

      <Row label="Default search radius" hint="How far from your GPS or the map center to search for points.">
        <select
          value={defaultRadius}
          onChange={(event) => onDefaultRadiusChange(Number(event.target.value))}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          {RADIUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </Row>

      <Row label="Default coordinate system" hint="Pre-fills the EPSG and coordinate system on new imports. All CONUS state plane zones (NAD83) listed; pick the one your state uses.">
        <select
          value={defaultCoordEpsg}
          onChange={(event) => {
            const picked = COORD_SYSTEM_FLAT.find((item) => item.epsg === event.target.value);
            if (picked) onDefaultCoordChange(picked.epsg, picked.name);
          }}
          className="max-w-xs rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          {COORD_SYSTEM_GROUPS.map((group) => (
            <optgroup key={group.state} label={group.state}>
              {group.zones.map((zone) => (
                <option key={zone.epsg} value={zone.epsg}>EPSG:{zone.epsg} — {zone.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </Row>
    </div>
  );
}

function LegalBody() {
  return (
    <div className="space-y-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
      <a
        href="/privacy.html"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 p-4 font-bold text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200"
      >
        <span>Privacy Policy</span>
        <span className="text-xs font-semibold underline">View full policy →</span>
      </a>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <div className="font-black">Placeholder language — have a lawyer review before relying on it.</div>
        <p className="mt-1 text-xs">Replace this entire panel with text reviewed by counsel before onboarding outside companies.</p>
      </div>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Not a substitute for a licensed surveyor</h3>
        <p className="mt-2">PointVault is a field productivity tool. The coordinates, descriptions, and observations stored or displayed in this app are working data shared by surveyors and crews for convenience. They are not a survey, a boundary determination, or a legal record. Do not use any point or attribute in this app as the basis for a land transaction, design decision, construction layout, or legal filing without independent verification by a licensed professional land surveyor in the jurisdiction the work is performed in.</p>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Data sharing and community contributions</h3>
        <p className="mt-2">When you mark a point as shared to the PointVault community, you grant other contributing companies the right to view its coordinates and attributes through the application, deduplicated against nearby contributions from others. Points you do not share remain visible only to members of your own company. Field notes left on community points are append-only, attributed to your company and user account, and visible to any company with full community access.</p>
        <p className="mt-2">By contributing data you represent that you have the right to share it and that the data does not violate any non-disclosure agreement, easement, or other obligation you owe to a third party.</p>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Accuracy and reliability</h3>
        <p className="mt-2">No warranty is made as to the accuracy, completeness, or fitness for any particular purpose of any data displayed by PointVault. Imports may contain errors, points may be mismatched or duplicated, GPS-derived locations are approximate, and community-shared points reflect the most recent or most reliable record available but may not be current. The app's distance, radius, and area calculations are computed approximations and are not substitutes for measured ground truth.</p>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">User responsibility</h3>
        <p className="mt-2">You are responsible for verifying any point or attribute in the field before acting on it. Use eye protection, locate utilities, follow OSHA and local safety regulations, and respect parcel boundaries and landowner permissions when navigating to any point. PointVault does not direct you to trespass on private property; map navigation links are provided for convenience only.</p>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">No warranty / limitation of liability</h3>
        <p className="mt-2">PointVault is provided "as is" and "as available," without warranties of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, and non-infringement. To the maximum extent permitted by applicable law, in no event will PointVault, its operators, or its contributors be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits or revenues, whether incurred directly or indirectly, arising out of or in connection with the use of the app or the data it displays.</p>
      </section>
    </div>
  );
}

function HowToBody() {
  return (
    <div className="space-y-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Getting started</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-6">
          <li>Open PointVault on your phone or PC and sign in with the email tied to your company invite.</li>
          <li>On your first sign-in, accept the invite (if you got one) or create a new company workspace.</li>
          <li>If you're inviting your team, go to the Team panel and tap <strong>Generate Team QR</strong>. Show that QR to anyone you want to add — they scan, enter their email, and join. The QR is good for 24 hours.</li>
        </ol>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Using the map in the field</h3>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>Tap <strong>You Are Here</strong> to lock the map to your phone's GPS. The map recenters as you walk.</li>
          <li>Pick a basemap with the row of buttons above the map: <strong>Aerial</strong>, <strong>Hybrid</strong> (aerial + roads/labels), <strong>Streets</strong>, <strong>Topo</strong>, or <strong>USGS Hi-Res</strong> (highest resolution but blanks out military areas).</li>
          <li>Tap <strong>Parcels</strong> to overlay Florida cadastral lines on top of the basemap.</li>
          <li>Tap any point marker to open its detail panel — coordinates, source file, status, and field notes if it's a community point.</li>
        </ul>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Scouting an area before you drive there</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-6">
          <li>Open the Map tab on your PC.</li>
          <li>Drag the map (or scroll-zoom) to where the project is. Follow-GPS automatically turns off.</li>
          <li>Click <strong>Search This Area</strong> to load points around the map center.</li>
          <li>Or — type an address into the search bar and press Enter. The map flies there and loads nearby points.</li>
        </ol>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Searching</h3>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>Type a <strong>job number, point ID, or source file</strong> in the search bar and press Enter. The map pans to those points.</li>
          <li>Type an <strong>address</strong> and press Enter. The map flies there and the search bar clears (so the filter doesn't hide the loaded points).</li>
          <li>Use the <strong>status</strong> and <strong>distance</strong> dropdowns next to the bar to narrow the list down.</li>
        </ul>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Importing data</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-6">
          <li>Open the <strong>Data Import</strong> tab.</li>
          <li>Upload a single CSV/TXT file, a batch of files, or an entire folder. They are queued for the cloud worker.</li>
          <li>Watch the import-jobs list for progress. Each job goes from <em>queued</em> → <em>processing</em> → <em>processed</em> (or <em>failed</em>).</li>
          <li>Click into any job to see counts (accepted, review, rejected, duplicates) and download the cleaned output files.</li>
        </ol>
      </section>

      <section>
        <h3 className="font-black text-slate-950 dark:text-slate-100">Community sharing</h3>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>Points you import default to <strong>company private</strong> — only your team sees them.</li>
          <li>Sharing a point to the community pool merges it with any other company's contribution at the same location.</li>
          <li>How much of another company's data you can see depends on your <strong>community access tier</strong>, which is earned by sharing your own points. The more you share, the more you can see.</li>
          <li>Once you have full community access, you can leave <strong>field notes</strong> on any community point where your company has shared a point — they're permanent and visible to other full-access companies.</li>
        </ul>
      </section>
    </div>
  );
}

export function SettingsTab(props) {
  const [section, setSection] = useState("settings");
  return (
    <div className="space-y-4">
      <Card className="rounded-3xl border-0 shadow-xl dark:bg-slate-800">
        <CardContent className="p-5">
          <div className="mb-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Account</div>
            <h2 className="mt-1 text-2xl font-black text-slate-950 dark:text-slate-100">Settings</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Theme, defaults, legal terms, and how-to instructions.
            </p>
          </div>
          <SectionTabs section={section} onSection={setSection} />
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-0 shadow-xl dark:bg-slate-800">
        <CardContent className="p-5">
          {section === "settings" && <SettingsBody {...props} />}
          {section === "legal" && <LegalBody />}
          {section === "howto" && <HowToBody />}
        </CardContent>
      </Card>
    </div>
  );
}
