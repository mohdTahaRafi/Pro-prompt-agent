/**
 * GoalBox — in-page goal intake (PR-UX-1). Docs/planning/phase_5_agent_loop.md §9.2.
 *
 * Lets a user start a run without leaving the page they are working on.
 * Mounted into the shared shadow root (lib/page/overlay/mount.ts) by
 * entrypoints/agent.content.ts.
 *
 * [Spec correction over the doc's illustrative naming] Plain DOM, not
 * React — the content-script bundle budget is 80 KB gzipped (§3.8/§13),
 * and shipping react-dom's reconciler here for two small floating widgets
 * (this file and RunBadge.tsx) blew that budget by ~30 KB gzipped on first
 * measurement. The file stays named .tsx to match §14's file tree; it
 * contains no JSX. Inline styles, not Tailwind, for the same budget reason
 * the doc states (a Tailwind bundle should not land on every granted page).
 */
import type { RunRecord } from '@lib/types/run.types';

const S = {
  wrapper: 'position:fixed;bottom:20px;right:20px;font-family:\'Inter\',system-ui,sans-serif;z-index:2147483647;',
  fab: 'width:48px;height:48px;border-radius:24px;background:#2563EB;color:white;border:none;box-shadow:0 8px 24px rgba(0,0,0,0.35);cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;',
  panel: 'width:300px;background:#0F172A;border:1px solid #1E293B;border-radius:12px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);padding:14px;color:#F8FAFC;',
  header: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;',
  title: 'font-size:13px;font-weight:600;',
  closeBtn: 'background:transparent;border:none;color:#94A3B8;cursor:pointer;font-size:16px;',
  textarea: 'width:100%;min-height:60px;background:#1E293B;border:1px solid #334155;border-radius:8px;color:white;padding:8px 10px;font-family:inherit;font-size:12px;resize:vertical;box-sizing:border-box;',
  row: 'display:flex;gap:8px;margin-top:8px;align-items:center;',
  select: 'flex:1;background:#1E293B;border:1px solid #334155;border-radius:6px;color:white;font-size:11px;padding:5px 6px;',
  startBtn: 'margin-top:10px;width:100%;padding:9px 0;background:#2563EB;color:white;border:none;border-radius:8px;font-weight:500;cursor:pointer;font-size:13px;',
  error: 'margin-top:8px;font-size:11px;color:#F87171;',
};

export default class GoalBox {
  private el: HTMLDivElement;
  private open = false;
  private goal = '';
  private mode: RunRecord['mode'] = 'supervised';
  private posture: 'local-only' | 'hybrid' = 'local-only';
  private busy = false;
  private error = '';

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    container.appendChild(this.el);
    this.render();
  }

  destroy(): void {
    this.el.remove();
  }

  private async start(): Promise<void> {
    if (!this.goal.trim()) return;
    this.busy = true; this.error = ''; this.render();
    try {
      const tabIdRes = await chrome.runtime.sendMessage({ type: 'GET_TAB_ID' });
      const tabId = tabIdRes?.data?.tabId;
      if (!tabId || tabId < 0) throw new Error('Could not resolve this tab.');
      const res = await chrome.runtime.sendMessage({
        type: 'AGENT_ADMIT_RUN', payload: { tabId, goal: this.goal.trim(), mode: this.mode, posture: this.posture },
      });
      if (res?.status === 'error') throw new Error(res.message);
      const data = res?.data;
      if (data?.phase !== 'admitted') throw new Error(data?.message ?? data?.reason ?? 'Could not start this run.');
      this.open = false;
      this.goal = '';
      // Best-effort — see entrypoints/background.ts's AGENT_ADMIT_RUN
      // handler for the chrome.sidePanel.open() gesture-timing note.
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.busy = false;
    this.render();
  }

  private render(): void {
    this.el.setAttribute('style', S.wrapper);
    if (!this.open) {
      this.el.innerHTML = `<button style="${S.fab}" title="Start a Pro Prompt run">⚡</button>`;
      this.el.querySelector('button')!.addEventListener('click', () => { this.open = true; this.render(); });
      return;
    }

    this.el.innerHTML = `
      <div style="${S.panel}">
        <div style="${S.header}">
          <span style="${S.title}">Start a run</span>
          <button data-role="close" style="${S.closeBtn}">✕</button>
        </div>
        <textarea data-role="goal" style="${S.textarea}" placeholder='e.g. "Fill this in from my details and stop before submitting."'></textarea>
        <div style="${S.row}">
          <select data-role="mode" style="${S.select}">
            <option value="supervised">Supervised</option>
            <option value="suggest">Suggest</option>
            <option value="step">Step</option>
          </select>
          <select data-role="posture" style="${S.select}">
            <option value="local-only">Local-only</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </div>
        <button data-role="start" style="${S.startBtn}${this.busy || !this.goal.trim() ? 'opacity:0.6;' : ''}" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? 'Starting…' : 'Start — opens the side panel'}
        </button>
        ${this.error ? `<div style="${S.error}"></div>` : ''}
      </div>`;

    const textarea = this.el.querySelector<HTMLTextAreaElement>('[data-role="goal"]')!;
    textarea.value = this.goal;
    textarea.addEventListener('input', () => { this.goal = textarea.value; this.updateStartButton(); });

    const modeSel = this.el.querySelector<HTMLSelectElement>('[data-role="mode"]')!;
    modeSel.value = this.mode;
    modeSel.addEventListener('change', () => { this.mode = modeSel.value as RunRecord['mode']; });

    const postureSel = this.el.querySelector<HTMLSelectElement>('[data-role="posture"]')!;
    postureSel.value = this.posture;
    postureSel.addEventListener('change', () => { this.posture = postureSel.value as 'local-only' | 'hybrid'; });

    this.el.querySelector('[data-role="close"]')!.addEventListener('click', () => { this.open = false; this.render(); });
    this.el.querySelector('[data-role="start"]')!.addEventListener('click', () => { void this.start(); });

    const errorEl = this.el.querySelector<HTMLDivElement>(`div[style="${S.error}"]`);
    if (errorEl) errorEl.textContent = this.error;
  }

  private updateStartButton(): void {
    const btn = this.el.querySelector<HTMLButtonElement>('[data-role="start"]');
    if (btn) btn.disabled = this.busy || !this.goal.trim();
  }
}
