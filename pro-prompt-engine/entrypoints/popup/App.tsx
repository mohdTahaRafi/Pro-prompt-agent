/**
 * Popup App — "Remote Control" for the active browser tab.
 *
 * [Phase 1] Ghost Autocomplete toggle removed (§5.1 — the ghost-text
 * suggestion manager is out of the build). Added: the per-origin
 * grant/revoke flow (§4) — this is the only screen a
 * chrome.permissions.request() user-gesture can originate from, so it
 * lives here rather than in the dashboard tab.
 */
import { useEffect, useState } from 'react';
import type { Profile } from '@lib/types/profile.types';
import { toOrigin } from '@lib/policy/scope';

function send<T = any>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload }).then((r: any) => {
    if (r?.status === 'error') throw new Error(r.message);
    return r?.data as T;
  });
}

function sendToActiveTab(type: string, payload?: unknown) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type, payload });
  });
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProvider, setActiveProvider] = useState('webgpu');
  // Score starts null — only updated when user explicitly scores
  const [scoreData, setScoreData] = useState<{ score: number; critique: string } | null>(null);
  const [showCritique, setShowCritique] = useState(false);
  const [status, setStatus] = useState('');
  const [scoring, setScoring] = useState(false);

  // ── Per-origin grant state (§4) ──
  const [currentOrigin, setCurrentOrigin] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);

  useEffect(() => {
    send<Profile[]>('GET_ALL_PROFILES').then(p => setProfiles(p || [])).catch(() => {});
    chrome.storage.local.get(['activeProvider'], (r: { activeProvider?: string }) => {
      setActiveProvider(r.activeProvider || 'webgpu');
    });

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const origin = tabs[0]?.url ? toOrigin(tabs[0].url) : null;
      setCurrentOrigin(origin);
      if (origin) {
        const isGranted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
        setGranted(isGranted);
      }
    });
  }, []);

  const setProfile = async (id: number) => {
    await send('SET_ACTIVE_PROFILE', { id });
    setProfiles(prev => prev.map(p => ({ ...p, isActive: p.id === id ? 1 : 0 })));
  };

  const handleGrantToggle = async () => {
    if (!currentOrigin) return;
    setGrantBusy(true);
    try {
      if (granted) {
        await send('REVOKE_ORIGIN', { origin: currentOrigin });
        setGranted(false);
      } else {
        // chrome.permissions.request (inside GRANT_ORIGIN's handler) must run
        // off a user gesture — this handler runs synchronously off the
        // button's onClick, so the transient-activation window is still open
        // when the message reaches the service worker.
        await send('GRANT_ORIGIN', { origin: currentOrigin });
        setGranted(true);
      }
    } catch (e: any) {
      setStatus('❌ ' + e.message);
    }
    setGrantBusy(false);
  };

  const handleScore = async () => {
    setScoring(true);
    setStatus('📊 Scoring active input...');
    try {
      // Ask content script to grab text and forward to SW
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) { setStatus('No active tab.'); setScoring(false); return; }
      // Trigger score via toolbar's handler (works on LLM sites)
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_ACTION', action: 'score_active' });

      // Also listen for a response by querying score directly
      // Get text from tab via scripting API as fallback
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          let el = document.activeElement as HTMLElement;
          while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
          if (!el || el === document.body) el = document.querySelector('textarea, [contenteditable="true"]') as HTMLElement;
          return el ? ((el as HTMLInputElement).value || el.textContent || '') : '';
        }
      });

      const text = result?.result as string;
      if (!text?.trim()) { setStatus('⚠️ No text in active input.'); setScoring(false); return; }

      const scoreRes = await send<{ score: number; critique: string }>('SCORE', { prompt: text });
      setScoreData(scoreRes);
      setStatus('');
    } catch (e: any) {
      setStatus('❌ ' + e.message);
    }
    setScoring(false);
  };

  const scoreColor = scoreData
    ? scoreData.score >= 80 ? 'text-accent-green' : scoreData.score >= 50 ? 'text-accent-yellow' : 'text-accent-red'
    : 'text-text-muted';

  return (
    <div className="w-[400px] h-auto min-h-[500px] bg-background text-text-primary p-5 flex flex-col gap-4">

      {/* Header: Model + Score side by side */}
      <div className="flex items-center justify-between pb-4 border-b border-border-default">
        <div>
          <h1 className="text-body font-bold mb-0.5">⚡ Pro Prompt</h1>
          <div className="flex items-center gap-2 text-small text-text-muted">
            <span className="w-2 h-2 rounded-full bg-accent-green" />
            Provider: <span className="uppercase text-text-primary">{activeProvider}</span>
          </div>
        </div>

        {/* Score badge — clickable for critique, with inline Score button */}
        <div className="flex items-center gap-2">
          <button onClick={handleScore} disabled={scoring}
            className="btn-secondary px-2 py-1 text-xs border border-border-default hover:border-primary/50 rounded-lg">
            {scoring ? '⏳' : '📊 Score'}
          </button>
          <button onClick={() => scoreData && setShowCritique(!showCritique)}
            className={`flex flex-col items-center justify-center p-2 rounded-xl bg-surface border transition-all min-w-[60px] ${scoreData ? 'border-primary/30 cursor-pointer hover:border-primary/60' : 'border-border-default cursor-default'}`}
            title={scoreData?.critique}>
            <span className="text-[9px] text-text-muted uppercase tracking-wider">Score</span>
            <span className={`text-h2 font-bold ${scoreColor}`}>
              {scoreData ? scoreData.score : '--'}
            </span>
          </button>
        </div>
      </div>

      {/* Critique popover */}
      {showCritique && scoreData && (
        <div className="bg-surface border border-border-default rounded-xl p-3 text-small text-text-secondary animate-fade-in">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-text-primary text-xs uppercase tracking-wide">Score Analysis</span>
            <button onClick={() => setShowCritique(false)} className="text-text-muted hover:text-text-primary bg-transparent border-none cursor-pointer text-sm">✕</button>
          </div>
          <p className="leading-relaxed">{scoreData.critique}</p>
          <button onClick={() => { sendToActiveTab('TRIGGER_ACTION', { action: 'refactor_active' }); setShowCritique(false); }}
            className="btn-primary mt-2 px-3 py-1 text-xs w-full">
            🔄 Refactor Now
          </button>
        </div>
      )}

      {/* Per-Origin Access */}
      <div className="bg-surface border border-border-default rounded-xl p-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <span className="text-body font-medium block">Site Access</span>
            <span className="text-xs text-text-muted truncate block">
              {currentOrigin ?? 'Not available on this page'}
            </span>
          </div>
          <button
            onClick={handleGrantToggle}
            disabled={!currentOrigin || grantBusy}
            className={`px-3 py-1.5 text-xs rounded-lg shrink-0 ${granted ? 'btn-secondary border border-accent-red/40 text-accent-red' : 'btn-primary'} disabled:opacity-50`}
          >
            {grantBusy ? '⏳' : granted ? 'Revoke' : 'Allow this site'}
          </button>
        </div>
      </div>

      {/* Active Profile Grid — all profiles, scrollable */}
      <div>
        <h2 className="text-small font-semibold text-text-muted uppercase tracking-wider mb-2">Active Profile</h2>
        <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
          {profiles.map((p) => (
            <button key={p.id} onClick={() => p.id && setProfile(p.id)}
              className={`flex flex-col items-center justify-center p-2.5 rounded-xl border transition-all cursor-pointer text-center relative ${
                p.isActive ? 'border-primary bg-primary/10 shadow-glow-sm' : 'border-border-default bg-surface hover:border-primary/50'
              }`}>
              <span className="text-xl mb-0.5">{p.icon}</span>
              <span className={`text-[10px] font-medium leading-tight ${p.isActive ? 'text-primary' : 'text-text-secondary'}`}>{p.name}</span>
              {p.isActive ? <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full" /> : null}
            </button>
          ))}
          {profiles.length === 0 && (
            <div className="col-span-3 text-center py-4 text-text-muted text-small">Loading profiles...</div>
          )}
        </div>
      </div>

      {/* Page Actions */}
      <div>
        <h2 className="text-small font-semibold text-text-muted uppercase tracking-wider mb-2">Page Actions</h2>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => sendToActiveTab('TRIGGER_ACTION', { action: 'refactor_active' })}
            className="btn-primary py-2.5 flex flex-col items-center gap-0.5">
            <span className="text-lg">✨</span><span className="text-xs">Refactor</span>
          </button>
          <button onClick={() => sendToActiveTab('TRIGGER_SHOW_MODAL', { modal: 'generate' })}
            className="btn-secondary py-2.5 flex flex-col items-center gap-0.5 border border-border-default hover:bg-surface">
            <span className="text-lg">💡</span><span className="text-xs">Generate</span>
          </button>
          <button onClick={() => sendToActiveTab('TRIGGER_SHOW_MODAL', { modal: 'context' })}
            className="btn-secondary py-2.5 flex flex-col items-center gap-0.5 border border-border-default hover:bg-surface">
            <span className="text-lg">📥</span><span className="text-xs">Add Context</span>
          </button>
          <button onClick={() => sendToActiveTab('TRIGGER_SHOW_MODAL', { modal: 'snippet' })}
            className="btn-secondary py-2.5 flex flex-col items-center gap-0.5 border border-border-default hover:bg-surface">
            <span className="text-lg">📌</span><span className="text-xs">Add Snippet</span>
          </button>
        </div>
      </div>

      {status && <div className="text-xs text-text-secondary bg-surface rounded-lg px-3 py-2">{status}</div>}

      {/* Dashboard */}
      <div className="mt-auto pt-3 border-t border-border-default">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-body font-medium block">Dashboard</span>
            <span className="text-xs text-text-muted">Profiles, snippets, analytics</span>
          </div>
          <button onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('/options.html') })} className="btn-secondary px-3 py-1 text-xs">Open ↗</button>
        </div>
      </div>
    </div>
  );
}
