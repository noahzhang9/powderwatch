import { RESORTS, resortById } from './config/resorts';
import { href, useRoute } from './hooks/useRoute';
import { usePrefs } from './lib/prefs';
import { Seg } from './components/ui';
import { Dashboard } from './views/Dashboard';
import { ResortView } from './views/ResortView';
import { About } from './views/About';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const route = useRoute();
  const { units, setUnits, theme, setTheme } = usePrefs();
  const resort = route[0] === 'resort' ? resortById(route[1] ?? '') : undefined;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href={href()} className="font-semibold text-lg tracking-tight flex items-center gap-2">
            <span aria-hidden>❄</span> PowderWatch
          </a>
          <nav className="flex gap-4 text-sm text-ink-2" aria-label="Resorts">
            {RESORTS.map((r) => (
              <a key={r.id} href={href('resort', r.id)} className={resort?.id === r.id ? 'text-ink font-semibold' : 'hover:text-ink'}>
                {r.short}
              </a>
            ))}
            <a href={href('about')} className={route[0] === 'about' ? 'text-ink font-semibold' : 'hover:text-ink'}>
              Methods
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Seg label="Units" value={units} onChange={setUnits} options={[{ value: 'metric', label: 'cm · m' }, { value: 'imperial', label: 'in · ft' }]} />
            <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 pb-16">
        <ErrorBoundary resetKey={route.join('/')}>
          {route[0] === 'about' ? <About /> : resort ? <ResortView resort={resort} tab={route[2]} /> : <Dashboard />}
        </ErrorBoundary>
      </main>
      <footer className="max-w-7xl mx-auto px-4 pb-8 text-[11px] text-ink-3 leading-relaxed [&_a]:underline">
        <p>
          Forecasts: <a href="https://open-meteo.com/">Open-Meteo</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>), from ECMWF, NOAA, ECCC, DWD, UK Met Office and MeteoSwiss models.
        </p>
        <p className="mt-1">
          Observations: <a href="https://wcc.sc.egov.usda.gov/">USDA NRCS SNOTEL</a>; Data Source: <a href="https://eccc-msc.github.io/open-data/licence/readme_en/">Environment and Climate Change Canada</a>;
          contains information licensed under the <a href="https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc">Open Government Licence – British Columbia</a> (BC River Forecast Centre);{' '}
          <a href="https://www.slf.ch">WSL Institute for Snow and Avalanche Research SLF</a> (CC BY 4.0); Source: <a href="https://www.meteoswiss.admin.ch">MeteoSwiss</a> (CC BY 4.0).
          Station data is processed (daily aggregation, unit conversion, plausibility filtering) — see <a href="./data/NOTICE.md">data notice</a>.
        </p>
        <p className="mt-1">Station depths are measurements near each resort, not resort-reported base depths. Personal, non-commercial project.</p>
      </footer>
    </div>
  );
}
