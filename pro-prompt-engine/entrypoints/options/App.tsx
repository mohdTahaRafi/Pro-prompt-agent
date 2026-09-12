/**
 * Dashboard (Options Page) — Pro Prompt Engine
 * Full-screen SaaS-style dashboard with sidebar and 6 views.
 * Includes recharts for Analytics visualization.
 */

import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';
import { WEBGPU_MODELS } from '@lib/types/llm.types';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';

function send<T = any>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload }).then((r: any) => {
    if (r?.status === 'error') throw new Error(r.message);
    return r?.data as T;
  });
}

type View = 'profiles' | 'snippets' | 'library' | 'analytics' | 'context' | 'perception' | 'runs' | 'settings';

const NAV: { key: View; label: string; icon: string }[] = [
  { key: 'profiles', label: 'Profiles', icon: '👤' },
  { key: 'snippets', label: 'Snippets', icon: '📌' },
  { key: 'library', label: 'Prompt Library', icon: '📚' },
  { key: 'analytics', label: 'Analytics', icon: '📊' },
  { key: 'context', label: 'Context Lab', icon: '🧪' },
  // [Phase 2 §9] the demonstrable artifact of THAT phase — not the side
  // panel, which does not exist until Phase 5.
  { key: 'perception', label: 'Perception', icon: '👁️' },
  // [Phase 5 §9] read-only run history/journal. The real, live-controlled
  // run lives in entrypoints/sidepanel/Cockpit.tsx — Phase 3/4's Copilot
  // and Plan panels are superseded, not merely renamed (RunsView's header).
  { key: 'runs', label: 'Runs', icon: '🤖' },
  { key: 'settings', label: 'Models & Settings', icon: '🧠' },
];

