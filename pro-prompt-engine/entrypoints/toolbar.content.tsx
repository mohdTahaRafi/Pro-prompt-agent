/**
 * Floating Toolbar — WXT Content Script UI
 * Collapsed: vertical icon-only pill | Expanded: labeled button list
 * Features: Refactor, Score, Generate, Manual Context, Scan Page, Select-to-Context, Autocomplete Toggle, Add Snippet, Dashboard
 */

import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import ReactDOM from 'react-dom/client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Readability } from '@mozilla/readability';
import type { Profile } from '@lib/types/profile.types';

/**
 * [Phase 1] Extracts page content in-place instead of round-tripping through
 * background.ts → chrome.tabs.sendMessage → a content script (the old path,
 * which relied on entrypoints/content.ts's SCAN_WEBPAGE listener — deleted
 * this phase along with the rest of the <all_urls> content script). This
 * component already runs inside the page with the DOM available, so the
 * extraction runs locally with no message hop and no dependency on the
 * `tabs` permission the extension does not hold.
 */
function extractPageContent(): string {
  try {
    const clone = document.cloneNode(true) as Document;
    const reader = new Readability(clone);
    const article = reader.parse();
    if (article && article.textContent) {
      return article.textContent.replace(/\s+/g, ' ').trim().slice(0, 15000);
    }
  } catch (err) {
    console.warn('[Pro Prompt] Readability failed, falling back to basic extraction', err);
  }

  const bodyClone = document.body.cloneNode(true) as HTMLElement;
  ['script', 'style', 'nav', 'header', 'footer', 'noscript', '[aria-hidden="true"]']
    .forEach(sel => bodyClone.querySelectorAll(sel).forEach(el => el.remove()));
  bodyClone.querySelectorAll('#pro-prompt-toolbar-host').forEach(el => el.remove());
  return (bodyClone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
}

const TARGET_SITES = ['chat.openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com', 'aistudio.google.com', 'perplexity.ai'];

export default defineContentScript({
  matches: ['*://chat.openai.com/*', '*://chatgpt.com/*', '*://claude.ai/*', '*://gemini.google.com/*', '*://aistudio.google.com/*', '*://perplexity.ai/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    if (!TARGET_SITES.some(s => window.location.hostname.includes(s))) return;

    const ui = await createShadowRootUi(ctx, {
      name: 'pro-prompt-toolbar',
      position: 'overlay',
      zIndex: 999999,
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(<ToolbarApp />);
        return root;
      },
      onRemove(root) { root?.unmount(); },
    });

    ui.mount();

    // Select-to-Context: mouseup listener on main document
    document.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 20) {
        // Dispatch custom event to toolbar React component
        window.dispatchEvent(new CustomEvent('pro-prompt-selection', { detail: { text: sel.toString().trim() } }));
      }
    });
  },
});

