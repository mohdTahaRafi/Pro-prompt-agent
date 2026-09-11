import { defineConfig } from 'wxt';
import { FROZEN_CAPTURE_TARGETS, LIVE_PANEL_TARGETS } from './tools/corpus-targets';

// [Phase 1 §8.2] chrome.permissions.request() opens a native browser bubble
// that is not page content — Playwright cannot drive it (verified empirically:
// the call hangs indefinitely waiting for a real click, gesture or not).
// grant-revoke.spec.ts and sensitive-untouched.spec.ts need the origin's
// content script to actually be *injectable* by real Chrome, not mocked, to
// be meaningful — so the e2e build (`npm run build:e2e`, PP_E2E=1) adds the
// fixed e2e server's origin as a genuinely-held permission, sidestepping only
// the interactive click while exercising every other real API. This never
// touches the production manifest: PP_E2E builds to a separate output dir
// (tests/e2e/fixture.ts loads only from that dir), and the plain `npm run
// build` used by the CI `build` step and tests/unit/manifest.spec.ts never
// sets PP_E2E, so its manifest stays exactly the Phase 1 baseline.
const isE2E = process.env.PP_E2E === '1';

// [Phase 2 §10.1] Same sidestep, applied to the corpus's 15 frozen-capture +
// 10 live-panel real-page collection (`npm run build:corpus`, PP_CORPUS=1,
// tools/collect-real-fixtures.ts). Every real target origin
// (tools/corpus-targets.ts) is added as a genuinely-held host permission so
// chrome.permissions.request() resolves instantly for it instead of hanging
// on the native bubble — the exact PP_E2E mechanism above, generalised from
// one fixed localhost origin to the corpus's real target list. Builds to its
// own output dir; never touches the production or e2e manifests.
const isCorpusCollect = process.env.PP_CORPUS === '1';
const corpusOrigins = isCorpusCollect
  ? [
      'http://localhost:5600/*',   // the combined frozen-capture static server
      ...LIVE_PANEL_TARGETS.map((t) => `${new URL(t.url).origin}/*`),
      ...FROZEN_CAPTURE_TARGETS.map((t) => `${new URL(t.url).origin}/*`),
    ]
  : [];

export default defineConfig({
  ...(isE2E ? { outDir: '.output/e2e' } : {}),   // → .output/e2e/chrome-mv3
  ...(isCorpusCollect ? { outDir: '.output/corpus-collect' } : {}),
  modules: ['@wxt-dev/module-react'],
  // [Phase 3 §15] a compile-time flag, not a runtime env read — Vite's
  // `define` does a literal text substitution, so `if (!__PP_E2E__)` in
  // entrypoints/background.ts becomes `if (!false)` in the production
  // bundle and the minifier drops the dead branch entirely. Gates
  // AGENT_BENCH_GATE, a message type that calls lib/policy/gate.ts
  // directly (skipping perceive/resolveIntent) so tests/e2e/gate-wake.bench.ts
  // can time the gate in isolation from perception, per the "time a gate
  // call" methodology in Docs/planning/phase_3_gate_actuation_verification.md
  // §15. Same never-ships-in-production guarantee as the e2e-only `tabs`
  // permission above, verified the same way (tests/unit/manifest.spec.ts
  // and a grep of the production bundle).
  vite: () => ({ define: { __PP_E2E__: JSON.stringify(isE2E) } }),
  manifest: {
    name: 'Pro Prompt',
    version: '1.0.0',
    description: 'Dynamic Agentic Prompt Engineering Environment — Refactor, score, and generate high-quality prompts with local-first AI.',
    // Phase 1 (architecture.md §3.9): the fixed baseline set. No <all_urls>,
    // no `tabs`, no `alarms` — every entry here is used by a source file that
    // ships in this build. tests/unit/manifest.spec.ts enforces the pairing
    // mechanically so this list cannot drift silently.
    permissions: [
      'storage',      // Dexie is IndexedDB, but storage.local/session carry keys and run flags
      'scripting',    // registerContentScripts for granted origins
      'offscreen',    // the agent runtime and every inference engine
      'sidePanel',    // the cockpit (Phase 5 supplies sidepanel.html)
      'activeTab',    // the popup's "grant this site" flow needs the current tab's URL
      // [Phase 3, e2e build only] tests/e2e/scope.spec.ts needs to resolve a
      // tabId for a tab on a DELIBERATELY ungranted origin (the property
      // under test), and chrome.tabs.query only reports tabs the extension
      // has host access to without the `tabs` permission — none of the
      // product's own code uses chrome.tabs.query by url, so this never
      // ships in production. Same sidestep pattern as the host_permissions
      // block below.
      ...(isE2E ? ['tabs' as const] : []),
    ],
    optional_host_permissions: ['*://*/*'],
    host_permissions: [
      'http://localhost:11434/*',   // Ollama, local, required for a Local-only planner
      ...(isE2E ? ['http://localhost:5599/*'] : []),   // e2e fixture server only — see comment above
      ...corpusOrigins,   // PP_CORPUS build only — see comment above
    ],
    // Groq and other remote providers move to optional_host_permissions,
    // requested at the point the user enters a key (Phase 4).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  },
  // Path aliases for clean imports
  alias: {
    '@lib': './lib',
    '@components': './components',
  },
});