export default function App() {
  const [view, setView] = useState<View>('profiles');
  return (
    <div className="flex h-screen bg-background text-text-primary">
      <aside className="w-64 bg-surface border-r border-border-default flex flex-col shrink-0">
        <div className="px-6 py-5 border-b border-border-default">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">⚡</span>
            <div><h1 className="text-body font-bold">Pro Prompt Engine</h1><span className="text-small text-text-muted">v1.0.0</span></div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ key, label, icon }) => (
            <button key={key} onClick={() => setView(key)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-body transition-all duration-150 text-left cursor-pointer border-none
                ${view === key ? 'bg-primary/15 text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover bg-transparent'}`}>
              <span className="text-lg">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-border-default flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-accent-green" />
          <span className="text-small text-text-secondary">Extension Active</span>
        </div>
      </aside>

      <main className="flex-1 overflow-auto"><div className="max-w-5xl mx-auto p-8">
        {view === 'profiles' && <ProfilesView />}
        {view === 'snippets' && <SnippetsView />}
        {view === 'library' && <LibraryView />}
        {view === 'analytics' && <AnalyticsView />}
        {view === 'context' && <ContextLabView />}
        {view === 'perception' && <PerceptionView />}
        {view === 'runs' && <RunsView />}
        {view === 'settings' && <SettingsView />}
      </div></main>
    </div>
  );
}

// ═══ Profiles ═══
function ProfilesView() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile | null>(null);

  useEffect(() => { send<Profile[]>('GET_ALL_PROFILES').then(p => setProfiles(p || [])).catch(() => {}); }, []);

  const activate = async (p: Profile) => {
    if (!p.id) return;
    await send('SET_ACTIVE_PROFILE', { id: p.id });
    setProfiles(prev => prev.map(x => ({ ...x, isActive: x.id === p.id ? 1 : 0 })));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><h2 className="text-h1 font-bold">Profiles</h2><p className="text-body text-text-secondary mt-1">Manage your prompt engineering personas (4-file system).</p></div>
        <button onClick={() => {
            const newProfile: Profile = {
              name: 'New Profile', description: 'Describe your persona here.', icon: '🧑‍💻', isActive: 0, isCustom: true,
              contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '', scoringGuidelinesMd: '',
              agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 }, createdAt: Date.now(), updatedAt: Date.now()
            };
            send('SET_PROFILE', newProfile).then(() => send<Profile[]>('GET_ALL_PROFILES').then(setProfiles));
        }} className="btn-primary px-4 py-2">+ Create Profile</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {profiles.map(p => (
          <div key={p.id} onClick={() => setSelected(selected?.id === p.id ? null : p)}
            className={`card p-5 cursor-pointer transition-all duration-150 hover:border-primary/30
              ${p.isActive ? 'border-primary/50 shadow-glow-sm' : ''} ${selected?.id === p.id ? 'ring-2 ring-primary/50' : ''}`}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">{p.icon}</span>
                <div>
                  <h3 className="text-body font-semibold">{p.name}</h3>
                  {p.isActive && <span className="text-small text-accent-green font-medium">● Active</span>}
                </div>
              </div>
            </div>
            <p className="text-small text-text-secondary leading-relaxed mb-3" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.description}</p>
            <div className="flex items-center justify-between pt-3 border-t border-border-default">
              <span className="text-small text-text-muted">Context: {p.contextMd ? '✓' : '—'}</span>
              {!p.isActive && <button onClick={(e) => { e.stopPropagation(); activate(p); }} className="text-small text-primary hover:text-primary-light cursor-pointer bg-transparent border-none">Activate</button>}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <ProfileEditor key={selected.id} profile={selected} onSave={(updated) => {
          send('SET_PROFILE', updated).then(() => {
            send<Profile[]>('GET_ALL_PROFILES').then(setProfiles);
            setSelected(updated);
          });
        }} onDelete={() => {
          if (!selected.id) return;
          if (!confirm(`Delete profile "${selected.name}"?`)) return;
          send('DELETE_PROFILE', { id: selected.id }).then(() => {
            send<Profile[]>('GET_ALL_PROFILES').then(setProfiles);
            setSelected(null);
          });
        }} />
      )}
    </div>
  );
}

function ProfileEditor({ profile, onSave, onDelete }: { profile: Profile; onSave: (p: Profile) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState({ ...profile });
  const [saved, setSaved] = useState(false);
  const up = (k: keyof Profile, v: string) => setDraft(d => ({ ...d, [k]: v }));
  const tokenEst = Math.ceil((draft.contextMd?.length || 0) / 4);
  const save = () => { onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 2500); };

  return (
    <div className="mt-6 card p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-h2 font-bold">{draft.icon} Edit Profile</h3>
        <div className="flex items-center gap-3">
          {saved && <span className="text-small text-accent-green">✅ Saved</span>}
          <button onClick={onDelete} className="btn-icon w-8 h-8 hover:text-accent-red" title="Delete">🗑️</button>
          <button onClick={() => onSave(profile)} className="btn-icon w-8 h-8">✕</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div><label className="text-small text-text-muted block mb-1">Icon</label><input value={draft.icon} onChange={e => up('icon', e.target.value)} className="input-field" /></div>
        <div className="col-span-2"><label className="text-small text-text-muted block mb-1">Name</label><input value={draft.name} onChange={e => up('name', e.target.value)} className="input-field" /></div>
      </div>
      <div className="mb-4"><label className="text-small text-text-muted block mb-1">Description</label><input value={draft.description} onChange={e => up('description', e.target.value)} className="input-field" /></div>
      <div className="space-y-4">
        <div>
          <div className="flex justify-between mb-1"><label className="text-small text-text-muted">📄 Context.md</label><span className="text-small text-text-muted">~{tokenEst} tokens {tokenEst > 3800 ? '⚠️' : ''}</span></div>
          <textarea value={draft.contextMd} onChange={e => up('contextMd', e.target.value)} rows={4} className="input-field font-mono text-small resize-y w-full" placeholder="Knowledge context fed to agents..." />
        </div>
        <div><label className="text-small text-text-muted block mb-1">📋 PromptGuidelines.md</label><textarea value={draft.promptGuidelinesMd} onChange={e => up('promptGuidelinesMd', e.target.value)} rows={4} className="input-field font-mono text-small resize-y w-full" /></div>
        <div><label className="text-small text-text-muted block mb-1">📝 ProfileDescription.md</label><textarea value={draft.profileDescriptionMd} onChange={e => up('profileDescriptionMd', e.target.value)} rows={3} className="input-field font-mono text-small resize-y w-full" /></div>
        <div><label className="text-small text-text-muted block mb-1">🎯 ScoringGuidelines.md</label><textarea value={draft.scoringGuidelinesMd || ''} onChange={e => up('scoringGuidelinesMd', e.target.value)} rows={4} className="input-field font-mono text-small resize-y w-full" /></div>
      </div>
      <button onClick={save} className="btn-primary px-6 py-2 mt-5">💾 Save Profile</button>
    </div>
  );
}

// ═══ Snippets ═══
function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [prefix, setPrefix] = useState('');
  const [desc, setDesc] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => { load(); }, []);
  const load = () => send<Snippet[]>('GET_SNIPPETS').then(s => setSnippets(s || [])).catch(() => {});

  const create = async () => {
    if (!prefix.trim() || !body.trim()) return;
    await send('SAVE_SNIPPET', { id: editingId ?? undefined, prefix, description: desc, body });
    setPrefix(''); setDesc(''); setBody(''); setShowForm(false); setEditingId(null);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><h2 className="text-h1 font-bold">Snippets</h2><p className="text-body text-text-secondary mt-1">Reusable prompt fragments. Type <code className="text-primary bg-primary/10 px-1 rounded">/prefix</code> in any text field to insert.</p></div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary px-4 py-2">{showForm ? 'Cancel' : '+ New Snippet'}</button>
      </div>
      {showForm && (
        <div className="card p-5 mb-6 animate-fade-in">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div><label className="text-small text-text-muted block mb-1">Prefix</label><input value={prefix} onChange={e => {
                let val = e.target.value;
                if (!val.startsWith('/')) val = '/' + val.replace(/^\/+/, '');
                setPrefix(val);
              }} placeholder="/dev" className="input-field" /></div>
            <div><label className="text-small text-text-muted block mb-1">Description</label><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Senior dev persona" className="input-field" /></div>
          </div>
          <label className="text-small text-text-muted block mb-1">Body</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Full injection text..." className="input-field h-24 resize-none mb-4" />
          <button onClick={create} className="btn-primary px-4 py-2">Save Snippet</button>
        </div>
      )}
      <div className="space-y-3">
        {snippets.map(s => (
          <div key={s.id} className="card p-4 flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <code className="text-body font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{s.prefix}</code>
                <span className="text-small text-text-secondary">{s.description}</span>
              </div>
              <p className="text-small text-text-muted truncate">{s.body}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => { setPrefix(s.prefix); setDesc(s.description || ''); setBody(s.body); setEditingId(s.id!); setShowForm(true); }}
                className="btn-icon w-8 h-8 hover:text-primary">✏️</button>
              <button onClick={() => { if (s.id) send('DELETE_SNIPPET', { id: s.id }).then(load); }}
                className="btn-icon w-8 h-8 hover:text-accent-red">🗑️</button>
            </div>
          </div>
        ))}
        {snippets.length === 0 && <div className="text-center py-12 text-text-muted"><span className="text-3xl block mb-2">📌</span><p>No snippets yet.</p></div>}
      </div>
    </div>
  );
}

// ═══ Prompt Library ═══
function LibraryView() {
  const [history, setHistory] = useState<any[]>([]);
  useEffect(() => { send('GET_PROMPT_HISTORY', { limit: 50 }).then(h => setHistory(h || [])).catch(() => {}); }, []);

  return (
    <div>
      <h2 className="text-h1 font-bold mb-6">Prompt Library</h2>
      <div className="space-y-3">
        {history.map((e: any, i: number) => (
          <div key={e.id || i} className="card p-4">
            <p className="text-small text-text-secondary truncate mb-2">{e.originalPrompt?.slice(0, 120)}...</p>
            <div className="flex gap-3 text-small text-text-muted">
              <ScorePill score={e.score} />
              <span>{e.provider}</span><span>·</span><span>{e.iterations} iter</span><span>·</span>
              <span>{new Date(e.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
        {history.length === 0 && <div className="text-center py-12 text-text-muted"><span className="text-3xl block mb-2">📚</span><p>No prompts refined yet.</p></div>}
      </div>
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  const color = score >= 75 ? 'bg-accent-green/15 text-accent-green' : score >= 50 ? 'bg-accent-yellow-bg text-accent-yellow' : 'bg-accent-red-bg text-accent-red';
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-small font-medium ${color}`}>Score: {score}</span>;
}