function ToolbarApp() {
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState({ x: window.innerWidth - 220, y: window.innerHeight / 2 - 200 });
  const [notification, setNotification] = useState('');
  const [activeModal, setActiveModal] = useState<'generate' | 'snippet' | 'context' | 'scan' | 'select-context' | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    chrome.storage.local.get(['toolbarPosition'], (r: { toolbarPosition?: { x: number; y: number; collapsed?: boolean } }) => {
      if (r.toolbarPosition) {
        setPos({ x: r.toolbarPosition.x, y: r.toolbarPosition.y });
        setCollapsed(r.toolbarPosition.collapsed || false);
      }
    });

    const msgListener = (msg: any) => {
      if (msg.type === 'TRIGGER_ACTION') {
        if (msg.action === 'refactor_active') handleRefactor();
        if (msg.action === 'score_active') handleScore();
      } else if (msg.type === 'TRIGGER_SHOW_MODAL') {
        setActiveModal(msg.modal);
      }
    };
    chrome.runtime.onMessage.addListener(msgListener);

    const selectionListener = (e: Event) => {
      const evt = e as CustomEvent;
      setSelectedText(evt.detail.text);
      setActiveModal('select-context');
    };
    window.addEventListener('pro-prompt-selection', selectionListener);

    return () => {
      chrome.runtime.onMessage.removeListener(msgListener);
      window.removeEventListener('pro-prompt-selection', selectionListener);
    };
  }, []);

  const savePos = useCallback((x: number, y: number, isCollapsed: boolean) => {
    chrome.storage.local.set({ toolbarPosition: { x, y, collapsed: isCollapsed } });
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - offset.current.x));
      const ny = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - offset.current.y));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      if (dragging.current) { dragging.current = false; savePos(pos.x, pos.y, collapsed); }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [pos, collapsed, savePos]);

  const notify = (msg: string) => { setNotification(msg); setTimeout(() => setNotification(''), 4000); };

  const getActiveTarget = (): HTMLElement | null => {
    let el = document.activeElement;
    while (el?.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) el = document.querySelector('textarea, [contenteditable="true"]');
    return el as HTMLElement;
  };

  const getInputText = (el: HTMLElement | null): string => {
    if (!el) return '';
    return (el as HTMLInputElement).value || el.textContent || '';
  };

  const setInputText = (el: HTMLElement, text: string) => {
    if ('value' in el) (el as HTMLInputElement).value = text;
    else el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const handleRefactor = async () => {
    const el = getActiveTarget();
    const text = getInputText(el);
    if (!text || !el) { notify('⚠️ No active input found. Click into a text field first.'); return; }
    notify('🔄 Refactoring with active profile...');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'REFACTOR', payload: { prompt: text } });
      if (r?.status === 'success') { setInputText(el, r.data.refinedPrompt); notify(`✅ Done! Score: ${r.data.score}/100`); }
      else notify('❌ ' + (r?.message || 'Refactor failed'));
    } catch (e: any) { notify('❌ ' + e.message); }
  };

  const handleScore = async () => {
    const el = getActiveTarget();
    const text = getInputText(el);
    if (!text) { notify('⚠️ No input text found.'); return; }
    notify('📊 Scoring...');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SCORE', payload: { prompt: text } });
      if (r?.status === 'success') notify(`📊 Score: ${r.data.score}/100 — ${r.data.critique}`);
      else notify('❌ Score failed');
    } catch { notify('❌ Failed.'); }
  };

  const handleScanPage = async () => {
    notify('🔍 Scanning page...');
    setActiveModal('scan');
  };

  // Expanded action list
  // [Phase 1 §5.1] Autocomplete toggle removed — the ghost-text suggestion
  // manager is out of the build until Phase 4.
  const actions = [
    { icon: '🔄', label: 'Refactor Input', fn: handleRefactor },
    { icon: '📊', label: 'Score Input', fn: handleScore },
    { icon: '✨', label: 'Generate Prompt', fn: () => setActiveModal('generate') },
    { icon: '📥', label: 'Manual Context', fn: () => setActiveModal('context') },
    { icon: '🔍', label: 'Scan Page', fn: handleScanPage },
    { icon: '📌', label: 'Add Snippet', fn: () => setActiveModal('snippet') },
    { icon: '⚙️', label: 'Dashboard', fn: () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }) },
  ];

  const S: Record<string, React.CSSProperties> = {
    wrapper: { position: 'fixed', top: 0, left: 0, transform: `translate(${pos.x}px, ${pos.y}px)`, fontFamily: "'Inter', system-ui, sans-serif", zIndex: 999999 },
    expanded: { width: 220, background: '#0F172A', border: '1px solid #1E293B', borderRadius: 12, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', overflow: 'hidden' },
    header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #1E293B', cursor: 'grab', userSelect: 'none' as const, background: '#1E293B' },
    title: { fontSize: 13, fontWeight: 600, color: '#E2E8F0', flex: 1 },
    collapseBtn: { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 6, color: '#94A3B8', cursor: 'pointer', fontSize: 16 },
    btn: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', background: 'transparent', border: 'none', color: '#CBD5E1', fontSize: 13, cursor: 'pointer', textAlign: 'left' as const, fontFamily: 'inherit', borderBottom: '1px solid rgba(30,41,59,0.8)' },
    notif: { padding: '7px 12px', fontSize: 11, color: '#CBD5E1', background: '#0F172A', lineHeight: 1.4 },
    // Collapsed = vertical icon pill
    pill: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4, background: 'rgba(15,23,42,0.95)', border: '1px solid #1E293B', borderRadius: 12, padding: '8px 4px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', cursor: 'grab' },
    pillBtn: { width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 17, transition: 'background 0.15s' },
    pillDivider: { width: 24, height: 1, background: '#1E293B', margin: '2px 0' },
  };

  return (
    <>
      {activeModal && (
        <ModalManager
          type={activeModal}
          selectedText={selectedText}
          onClose={() => { setActiveModal(null); setSelectedText(''); }}
          onInject={(text) => { const el = getActiveTarget(); if (el) setInputText(el, text); }}
          notify={notify}
        />
      )}

      {collapsed ? (
        // Icon-only vertical pill
        <div style={S.wrapper}>
          <div style={S.pill} onMouseDown={onMouseDown}>
            {/* Expand button at top */}
            <button style={S.pillBtn} onClick={() => { setCollapsed(false); savePos(pos.x, pos.y, false); }} title="Expand">
              ⚡
            </button>
            <div style={S.pillDivider} />
            {actions.slice(0, 7).map(({ icon, label, fn }) => (
              <button key={label} style={S.pillBtn} onClick={(e) => { e.stopPropagation(); fn(); }} title={label}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#1E293B'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                {icon}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ ...S.wrapper, ...S.expanded }}>
          <div style={S.header} onMouseDown={onMouseDown}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <span style={S.title}>Pro Prompt</span>
            <button style={S.collapseBtn} onClick={() => { setCollapsed(true); savePos(pos.x, pos.y, true); }} title="Collapse to icon pill">−</button>
          </div>
          {actions.map(({ icon, label, fn }) => (
            <button key={label} style={S.btn} onClick={fn}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = '#1E293B'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}>
              <span style={{ fontSize: 16 }}>{icon}</span><span>{label}</span>
            </button>
          ))}
          {notification && <div style={S.notif}>ℹ {notification}</div>}
        </div>
      )}
    </>
  );
}

// ═══ Modal Manager ═══
function ModalManager({
  type, selectedText, onClose, onInject, notify
}: {
  type: 'generate' | 'snippet' | 'context' | 'scan' | 'select-context';
  selectedText?: string;
  onClose: () => void;
  onInject: (t: string) => void;
  notify: (m: string) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [inputVal, setInputVal] = useState(selectedText || '');
  const [bodyVal, setBodyVal] = useState('');
  const [descVal, setDescVal] = useState('');
  const [prefixVal, setPrefixVal] = useState('/');
  const [contextMode, setContextMode] = useState<'append' | 'replace'>('append');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [scanContent, setScanContent] = useState('');

  useEffect(() => {
    // Load profiles for selectors
    chrome.runtime.sendMessage({ type: 'GET_ALL_PROFILES' }).then((r: any) => {
      if (r?.data) {
        setProfiles(r.data);
        const active = r.data.find((p: Profile) => p.isActive);
        if (active?.id) setSelectedProfileId(active.id);
      }
    }).catch(() => {});

    // If scan modal, extract page content locally (see extractPageContent above)
    if (type === 'scan') {
      try {
        const content = extractPageContent();
        setScanContent(content.slice(0, 3000) || 'Could not extract content.');
      } catch {
        setScanContent('Could not scan page.');
      }
    }
  }, [type]);

  const handleAction = async () => {
    setLoading(true);
    try {
      if (type === 'generate') {
        if (!inputVal.trim()) { setStatus('Please enter a description.'); setLoading(false); return; }
        const r = await chrome.runtime.sendMessage({ type: 'GENERATE', payload: { description: inputVal, detailLevel: 0.5, profileId: selectedProfileId } });
        if (r?.status === 'success') { onInject(r.data.generatedPrompt); onClose(); }
        else setStatus('❌ ' + (r?.message || 'Generation failed'));

      } else if (type === 'snippet') {
        let prefix = prefixVal.trim();
        if (!prefix.startsWith('/')) prefix = '/' + prefix.replace(/^\/+/, '');
        const body = bodyVal.trim() || selectedText || '';
        if (!prefix || !body) { setStatus('Prefix and body are required.'); setLoading(false); return; }
        await chrome.runtime.sendMessage({ type: 'SAVE_SNIPPET', payload: { prefix, description: descVal, body } });
        notify('✅ Snippet saved!');
        onClose();

      } else if (type === 'context' || type === 'select-context') {
        const text = inputVal.trim();
        if (!text) { setStatus('No text provided.'); setLoading(false); return; }
        if (!selectedProfileId) { setStatus('Select a profile.'); setLoading(false); return; }

        if (contextMode === 'replace') {
          // Clear existing context then append
          await chrome.runtime.sendMessage({ type: 'SET_PROFILE', payload: { id: selectedProfileId, contextMd: '' } });
        }
        await chrome.runtime.sendMessage({ type: 'CONTEXT_FEED', payload: { profileId: selectedProfileId, context: text, source: type === 'select-context' ? 'selection' : 'manual' } });
        notify('✅ Context saved to profile!');
        onClose();

      } else if (type === 'scan') {
        if (!scanContent || !selectedProfileId) { setStatus('No content or profile selected.'); setLoading(false); return; }
        if (contextMode === 'replace') {
          await chrome.runtime.sendMessage({ type: 'SET_PROFILE', payload: { id: selectedProfileId, contextMd: '' } });
        }
        await chrome.runtime.sendMessage({ type: 'CONTEXT_FEED', payload: { profileId: selectedProfileId, context: scanContent, source: 'web_scan' } });
        notify('✅ Page context saved!');
        onClose();
      }
    } catch (e: any) {
      setStatus(`❌ Error: ${e.message}`);
    }
    setLoading(false);
  };

  const titles: Record<string, string> = {
    generate: '✨ Generate Prompt', snippet: '📌 Add Snippet',
    context: '📥 Manual Context', scan: '🔍 Scan Page → Context',
    'select-context': '✍️ Selection → Context',
  };

  const S = {
    overlay: { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', zIndex: 9999999, display: 'flex', alignItems: 'center', justifyContent: 'center' } as React.CSSProperties,
    box: { width: 440, maxHeight: '85vh', overflowY: 'auto' as const, background: '#0F172A', border: '1px solid #334155', borderRadius: 12, padding: 24, fontFamily: "'Inter', sans-serif", color: '#F8FAFC', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.8)' },
    label: { display: 'block', fontSize: 12, color: '#94A3B8', marginBottom: 4, marginTop: 12 },
    input: { width: '100%', padding: '9px 12px', background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: 'white', boxSizing: 'border-box' as const, fontFamily: 'inherit', fontSize: 13 },
    textarea: { width: '100%', padding: '9px 12px', background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: 'white', boxSizing: 'border-box' as const, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' as const },
    select: { width: '100%', padding: '9px 12px', background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: 'white', boxSizing: 'border-box' as const, fontFamily: 'inherit', fontSize: 13 },
    btn: { padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 },
    toggleRow: { display: 'flex', gap: 8, marginTop: 10 },
    toggleBtn: (active: boolean) => ({ padding: '5px 14px', borderRadius: 6, border: `1px solid ${active ? '#2563EB' : '#334155'}`, background: active ? 'rgba(37,99,235,0.15)' : 'transparent', color: active ? '#60A5FA' : '#94A3B8', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }),
  };

  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.box}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 17, fontWeight: 600 }}>{titles[type]}</h2>

        {/* Profile selector for context/scan/generate/select-context */}
        {['context', 'scan', 'generate', 'select-context'].includes(type) && (
          <>
            <label style={S.label}>Target Profile</label>
            <select value={selectedProfileId ?? ''} onChange={e => setSelectedProfileId(Number(e.target.value))} style={S.select}>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.icon} {p.name}{p.isActive ? ' (Active)' : ''}</option>)}
            </select>
          </>
        )}

        {/* Generate */}
        {type === 'generate' && (
          <>
            <label style={S.label}>Describe your prompt goal</label>
            <textarea value={inputVal} onChange={e => setInputVal(e.target.value)} rows={3} placeholder="E.g., A prompt for a senior developer reviewing a pull request..." style={S.textarea} />
          </>
        )}

        {/* Snippet */}
        {type === 'snippet' && (
          <>
            <label style={S.label}>Prefix (starts with /)</label>
            <input value={prefixVal} onChange={e => { let v = e.target.value; if (!v.startsWith('/')) v = '/' + v; setPrefixVal(v); }} placeholder="/my-snippet" style={S.input} />
            <label style={S.label}>Description</label>
            <input value={descVal} onChange={e => setDescVal(e.target.value)} placeholder="What does this snippet do?" style={S.input} />
            <label style={S.label}>Body (the text to inject)</label>
            <textarea value={bodyVal} onChange={e => setBodyVal(e.target.value)} rows={4} placeholder="You are a senior TypeScript developer..." style={{ ...S.textarea, marginTop: 0 }} />
          </>
        )}

        {/* Manual Context */}
        {type === 'context' && (
          <>
            <label style={S.label}>Context Text</label>
            <textarea value={inputVal} onChange={e => setInputVal(e.target.value)} rows={5} placeholder="Paste notes, documentation, or any knowledge..." style={S.textarea} />
            <label style={{ ...S.label, marginTop: 10 }}>Mode</label>
            <div style={S.toggleRow}>
              <button style={S.toggleBtn(contextMode === 'append')} onClick={() => setContextMode('append')}>Append to existing</button>
              <button style={S.toggleBtn(contextMode === 'replace')} onClick={() => setContextMode('replace')}>Replace all context</button>
            </div>
          </>
        )}

        {/* Select-to-Context */}
        {type === 'select-context' && (
          <>
            <label style={S.label}>Selected Text</label>
            <textarea value={inputVal || selectedText} onChange={e => setInputVal(e.target.value)} rows={4} style={S.textarea} />
            <div style={S.toggleRow}>
              <button style={S.toggleBtn(contextMode === 'append')} onClick={() => setContextMode('append')}>Append</button>
              <button style={S.toggleBtn(contextMode === 'replace')} onClick={() => setContextMode('replace')}>Replace</button>
            </div>
          </>
        )}

        {/* Scan Page */}
        {type === 'scan' && (
          <>
            <p style={{ fontSize: 12, color: '#94A3B8', margin: '8px 0' }}>Extracted {scanContent.length} characters from page via Readability.</p>
            <textarea value={scanContent} readOnly rows={5} style={{ ...S.textarea, color: '#64748B', fontSize: 11 }} />
            <div style={S.toggleRow}>
              <button style={S.toggleBtn(contextMode === 'append')} onClick={() => setContextMode('append')}>Append to profile</button>
              <button style={S.toggleBtn(contextMode === 'replace')} onClick={() => setContextMode('replace')}>Replace profile context</button>
            </div>
          </>
        )}

        {status && <div style={{ color: '#EF4444', fontSize: 12, marginTop: 10 }}>{status}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ ...S.btn, background: 'transparent', color: '#94A3B8' }}>Cancel</button>
          <button onClick={handleAction} disabled={loading} style={{ ...S.btn, background: '#2563EB', color: 'white', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Processing...' : type === 'generate' ? 'Generate & Inject' : type === 'scan' ? 'Save to Profile' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
