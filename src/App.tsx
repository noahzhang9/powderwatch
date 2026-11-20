import { useEffect } from 'react';
import { RESORTS, resortById } from './config/resorts';
import { href, useRoute } from './hooks/useRoute';
import { usePrefs } from './lib/prefs';
import { Seg, SnapshotFreshness, SnapshotOnlyBanner, UpdateOverdueBanner } from './components/ui';
import { isSnapshotOnly } from './lib/cache';
import { Dashboard } from './views/Dashboard';
import { ResortView, TABS } from './views/ResortView';
import { About } from './views/About';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WPC_ATTRIBUTION, WPC_PAGE } from './lib/wpc';
import { SNODAS_ATTR, SNODAS_DOI } from './config/stations';

export function App() {
  const { parts, query } = useRoute();
  const { units, setUnits, theme, setTheme } = usePrefs();
  const resort = parts[0] === 'resort' ? resortById(parts[1] ?? '') : undefined;
  const tab = resort ? (TABS.find((t) => t.id === parts[2]) ?? TABS[0]) : undefined;
  const qs = query.toString();

  useEffect(() => {
    document.title = resort && tab ? `${resort.short} · ${tab.label} — PowderWatch` : parts[0] === 'about' ? 'Methods — PowderWatch' : 'PowderWatch';
  }, [resort, tab, parts]);

  const settings = (
    <>
      <Seg label="Units" value={units} onChange={setUnits} options={[{ value: 'imperial', label: 'in · ft' }, { value: 'metric', label: 'cm · m' }]} />
      <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
    </>
  );

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      {isSnapshotOnly() ? <SnapshotOnlyBanner /> : <UpdateOverdueBanner />}
      <header className="border-b border-line bg-surface">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href={href()} className="font-semibold text-lg tracking-tight flex items-center gap-2">
            <span aria-hidden>❄</span> PowderWatch
          </a>
          {/* Phones: logo and settings share the first row; the nav gets the full width below and wraps, so every link stays in view. */}
          <nav
            className="order-last sm:order-none w-full sm:w-auto flex flex-wrap gap-x-4 gap-y-1 whitespace-nowrap text-sm text-ink-2"
            aria-label="Resorts"
          >
            {RESORTS.map((r) => (
              <a
                key={r.id}
                // Switching resorts keeps the current tab and view settings.
                href={`${href('resort', r.id, tab?.id ?? 'storm')}${qs ? `?${qs}` : ''}`}
                aria-current={resort?.id === r.id ? 'page' : undefined}
                className={`underline-offset-[6px] decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-sm ${resort?.id === r.id ? 'text-ink font-semibold underline' : 'hover:text-ink hover:underline decoration-[var(--axis)]'}`}
              >
                {r.short}
              </a>
            ))}
            <a href={href('about')} aria-current={parts[0] === 'about' ? 'page' : undefined} className={`underline-offset-[6px] decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent rounded-sm ${parts[0] === 'about' ? 'text-ink font-semibold underline' : 'hover:text-ink hover:underline decoration-[var(--axis)]'}`}>
              Methods
            </a>
          </nav>
          <div className="ml-auto hidden sm:flex items-center gap-2">{settings}</div>
          <details className="ml-auto sm:hidden relative">
            <summary className="btn" aria-label="Settings">⚙</summary>
            <div className="absolute right-0 mt-2 z-20 card p-3 flex flex-col gap-2 shadow-lg">{settings}</div>
          </details>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="max-w-7xl mx-auto px-4 pb-16 outline-none">
        <ErrorBoundary resetKey={parts.join('/')}>
          {parts[0] === 'about' ? <About /> : resort && tab ? <ResortView resort={resort} tab={tab.id} /> : <Dashboard />}
        </ErrorBoundary>
      </main>
      <footer className="max-w-7xl mx-auto px-4 pb-8 text-[11px] text-ink-3 leading-relaxed [&_a]:underline">
        {!isSnapshotOnly() && <p className="mb-1"><SnapshotFreshness /></p>}
        <p>
          Forecasts: <a href="https://open-meteo.com/">Open-Meteo</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>), from ECMWF, NOAA, ECCC, DWD, UK Met Office and MeteoSwiss models.
          Official guidance (US resorts): NOAA National Blend of Models, via Open-Meteo; winter precipitation outlook from the{' '}
          <a href={WPC_PAGE}>{WPC_ATTRIBUTION}</a>.
        </p>
        <p className="mt-1">
          Observations: <a href="https://wcc.sc.egov.usda.gov/">USDA NRCS SNOTEL</a>; Data Source: <a href="https://eccc-msc.github.io/open-data/licence/readme_en/">Environment and Climate Change Canada</a>;
          contains information licensed under the <a href="https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc">Open Government Licence – British Columbia</a> (BC River Forecast Centre);{' '}
          <a href="https://www.slf.ch">WSL Institute for Snow and Avalanche Research SLF</a> (CC BY 4.0); Source: <a href="https://www.meteoswiss.admin.ch">MeteoSwiss</a> (CC BY 4.0).
          Station data is processed (daily aggregation, unit conversion, plausibility filtering) — see <a href="./data/NOTICE.md">data notice</a>.
        </p>
        <p className="mt-1">
          Modelled snowpack (US resorts, an option on the Snowpack tab): <a href={SNODAS_DOI}>{SNODAS_ATTR}</a>, National Operational Hydrologic Remote Sensing
          Center (2004), doi:10.7265/N5TB14TC. A model estimate, not a measurement.
        </p>
        <p className="mt-1">Station depths are measurements near each resort, not resort-reported base depths. Personal, non-commercial project.</p>
      </footer>
    </div>
  );
}