// ═══ Analytics (recharts) ═══
function AnalyticsView() {
  const [history, setHistory] = useState<any[]>([]);
  useEffect(() => { send('GET_PROMPT_HISTORY', { limit: 100 }).then(h => setHistory(h || [])).catch(() => {}); }, []);

  // Aggregate data for charts
  const providerCounts: Record<string, number> = {};
  let totalScore = 0;
  history.forEach((e: any) => {
    providerCounts[e.provider] = (providerCounts[e.provider] || 0) + 1;
    totalScore += e.score || 0;
  });
  const avgScore = history.length ? Math.round(totalScore / history.length) : 0;

  const pieData = Object.entries(providerCounts).map(([name, value]) => ({ name, value }));
  const COLORS = ['#2563EB', '#10B981', '#FBBF24', '#EF4444'];

  // Score distribution
  const scoreBuckets = [
    { range: '0-25', count: history.filter((e: any) => e.score < 25).length },
    { range: '25-50', count: history.filter((e: any) => e.score >= 25 && e.score < 50).length },
    { range: '50-75', count: history.filter((e: any) => e.score >= 50 && e.score < 75).length },
    { range: '75-100', count: history.filter((e: any) => e.score >= 75).length },
  ];

  return (
    <div>
      <h2 className="text-h1 font-bold mb-6">Analytics</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard icon="📝" label="Prompts Processed" value={String(history.length)} color="text-primary" />
        <StatCard icon="📊" label="Average Score" value={avgScore ? String(avgScore) : '—'} color="text-accent-green" />
        <StatCard icon="⚡" label="Total Tokens" value={history.reduce((s: number, e: any) => s + (e.tokensUsed || 0), 0).toLocaleString()} color="text-accent-yellow" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Score Distribution Chart */}
        <div className="card p-6">
          <h3 className="text-h2 font-semibold mb-4">Score Distribution</h3>
          {history.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={scoreBuckets}>
                <XAxis dataKey="range" stroke="#64748B" fontSize={12} />
                <YAxis stroke="#64748B" fontSize={12} />
                <Tooltip contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#F8FAFC' }} />
                <Bar dataKey="count" fill="#2563EB" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart />}
        </div>

        {/* Provider Usage Pie */}
        <div className="card p-6">
          <h3 className="text-h2 font-semibold mb-4">Model Usage</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#F8FAFC' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart />}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3 mb-2"><span className="text-2xl">{icon}</span><span className="text-small text-text-muted">{label}</span></div>
      <span className={`text-h1 font-bold ${color}`}>{value}</span>
    </div>
  );
}

function EmptyChart() {
  return <div className="h-[200px] flex items-center justify-center text-text-muted text-small">No data yet. Start refining prompts!</div>;
}

