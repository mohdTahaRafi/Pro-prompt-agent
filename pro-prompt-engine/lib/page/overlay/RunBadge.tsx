/**
 * RunBadge — the current step in one line, an always-present Stop.
 * Docs/planning/phase_5_agent_loop.md §9.2, §9.3.
 *
 * [Spec correction — same reasoning as GoalBox.tsx's header] plain DOM,
 * not React, to hold the content-script bundle under its 80 KB gzipped
 * budget (§3.8/§13).
 *
 * entrypoints/agent.content.ts owns the poll against the journal
 * (AGENT_GET_RUN_EVENTS) and the DOM highlight side-effect (it holds the
 * ElementRegistry that resolves a step's handle back to a live node; this
 * class never touches page DOM outside its own shadow-hosted element).
 * Stop here posts the SAME AGENT_STOP message the side panel's Stop does —
 * only the side panel is AUTHORITATIVE (§9.3) because this badge is
 * destroyed and recreated on every navigation.
 */
const S = {
  wrapper: 'position:fixed;bottom:20px;right:20px;font-family:\'Inter\',system-ui,sans-serif;z-index:2147483647;background:#0F172A;border:1px solid #1E293B;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.35);padding:10px 12px;color:#F8FAFC;display:flex;align-items:center;gap:10px;max-width:320px;',
  dot: 'width:8px;height:8px;border-radius:4px;background:#2563EB;flex-shrink:0;',
  text: 'font-size:12px;line-height:1.3;flex:1;min-width:0;',
  step: 'font-size:10px;color:#94A3B8;',
  stopBtn: 'background:transparent;border:1px solid #EF4444;color:#F87171;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;flex-shrink:0;',
};

export interface RunBadgeProps {
  label: string;
  stepPosition: string;   // "step 4 of 10"
  onStop: () => void;
}

export default class RunBadge {
  private el: HTMLDivElement;
  private onStop: () => void = () => {};

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.setAttribute('style', S.wrapper);
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.el.innerHTML = `
      <div style="${S.dot}"></div>
      <div style="${S.text}">
        <div data-role="label"></div>
        <div data-role="step" style="${S.step}"></div>
      </div>
      <button data-role="stop" style="${S.stopBtn}">Stop</button>`;
    this.el.querySelector('[data-role="stop"]')!.addEventListener('click', () => this.onStop());
    container.appendChild(this.el);
  }

  update({ label, stepPosition, onStop }: RunBadgeProps): void {
    this.onStop = onStop;
    this.el.querySelector('[data-role="label"]')!.textContent = label;
    this.el.querySelector('[data-role="step"]')!.textContent = stepPosition;
  }

  destroy(): void {
    this.el.remove();
  }
}
