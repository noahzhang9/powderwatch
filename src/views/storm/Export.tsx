import { useEffect, useRef, useState } from 'react';
import { snapshotInfo } from '../../lib/cache';
import { exportFileName, forecastDailyCsv, forecastMarkdown, type ForecastExportInput } from '../../lib/export';

/** How long the menu's confirmation ("Copied") stays, ms. */
const STATUS_MS = 2500;

/** Saves text as a file through a temporary object URL (nothing leaves the browser). */
function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The Forecast tab's Export menu: "Copy for AI" (a Markdown summary on the clipboard, or saved as a .md
 * file where the clipboard is unavailable) and "Download CSV (daily)". Both are built from what the page
 * has already loaded, so exporting makes no request; the snapshot's age comes from the manifest it read.
 */
export function ExportMenu({ input }: { input: Omit<ForecastExportInput, 'snapshotAt' | 'siteUrl'> }) {
  const [status, setStatus] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = (text: string) => {
    setStatus(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(''), STATUS_MS);
  };
  const full = async (): Promise<ForecastExportInput> => ({
    ...input,
    snapshotAt: (await snapshotInfo().catch(() => null))?.generatedAt ?? null,
    siteUrl: window.location.href,
  });
  const close = () => menu.current?.removeAttribute('open');

  const copyForAi = async () => {
    close();
    const md = forecastMarkdown(await full());
    try {
      await navigator.clipboard.writeText(md);
      say('Copied: paste it into your AI chat');
    } catch {
      saveFile(exportFileName(input, 'forecast.md'), md, 'text/markdown');
      say('Clipboard unavailable: saved as a .md file');
    }
  };
  const downloadCsv = async () => {
    close();
    saveFile(exportFileName(input, 'daily.csv'), forecastDailyCsv(await full()), 'text/csv');
    say('Saved the daily CSV');
  };

  return (
    <span className="relative inline-flex items-center gap-2">
      <details ref={menu} className="relative">
        <summary className="btn list-none [&::-webkit-details-marker]:hidden" title="Export this band's forecast: a summary to paste into an AI chat, or a CSV">
          Export ▾
        </summary>
        <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-md border border-line bg-surface p-1 shadow-md text-sm" role="menu">
          <button type="button" role="menuitem" className="block w-full text-left rounded px-2.5 py-1.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent" onClick={copyForAi}>
            Copy for AI
            <span className="block text-[11px] text-ink-3">Daily table, ensemble chances and a data dictionary, as Markdown</span>
          </button>
          <button type="button" role="menuitem" className="block w-full text-left rounded px-2.5 py-1.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent" onClick={downloadCsv}>
            Download CSV (daily)
            <span className="block text-[11px] text-ink-3">One row per day, model and variable, in the units shown</span>
          </button>
        </div>
      </details>
      <span className="text-[11px] text-ink-2" aria-live="polite">{status}</span>
    </span>
  );
}