// ═══ Context Lab ═══
function ContextLabView() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    send<Profile[]>('GET_ALL_PROFILES').then(p => {
      setProfiles(p || []);
      const active = p?.find((pr: Profile) => pr.isActive);
      if (active?.id) setSelectedId(active.id);
    }).catch(() => {});
  }, []);

  const feedContext = async () => {
    if (!input.trim() || !selectedId) return;
    setLoading(true);
    try {
      const result = await send('SAVE_CONTEXT', { profileId: selectedId, context: input, source: 'manual' });
      setStatus(result?.truncated ? `✅ Added (truncated to 4000 tokens, ${result.tokenCount} tokens now)` : `✅ Context added! (${result?.tokenCount || '?'} tokens)`);
      setInput('');
    } catch { setStatus('❌ Failed to save.'); }
    setLoading(false);
    setTimeout(() => setStatus(''), 4000);
  };

  return (
    <div>
      <h2 className="text-h1 font-bold mb-2">Context Lab</h2>
      <p className="text-body text-text-secondary mb-6">Feed context to a profile's Context.md. Enforced at 4000 tokens (gpt-tokenizer).</p>
      <div className="card p-6">
        <label className="text-small text-text-muted block mb-2">Target Profile</label>
        <select value={selectedId ?? ''} onChange={e => setSelectedId(Number(e.target.value))} className="input-field w-full mb-4">
          {profiles.map(p => <option key={p.id} value={p.id}>{p.icon} {p.name} {p.isActive ? '(Active)' : ''}</option>)}
        </select>
        <label className="text-small text-text-muted block mb-2">Context Text</label>
        <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Paste notes, docs, or context..." className="input-field w-full h-40 resize-none font-mono text-small mb-2" />
        <span className="text-small text-text-muted block mb-4">~{Math.ceil(input.length / 4)} estimated tokens</span>
        <div className="flex items-center gap-3">
          <button onClick={feedContext} disabled={loading || !input.trim()} className="btn-primary px-6 py-2.5">{loading ? '⏳ Processing...' : '📥 Feed Context'}</button>
          {status && <span className="text-small animate-fade-in">{status}</span>}
        </div>
      </div>
    </div>
  );
}

// ═══ Model Tiers status card — §11's Models tab ═══
//
// "A user opens the dashboard's Models tab and sees four tiers listed with
// what each is currently running on" (§11's Milestone Definition).
interface TierRow { label: string; available: boolean; engine: string | null; model: string | null; reason?: string }

function ModelTiersCard() {
  const [posture, setPosture] = useState<'local-only' | 'hybrid'>('local-only');
  const [rows, setRows] = useState<TierRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const cap = await send<any>('GET_POSTURE_CAPABILITY', { posture });
      setRows([
        { label: 'Planner', available: cap.planner.available, engine: cap.planner.engine, model: cap.planner.model, reason: cap.planner.reason },
        { label: 'Judge', available: cap.judge.available, engine: cap.judge.engine, model: cap.judge.model },
        { label: 'Vision', available: cap.vision.available, engine: cap.vision.engine, model: null },
        { label: 'Inline', available: cap.inline.available, engine: cap.inline.engine, model: null },
      ]);
    } catch {
      setRows(null);
    }
    setBusy(false);
  }

  useEffect(() => { refresh(); }, [posture]);

  return (
    <div className="card p-6 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-h2 font-semibold">Model Tiers</h3>
        <div className="flex items-center gap-2 text-small">
          <label className="text-text-muted">Posture</label>
          <select value={posture} onChange={(e) => setPosture(e.target.value as any)} className="input-field py-1">
            <option value="local-only">Local-only</option>
            <option value="hybrid">Hybrid</option>
          </select>
          <button onClick={refresh} disabled={busy} className="btn-secondary px-2 py-1 text-xs border border-border-default">{busy ? '⏳' : '↻'}</button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(rows ?? []).map((r) => (
          <div key={r.label} className={`p-3 rounded-xl border ${r.available ? 'border-accent-green/40' : 'border-accent-yellow/40 bg-accent-yellow-bg'}`}>
            <span className="text-small font-semibold block">{r.label}</span>
            {r.available ? (
              <>
                <span className="text-xs text-accent-green block">ready</span>
                <span className="text-xs text-text-muted block truncate" title={r.model ?? r.engine ?? ''}>{r.engine ?? '—'}{r.model ? ` · ${r.model}` : ''}</span>
              </>
            ) : (
              <span className="text-xs text-text-secondary block">{r.reason ?? 'not reachable'}</span>
            )}
          </div>
        ))}
        {!rows && <span className="text-small text-text-muted col-span-4">Loading…</span>}
      </div>
    </div>
  );
}

