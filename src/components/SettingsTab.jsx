import React, { useState } from "react";
import { BookOpen, FileText, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

const COORD_SYSTEM_OPTIONS = [
  { epsg: "2238", name: "NAD83 / Florida North (ftUS)" },
  { epsg: "2237", name: "NAD83 / Florida East (ftUS)" },
  { epsg: "2239", name: "NAD83 / Florida West (ftUS)" },
  { epsg: "2240", name: "NAD83 / Georgia East (ftUS)" },
  { epsg: "2241", name: "NAD83 / Georgia West (ftUS)" },
  { epsg: "2249", name: "NAD83 / Massachusetts Mainland (ftUS)" },
];

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

function SettingsBody({ theme, onThemeChange, defaultBasemap, onDefaultBasemapChange, defaultRadius, onDefaultRadiusChange, defaultCoordEpsg, onDefaultCoordChange }) {
  return (
    <div className="space-y-3">
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

      <Row label="Default coordinate system" hint="Pre-fills the EPSG and coordinate system on new imports.">
        <select
          value={defaultCoordEpsg}
          onChange={(event) => {
            const picked = COORD_SYSTEM_OPTIONS.find((item) => item.epsg === event.target.value);
            if (picked) onDefaultCoordChange(picked.epsg, picked.name);
          }}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          {COORD_SYSTEM_OPTIONS.map((option) => (
            <option key={option.epsg} value={option.epsg}>EPSG:{option.epsg} — {option.name}</option>
          ))}
        </select>
      </Row>
    </div>
  );
}

function LegalBody() {
  return (
    <div className="space-y-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
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