// ═══ Settings ═══
function SettingsView() {
  const [remoteKey, setRemoteKey] = useState('');
  const [remoteBaseUrl, setRemoteBaseUrl] = useState('https://api.groq.com/openai/v1');
  const [remoteModel, setRemoteModel] = useState('llama-3.3-70b-versatile');
  const [remoteLabel, setRemoteLabel] = useState('Groq');
  const [masked, setMasked] = useState(true);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaPlannerModel, setOllamaPlannerModel] = useState('qwen2.5:14b');
  const [autocompleteEnabled, setAutocompleteEnabledState] = useState(true);
  const [status, setStatus] = useState('');
  const [downloadProgress, setDownloadProgress] = useState<{ text: string, progress: number } | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [webGpuActiveModel, setWebGpuActiveModel] = useState<string | null>(null);
  const [migrationNotice, setMigrationNotice] = useState(false);

  useEffect(() => {
    // [Phase 1 PRE-5, Phase 4] the key lives in storage.local only.
    // lib/model/engines/remote.ts performs the one-time migration out of
    // the Phase 1 groqApiKey/groqModel fields (and, before that, out of
    // storage.sync) on first read; here we just read local and show the
    // one-time notice if it fired.
    chrome.storage.local.get(
      ['remoteApiKey', 'remoteBaseUrl', 'remoteModel', 'remoteLabel', 'keyMigrationNotice', 'keyMigrationNoticeShown'],
      (r: { remoteApiKey?: string; remoteBaseUrl?: string; remoteModel?: string; remoteLabel?: string; keyMigrationNotice?: number; keyMigrationNoticeShown?: boolean }) => {
        if (r.remoteApiKey) setRemoteKey(r.remoteApiKey);
        if (r.remoteBaseUrl) setRemoteBaseUrl(r.remoteBaseUrl);
        if (r.remoteModel) setRemoteModel(r.remoteModel);
        if (r.remoteLabel) setRemoteLabel(r.remoteLabel);
        if (r.keyMigrationNotice && !r.keyMigrationNoticeShown) {
          setMigrationNotice(true);
          chrome.storage.local.set({ keyMigrationNoticeShown: true });
        }
      });
    chrome.storage.local.get(
      ['ollamaBaseUrl', 'ollamaPlannerModel', 'downloadedModels', 'autocompleteEnabled'],
      (r: { ollamaBaseUrl?: string; ollamaPlannerModel?: string; downloadedModels?: string[]; autocompleteEnabled?: boolean }) => {
        if (r.ollamaBaseUrl) setOllamaUrl(r.ollamaBaseUrl);
        if (r.ollamaPlannerModel) setOllamaPlannerModel(r.ollamaPlannerModel);
        if (r.downloadedModels) setDownloadedModels(r.downloadedModels);
        if (r.autocompleteEnabled !== undefined) setAutocompleteEnabledState(r.autocompleteEnabled);
      });

    // Use WEBGPU_GET_STATE routed through SW (not direct offscreen bypass)
    send('WEBGPU_GET_STATE').then((data: any) => {
      if (data?.model && data?.state === 'hot') setWebGpuActiveModel(data.model);
    }).catch(() => {});

    const listener = (msg: any) => {
      if (msg.type === 'MODEL_STATE_CHANGED' && msg.payload?.state === 'loading') {
        setDownloadProgress({ text: msg.payload.text, progress: msg.payload.progress });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const flash = (msg: string) => { setStatus(msg); setTimeout(() => setStatus(''), 3000); };

  const loadModel = async (modelId: string) => {
    setDownloadingModel(modelId);
    setDownloadProgress({ text: 'Starting download...', progress: 0 });
    try {
      await send('LOAD_MODEL', { model: modelId });
      flash(`✅ Loaded ${modelId}`);
      setWebGpuActiveModel(modelId);
      
      setDownloadedModels(prev => {
        if (prev.includes(modelId)) return prev;
        const newArr = [...prev, modelId];
        chrome.storage.local.set({ downloadedModels: newArr });
        return newArr;
      });
      
    } catch (e: any) {
      flash(`❌ Error: ${e.message}`);
    } finally {
      setDownloadingModel(null);
      setDownloadProgress(null);
    }
  };

  return (
    <div>
      <h2 className="text-h1 font-bold mb-6">Models &amp; Settings</h2>

      {migrationNotice && (
        <div className="card p-4 mb-4 border border-accent-yellow/40 bg-accent-yellow-bg text-small text-text-primary flex items-start justify-between gap-4">
          <p>Your API key was moved to this device only. It was previously synced to every browser signed into your Google account. If you used Pro Prompt on another machine, you will need to re-enter it there.</p>
          <button onClick={() => setMigrationNotice(false)} className="btn-icon w-6 h-6 shrink-0">✕</button>
        </div>
      )}

      {/* §11 — the four tiers, what each is currently running on */}
      <ModelTiersCard />

      {/* Remote provider — the Hybrid planner's remote entry (§5.4) */}
      <div className="card p-6 mb-4">
        <h3 className="text-h2 font-semibold mb-1">Remote Provider</h3>
        <p className="text-small text-text-muted mb-3">
          Used ONLY when a run's posture is set to Hybrid (chosen per-run in the Copilot panel, never silently).
          Any OpenAI-compatible endpoint — Groq, OpenAI, OpenRouter, Together, a local gateway. Stored on this device only.
        </p>
        <label className="text-small text-text-muted block mb-1">Base URL</label>
        <input type="text" value={remoteBaseUrl} onChange={e => setRemoteBaseUrl(e.target.value)} placeholder="https://api.groq.com/openai/v1" className="input-field w-full mb-3" />
        <label className="text-small text-text-muted block mb-1">API Key</label>
        <div className="flex gap-2 mb-3">
          <div className="flex-1 relative">
            <input type={masked ? 'password' : 'text'} value={remoteKey} onChange={e => setRemoteKey(e.target.value)} placeholder="sk-..." className="input-field pr-10 w-full" />
            <button onClick={() => setMasked(!masked)} className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer bg-transparent border-none">{masked ? '👁️' : '🙈'}</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-small text-text-muted block mb-1">Model</label>
            <input type="text" value={remoteModel} onChange={e => setRemoteModel(e.target.value)} placeholder="llama-3.3-70b-versatile" className="input-field w-full" />
          </div>
          <div>
            <label className="text-small text-text-muted block mb-1">Label (shown in the disclosure sentence)</label>
            <input type="text" value={remoteLabel} onChange={e => setRemoteLabel(e.target.value)} placeholder="Groq" className="input-field w-full" />
          </div>
        </div>
        <button onClick={async () => {
          try {
            // Requests the host permission for baseUrl's origin — must run
            // inside this onClick's user gesture (§5.4).
            await send('SET_REMOTE_CONFIG', { apiKey: remoteKey, baseUrl: remoteBaseUrl, model: remoteModel, label: remoteLabel });
            flash('✅ Remote provider saved.');
          } catch (e: any) { flash(`❌ ${e.message}`); }
        }} className="btn-primary px-4 py-2">Save</button>
      </div>

      {/* Ollama — the Local-only and Hybrid planner's local entry (§5.3) */}
      <div className="card p-6 mb-4">
        <h3 className="text-h2 font-semibold mb-3">Ollama (Planner)</h3>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-small text-text-muted block mb-1">Base URL</label>
            <input type="text" value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} className="input-field w-full" />
          </div>
          <div>
            <label className="text-small text-text-muted block mb-1">Planner model</label>
            <input type="text" value={ollamaPlannerModel} onChange={e => setOllamaPlannerModel(e.target.value)} placeholder="qwen2.5:14b" className="input-field w-full" />
          </div>
        </div>
        <button onClick={async () => {
          await send('SET_OLLAMA_CONFIG', { baseUrl: ollamaUrl, model: ollamaPlannerModel });
          flash('✅ Ollama config saved!');
        }} className="btn-primary px-4 py-2">Save</button>
      </div>

      {/* Ghost text — local-only inline completion (§9) */}
      <div className="card p-6 mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-h2 font-semibold mb-1">Ghost Text (Inline Completion)</h3>
          <p className="text-small text-text-muted">Local only — never sent anywhere, never shown on a password field.</p>
        </div>
        <button onClick={async () => {
          const next = !autocompleteEnabled;
          setAutocompleteEnabledState(next);
          await send('TOGGLE_AUTOCOMPLETE', { enabled: next });
        }} className={`px-4 py-2 rounded-lg ${autocompleteEnabled ? 'btn-primary' : 'btn-secondary border border-border-default'}`}>
          {autocompleteEnabled ? 'On' : 'Off'}
        </button>
      </div>

      {/* WebGPU / Offline Models — the judge tier's fallback engine (§5.2),
          used when Chrome's built-in Prompt API isn't available. */}
      <div className="card p-6 mb-4">
        <h3 className="text-h2 font-semibold mb-1">Offline Models (WebLLM) — Judge fallback</h3>
        <p className="text-small text-text-muted mb-4">Browser-compatible models. Recommended: Qwen2.5-0.5B or Phi-3-mini for best performance.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {prebuiltAppConfig.model_list.filter(m => (WEBGPU_MODELS as readonly string[]).includes(m.model_id)).map((model) => (
            <div key={model.model_id} className="border border-border-default bg-background p-4 rounded-xl flex flex-col">
              <h4 className="text-body font-semibold mb-1" style={{ wordBreak: 'break-all' }}>{model.model_id}</h4>
              <span className="text-small text-text-muted block mb-3">VRAM: {model.vram_required_MB ? (model.vram_required_MB / 1024).toFixed(1) + ' GB' : 'Unknown'}</span>
              <div className="mt-auto">
                {downloadingModel === model.model_id && downloadProgress ? (
                  <div className="mb-2">
                    <div className="w-full h-2 bg-surface rounded overflow-hidden mb-1">
                      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${downloadProgress.progress * 100}%` }}></div>
                    </div>
                    <span className="text-[10px] text-text-muted">{Math.round(downloadProgress.progress * 100)}% — {downloadProgress.text}</span>
                  </div>
                ) : null}
                <button 
                  onClick={() => loadModel(model.model_id)} 
                  disabled={(downloadingModel === model.model_id && downloadProgress !== null && downloadProgress.progress < 1) || webGpuActiveModel === model.model_id}
                  className={`btn-primary w-full py-1.5 text-small ${((downloadingModel === model.model_id && downloadProgress !== null && downloadProgress.progress < 1) || webGpuActiveModel === model.model_id) ? 'opacity-50 cursor-not-allowed' : ''} ${webGpuActiveModel === model.model_id ? 'bg-accent-green' : ''}`}>
                  {webGpuActiveModel === model.model_id ? 'Active (Loaded)' : 
                   downloadingModel === model.model_id ? 'Downloading...' : 
                   downloadedModels.includes(model.model_id) ? 'Load Model' : 'Download Model'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {status && <div className="text-body text-center animate-fade-in py-2">{status}</div>}
    </div>
  );
}

// ═══ Perception (Phase 2 §9) ═══
//
// The demonstrable artifact of the phase: a granted-origin dropdown, four
// perception-verb buttons, and a rendering of whatever comes back — a
// descriptor table, region completeness bars, the settle line, the
// exclusion count, and raw JSON with a "Save as fixture" download for the
// bake-off corpus (§10.1). Lives in the options page, not the side panel,
// which does not exist until Phase 5.
function PerceptionView() {
  const [origins, setOrigins] = useState<string[]>([]);
  const [origin, setOrigin] = useState<string>('');
  const [tabId, setTabId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [snapshot, setSnapshot] = useState<any>(null);
  const [settleResult, setSettleResult] = useState<any>(null);
  const [pageResult, setPageResult] = useState<any>(null);
  const [selectedHandle, setSelectedHandle] = useState<string>('');
  const [elementResult, setElementResult] = useState<any>(null);

  useEffect(() => {
    send<string[]>('GET_ACTIVE_GRANTS').then((list) => {
      setOrigins(list || []);
      if (list?.[0]) setOrigin(list[0]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!origin) { setTabId(null); return; }
    chrome.tabs.query({ url: `${origin}/*` }, (tabs) => {
      setTabId(tabs[0]?.id ?? null);
    });
  }, [origin]);

  async function perceive(type: string, payload: Record<string, unknown> = {}) {
    if (!tabId) { setError('No open tab found for this granted origin — open it in a tab first.'); return; }
    setBusy(type);
    setError('');
    try {
      const runId = `debug-${Date.now()}`;
      const resp: any = await chrome.tabs.sendMessage(tabId, { type, runId, ...payload });
      if (resp?.status === 'error') throw new Error(resp.message ?? 'Unknown error');
      if (type === 'PERCEIVE_STRUCTURE') setSnapshot(resp?.data ?? null);
      else if (type === 'WAIT_FOR_SETTLE') setSettleResult(resp?.data ?? null);
      else if (type === 'PERCEIVE_PAGE') setPageResult(resp?.data ?? null);
      else if (type === 'PERCEIVE_ELEMENT') setElementResult(resp?.data ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    setBusy(null);
  }

  function saveAsFixture() {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeOrigin = origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
    a.href = url;
    a.download = `${safeOrigin}-${snapshot.epoch}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    // Downloads to the browser's default Downloads folder — move the file
    // into tests/fixtures/snapshots/ and add its entry to corpus.json (§10.1).
  }

  function copyJson() {
    navigator.clipboard.writeText(JSON.stringify(snapshot ?? pageResult ?? settleResult, null, 2)).catch(() => {});
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-h1 font-bold">Perception</h2>
        <p className="text-body text-text-secondary mt-1">
          Look at a granted page and describe it the way a model reasons about it. Reads only —
          nothing here can click, type, or navigate.
        </p>
      </div>

      <div className="card p-5 mb-4 flex items-center gap-3 flex-wrap">
        <label className="text-small text-text-muted">Granted origin</label>
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} className="input-field">
          {origins.length === 0 && <option value="">No granted origins</option>}
          {origins.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <span className="text-xs text-text-muted">
          {tabId ? `tab ${tabId}` : origin ? 'no open tab for this origin' : ''}
        </span>

        <div className="flex-1" />

        <button onClick={() => perceive('PERCEIVE_STRUCTURE', { tokenBudget: 6000 })}
          disabled={!tabId || busy !== null}
          className="btn-primary px-4 py-2 disabled:opacity-50">
          {busy === 'PERCEIVE_STRUCTURE' ? '⏳' : '🔎'} Read structure
        </button>
        <button onClick={() => perceive('WAIT_FOR_SETTLE')}
          disabled={!tabId || busy !== null}
          className="btn-secondary px-4 py-2 border border-border-default disabled:opacity-50">
          {busy === 'WAIT_FOR_SETTLE' ? '⏳' : '⏱️'} Wait for settle
        </button>
        <button onClick={() => perceive('PERCEIVE_PAGE')}
          disabled={!tabId || busy !== null}
          className="btn-secondary px-4 py-2 border border-border-default disabled:opacity-50">
          {busy === 'PERCEIVE_PAGE' ? '⏳' : '📄'} Read page
        </button>
        <div className="flex items-center gap-1">
          <input value={selectedHandle} onChange={(e) => setSelectedHandle(e.target.value)}
            placeholder="e12" className="input-field w-20 text-center" />
          <button onClick={() => perceive('PERCEIVE_ELEMENT', { handle: selectedHandle })}
            disabled={!tabId || !selectedHandle || busy !== null}
            className="btn-secondary px-3 py-2 border border-border-default disabled:opacity-50">
            {busy === 'PERCEIVE_ELEMENT' ? '⏳' : '🎯'} Read element
          </button>
        </div>
      </div>

      {error && <div className="card p-3 mb-4 border border-accent-red/40 text-accent-red text-small">{error}</div>}

      {snapshot && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatTile label="Settled" value={snapshot.settled ? `after ${snapshot.settleWaitedMs} ms` : `NOT settled (${snapshot.settleWaitedMs} ms)`} />
            <StatTile label="Calibration" value={snapshot.settleCalibration} />
            <StatTile label="Epoch" value={String(snapshot.epoch)} />
            <StatTile label="Excluded (sensitive)" value={String(snapshot.excludedCount)} />
            <StatTile label="Elements shown" value={String(snapshot.elements.length)} />
            <StatTile label="Build time" value={`${snapshot.buildMs} ms`} />
            <StatTile label="Epoch suspect" value={snapshot.epochSuspect ? 'yes' : 'no'} />
            <StatTile label="Over budget" value={snapshot.overBudget ? `by ${snapshot.overBudget.by}` : 'no'} />
          </div>

          {snapshot.unreachableRegions.length > 0 && (
            <div className="card p-4 mb-4">
              <h3 className="text-body font-semibold mb-2">Unreachable regions</h3>
              <ul className="text-small text-text-secondary list-disc pl-5">
                {snapshot.unreachableRegions.map((r: string) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}

          <div className="card p-4 mb-4">
            <h3 className="text-body font-semibold mb-3">Region completeness</h3>
            <div className="space-y-2">
              {snapshot.regions.map((r: any) => (
                <div key={r.regionId}>
                  <div className="flex items-center justify-between text-small mb-1">
                    <span>{r.label} <span className="text-text-muted">({r.regionId})</span></span>
                    <span className={r.complete ? 'text-accent-green' : 'text-accent-yellow'}>
                      {r.complete ? 'complete' : 'pruned'}, {r.shown} of {r.total}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-surface rounded overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${r.total ? (r.shown / r.total) * 100 : 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4 mb-4 overflow-x-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-body font-semibold">Descriptors ({snapshot.elements.length})</h3>
              <div className="flex gap-2">
                <button onClick={copyJson} className="btn-secondary px-3 py-1 text-xs border border-border-default">Copy JSON</button>
                <button onClick={saveAsFixture} className="btn-primary px-3 py-1 text-xs">Save as fixture</button>
              </div>
            </div>
            <table className="w-full text-small">
              <thead>
                <tr className="text-left text-text-muted border-b border-border-default">
                  <th className="py-1 pr-3">Handle</th>
                  <th className="py-1 pr-3">Role</th>
                  <th className="py-1 pr-3">Name</th>
                  <th className="py-1 pr-3">Region</th>
                  <th className="py-1 pr-3">Visible</th>
                  <th className="py-1 pr-3">Actionable</th>
                  <th className="py-1 pr-3">Value</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.elements.map((el: any) => (
                  <tr key={el.handle} className="border-b border-border-default/50 hover:bg-surface-hover cursor-pointer"
                    onClick={() => setSelectedHandle(el.handle)}>
                    <td className="py-1 pr-3 font-mono">{el.handle}</td>
                    <td className="py-1 pr-3">{el.role}</td>
                    <td className="py-1 pr-3">"{el.name}"{!el.name && <span className="text-text-muted"> (unnamed)</span>}</td>
                    <td className="py-1 pr-3 text-text-muted">{el.regionId}</td>
                    <td className="py-1 pr-3">{el.visible ? (el.inViewport ? '✓ in view' : '✓ off-screen') : '✗ hidden'}</td>
                    <td className="py-1 pr-3">{el.actionable ? '✓' : '—'}</td>
                    <td className="py-1 pr-3 text-text-muted">{el.valueShape ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {settleResult && !snapshot && (
        <div className="card p-4 mb-4">
          <h3 className="text-body font-semibold mb-2">Settle result</h3>
          <p className="text-small">
            {settleResult.settled ? 'Settled' : 'Did NOT settle'} after {settleResult.waitedMs} ms
            ({settleResult.calibration} calibration) — {settleResult.mutations} mutations,
            {' '}{settleResult.resourceEntries} resources{settleResult.suspect ? ', epoch marked SUSPECT' : ''}.
          </p>
        </div>
      )}

      {pageResult && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-body font-semibold">Read page (class {pageResult.class})</h3>
            <span className="text-xs text-text-muted">{pageResult.text.length} chars</span>
          </div>
          <p className="text-small text-text-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">{pageResult.text}</p>
        </div>
      )}

      {elementResult && (
        <div className="card p-4 mb-4">
          <h3 className="text-body font-semibold mb-2">Read element</h3>
          <pre className="text-xs bg-background p-3 rounded-lg overflow-x-auto">{JSON.stringify(elementResult, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="text-body font-semibold">{value}</div>
    </div>
  );
}

// ═══ Runs — Phase 5 §9 ═══
//
// Phase 3/4's Copilot panel (one free-typed instruction, gated/acted/
// verified/journaled by hand) and Plan panel (display-only, no Execute
// button) are SUPERSEDED here: a real run now plans, is approved, executes
// its own step loop, and is controlled live — all of it in
// entrypoints/sidepanel/Cockpit.tsx, opened from the in-page GoalBox
// (lib/page/overlay/GoalBox.tsx) on any granted page. lib/agent/intent.ts,
// which resolved the Copilot panel's one-shot instructions, is deleted
// (§2). This view keeps read-only access to the run history and journal —
// useful for debugging — without duplicating the Cockpit's live controls.

interface RunListRow {
  id: number; goal: string; state: string; outcome?: string; origin: string; startedAt: number; endedAt?: number;
}

function RunsView() {
  const [runs, setRuns] = useState<RunListRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    send<RunListRow[]>('AGENT_LIST_RUNS').then((list) => setRuns(list ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (selected === null) { setEvents([]); return; }
    send<any[]>('AGENT_GET_RUN_EVENTS', { runId: selected }).then((evs) => setEvents(evs ?? [])).catch(() => {});
  }, [selected]);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-h1 font-bold">Runs</h2>
        <p className="text-body text-text-secondary mt-1">
          Read-only run history and journal. To start or control a run, open the side panel on a
          granted page — click Pro Prompt's in-page button, or Chrome's own side panel icon.
        </p>
      </div>

      {runs.length === 0 && (
        <div className="card p-5 text-small text-text-secondary">No runs yet.</div>
      )}

      {runs.map((r) => (
        <div key={r.id} className="card p-4 mb-3 cursor-pointer" onClick={() => setSelected(r.id === selected ? null : r.id)}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="font-medium">{r.goal || '(no goal recorded)'}</span>
              <span className="text-xs text-text-muted ml-2">{r.origin}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono px-2 py-0.5 rounded bg-surface-hover">{r.state}</span>
              {r.outcome && <span className="font-mono px-2 py-0.5 rounded bg-surface-hover">{r.outcome}</span>}
            </div>
          </div>

          {selected === r.id && (
            <div className="mt-4 overflow-x-auto" onClick={(e) => e.stopPropagation()}>
              <table className="w-full text-small">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border-default">
                    <th className="py-1 pr-3">Seq</th>
                    <th className="py-1 pr-3">Kind</th>
                    <th className="py-1 pr-3">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id ?? e.seq} className="border-b border-border-default/50">
                      <td className="py-1 pr-3 font-mono">{e.seq}</td>
                      <td className="py-1 pr-3">{e.kind}</td>
                      <td className="py-1 pr-3 text-text-muted font-mono text-xs">{JSON.stringify(e.data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
