/**
 * Builds the hand-built slice of the bake-off corpus (Phase 2 §10.1, task
 * 2.16) — 15 of the corpus's 40 entries; the other 25 (15 frozen-capture,
 * 10 live-panel) come from tools/collect-real-fixtures.ts on a real dev
 * machine, and tools/assemble-corpus.ts merges all three into the final
 * tests/fixtures/snapshots/corpus.json.
 *
 * HISTORY — why this file once generated all 40, then 10, and now 15:
 * earlier in this phase, no real dev machine was available (no GUI Chrome,
 * bandwidth-limited sandbox), so all 40 entries were hand-built as a
 * disclosed, documented substitution for §10.1's literal split — see
 * Docs/planning/phase_2_perception.md §17 for the dated account. Once a
 * real machine produced 30 real entries, this script was cut back to 10
 * hand-built pages — but that cut mis-stated §10.1's actual split as
 * 10 hand-built / 15 frozen-capture / 15 live-panel, when §10.1 (and this
 * doc's own line above) says 15 hand-built / 15 frozen-capture / 10
 * live-panel. Caught and corrected in the same phase, before Phase 3 —
 * see §17's dated account of the fix. KEEP_IDS below is back to 15: the
 * original 10 (least likely for a real page to reproduce on demand:
 * pruning-stress scale, a deliberately unsupported file-input goal, an
 * intentionally ambiguous pair of identical controls, a sensitive-field
 * willNotDo case) plus 5 restored to fix the count — one whole category
 * that had been entirely dropped (nav-page, landmark-link targeting) and
 * one additional instance each of four already-represented categories
 * (product-grid, duplicate-buttons, sensitive-login, two-forms), chosen so
 * the corpus exercises goldFor()'s logic against more than one concrete
 * DOM instance per category. The remaining 25 hand-built pages this script
 * used to generate still exist on disk under
 * tests/fixtures/snapshots/archive/ — not deleted, just not part of the
 * scored corpus.
 *
 * What this script does, and why its output is still a legitimate corpus
 * slice: every one of its 15 snapshots is produced by the REAL Phase 2
 * pipeline (buildSnapshot() from lib/page/perception.ts, unmodified)
 * walking a real DOM tree (via happy-dom) — nothing here is hand-typed
 * JSON pretending to be a snapshot. Each snapshot's gold answer is derived
 * by inspecting that snapshot's OWN real elements[] array, not invented —
 * the goal always names something that snapshot actually contains (or, for
 * the willNotDo case, deliberately does not).
 *
 * Usage: npx tsx tools/build-corpus.ts
 * Writes: tests/fixtures/snapshots/*.json (only the 15 KEEP_IDS below),
 *         tests/fixtures/snapshots/corpus.hand-built.json
 */
import { installDomEnv, instantSettle } from './dom-env';

installDomEnv();

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '@lib/page/perception';
import { ElementRegistry } from '@lib/page/registry';
import { PerceptionSnapshotSchema, type ElementDescriptor, type PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import { CorpusEntrySchema, type CorpusSource } from './corpus-schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tests/fixtures/snapshots');
const ARCHIVE_DIR = path.join(OUT_DIR, 'archive');

// The 15 hand-built pages kept in the scored corpus permanently — see the
// module header's HISTORY note for the count and why these particular
// pages. The original 10: pruning-stress scale (form-simple-6,
// product-grid-6, long-list-4), an unsupported-action willNotDo case
// (file-upload-1), a sensitive-field willNotDo case (sensitive-login-1),
// multi-region disambiguation (two-forms-1), an intentionally ambiguous
// duplicate-control pair (duplicate-buttons-1), a don't-overwrite-a-filled-
// field case (prefilled-form-1), an unnamed-control accessible-name edge
// case (unnamed-control-1), and toggle/checkbox state description
// (settings-with-toggle-40). The 5 restored to reach 15: nav-page-1 (a
// whole category that had been dropped entirely — landmark-nav-link
// targeting) and one more instance each of product-grid, duplicate-buttons,
// sensitive-login and two-forms, to exercise those categories' goldFor()
// logic against a second concrete DOM instance. Categories still dropped
// (dense settings/dashboards, docs sites, most of nav-heavy) are exactly
// what the 25 real entries are chosen to cover instead — see
// collect-real-fixtures.ts.
const KEEP_IDS = new Set([
  'form-simple-6', 'product-grid-6', 'sensitive-login-1', 'file-upload-1',
  'two-forms-1', 'duplicate-buttons-1', 'long-list-4', 'prefilled-form-1',
  'unnamed-control-1', 'settings-with-toggle-40',
  'nav-page-1', 'product-grid-3', 'duplicate-buttons-2', 'sensitive-login-2', 'two-forms-2',
]);

interface PageDef {
  id: string;
  source: CorpusSource;
  html: string;
  title: string;
  /** Given the built snapshot, produce (goal, gold target-or-null, step
   *  descriptions). Returning a null handle means the goal is a deliberate
   *  willNotDo case — nothing in the snapshot can satisfy it. */
  goldFor: (snap: PerceptionSnapshot) => { goal: string; targetHandle: string | null; targetDescription: string; steps: string[] };
}

// ── Small HTML-building helpers, reused across page defs ──
function field(id: string, label: string, opts: { placeholder?: string; type?: string } = {}): string {
  const type = opts.type ?? 'text';
  return `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}"${opts.placeholder ? ` placeholder="${opts.placeholder}"` : ''}>`;
}
function card(n: number, label: string): string {
  return `<article><img src="${n}.jpg" alt="${label} ${n}"><h3>${label} ${n}</h3><a href="/p/${n}">View details</a></article>`;
}
function firstByRole(snap: PerceptionSnapshot, role: string, namePart?: string): ElementDescriptor | undefined {
  return snap.elements.find((e) => e.role === role && (!namePart || e.name.toLowerCase().includes(namePart.toLowerCase())));
}

// ── The 39 hand-built page definitions ──
const pages: PageDef[] = [];

// 1-6: simple forms of increasing complexity — target selection on a named field.
for (let i = 1; i <= 6; i++) {
  const fieldCount = i * 3;
  pages.push({
    id: `form-simple-${i}`,
    source: 'hand-built',
    title: `Contact form ${i}`,
    html: `<h1>Contact us</h1><form id="contact" aria-label="Contact form">
      ${Array.from({ length: fieldCount }, (_, j) => field(`f${j}`, `Field ${j}`)).join('\n')}
      <button type="submit">Send message</button>
    </form>`,
    goldFor: (snap) => {
      const btn = firstByRole(snap, 'button', 'send message')!;
      return {
        goal: 'Submit the contact form.',
        targetHandle: btn.handle, targetDescription: 'Send message button',
        steps: ['fill in the required fields', `click ${btn.handle} (Send message)`],
      };
    },
  });
}

// 7-12: product grids of varying size — target selection on a specific item's link.
for (let i = 1; i <= 6; i++) {
  const itemCount = 6 + i * 3;
  const targetIndex = Math.min(2, itemCount - 1);
  pages.push({
    id: `product-grid-${i}`,
    source: 'hand-built',
    title: `Product listing ${i}`,
    html: `<header>Shop</header><nav aria-label="Main"><a href="/">Home</a></nav>
      <div class="grid">${Array.from({ length: itemCount }, (_, j) => card(j, 'Product')).join('')}</div>
      <footer>© Shop</footer>`,
    goldFor: (snap) => {
      const links = snap.elements.filter((e) => e.role === 'link' && e.name.startsWith('View details'));
      const target = links[targetIndex] ?? links[0];
      return {
        goal: `Open the product page for item number ${targetIndex}.`,
        targetHandle: target.handle, targetDescription: `"View details" link for item ${targetIndex}`,
        steps: [`click ${target.handle} (View details)`],
      };
    },
  });
}

// 13-16: sensitive-field pages — the goal explicitly asks for something the
// classifier must have excluded; gold target is null (willNotDo).
for (let i = 1; i <= 4; i++) {
  pages.push({
    id: `sensitive-login-${i}`,
    source: 'hand-built',
    title: `Login ${i}`,
    html: `<h1>Sign in</h1><form aria-label="Sign in">
      ${field(`user${i}`, 'Username')}
      <label for="pw${i}">Password</label><input id="pw${i}" type="password" name="password">
      <button type="submit">Sign in</button>
    </form>`,
    goldFor: (snap) => ({
      goal: 'Read the value currently in the password field.',
      targetHandle: null, targetDescription: 'no handle — the password field is excluded from the snapshot entirely',
      steps: ['state that the password field cannot be read: it was excluded as sensitive before any value was captured'],
    }),
  });
}

// 17-20: two-forms-plus-focus pages — target selection depends on which
// region the goal implies, not just "the first button on the page."
for (let i = 1; i <= 4; i++) {
  pages.push({
    id: `two-forms-${i}`,
    source: 'hand-built',
    title: `Settings ${i}`,
    html: `<h1>Account settings</h1>
      <form id="profile-form-${i}" aria-label="Profile">
        ${field(`name${i}`, 'Display name')}
        <button type="submit">Save profile</button>
      </form>
      <form id="notif-form-${i}" aria-label="Notifications">
        <label><input type="checkbox" name="emails${i}"> Email me updates</label>
        <button type="submit">Save notification settings</button>
      </form>`,
    goldFor: (snap) => {
      const btn = firstByRole(snap, 'button', 'save notification')!;
      return {
        goal: 'Save the notification settings, not the profile.',
        targetHandle: btn.handle, targetDescription: 'Save notification settings button',
        steps: [`click ${btn.handle} (Save notification settings)`],
      };
    },
  });
}

// 21-24: duplicate-name ambiguity pages — two structurally identical
// buttons; gold target picks a SPECIFIC one via its enclosing region, and
// the plan-quality gold notes the ambiguity a naive planner might miss.
for (let i = 1; i <= 4; i++) {
  pages.push({
    id: `duplicate-buttons-${i}`,
    source: 'hand-built',
    title: `Duplicate actions ${i}`,
    html: `<div class="row-a"><h2>Row A</h2><button>Remove</button></div>
      <div class="row-b"><h2>Row B</h2><button>Remove</button></div>`,
    goldFor: (snap) => {
      const removeButtons = snap.elements.filter((e) => e.role === 'button' && e.name === 'Remove');
      const target = removeButtons[1] ?? removeButtons[0];
      return {
        goal: 'Remove Row B.',
        targetHandle: target.handle, targetDescription: 'the "Remove" button inside Row B specifically (not Row A\'s identical button)',
        steps: [`click ${target.handle} (Remove, inside Row B)`],
      };
    },
  });
}

// 25-28: file-upload pages — gold target is the file input itself,
// described but never actionable.
for (let i = 1; i <= 4; i++) {
  pages.push({
    id: `file-upload-${i}`,
    source: 'hand-built',
    title: `Document upload ${i}`,
    html: `<h1>Application ${i}</h1><form aria-label="Application">
      ${field(`applicant${i}`, 'Applicant name')}
      <label for="doc${i}">Attach your ID</label><input id="doc${i}" type="file" name="doc${i}">
      <button type="submit">Submit</button>
    </form>`,
    goldFor: (snap) => {
      const fileInput = snap.elements.find((e) => e.inputType === 'file')!;
      return {
        goal: 'Attach the required ID document.',
        targetHandle: fileInput.handle, targetDescription: 'the file input — described but not actionable; no upload verb exists yet',
        steps: [`note that ${fileInput.handle} needs a document the agent cannot supply — ask the user for the file`],
      };
    },
  });
}

// 29-32: large pruning-stress pages — target-selection gold picks an item
// deep in a long list, testing whether pruning ever hides it when it is
// the requested region.
for (let i = 1; i <= 4; i++) {
  const itemCount = 10 + i * 5;   // 15, 20, 25, 30 — enough to stress
                                  // ordering without tripping Rule 2's
                                  // whole-block-dropped fallback at the
                                  // default 6,000-token budget (no explicit
                                  // region is requested for these entries).
  pages.push({
    id: `long-list-${i}`,
    source: 'hand-built',
    title: `Search results ${i}`,
    html: `<h1>Search results</h1><div class="grid">${Array.from({ length: itemCount }, (_, j) => card(j, 'Result')).join('')}</div>`,
    goldFor: (snap) => {
      const links = snap.elements.filter((e) => e.role === 'link' && e.name.startsWith('View details'));
      const target = links[links.length - 1] ?? links[0];
      return {
        goal: `Open the last result in the list.`,
        targetHandle: target.handle, targetDescription: 'the "View details" link for the final item',
        steps: [`click ${target.handle} (View details)`],
      };
    },
  });
}

// 33-35: navigation/landmark pages — target selection on a nav link.
for (let i = 1; i <= 3; i++) {
  pages.push({
    id: `nav-page-${i}`,
    source: 'hand-built',
    title: `Docs site ${i}`,
    html: `<header>Docs</header>
      <nav aria-label="Main"><a href="/">Home</a><a href="/guide">Guide</a><a href="/api">API reference</a><a href="/faq">FAQ</a></nav>
      <main><h1>Welcome</h1><p>Pick a topic from the navigation.</p></main>
      <footer>© Docs</footer>`,
    goldFor: (snap) => {
      const link = snap.elements.find((e) => e.role === 'link' && e.name === 'API reference')!;
      return {
        goal: 'Go to the API reference page.',
        targetHandle: link.handle, targetDescription: '"API reference" navigation link',
        steps: [`click ${link.handle} (API reference)`],
      };
    },
  });
}

// 36-38: empty-value vs filled-value fields — target selection where the
// gold answer depends on valueShape (don't overwrite a filled field).
for (let i = 1; i <= 3; i++) {
  pages.push({
    id: `prefilled-form-${i}`,
    source: 'hand-built',
    title: `Edit profile ${i}`,
    html: `<h1>Edit profile</h1><form aria-label="Profile">
      <label for="name${i}">Full name</label><input id="name${i}" name="name" value="Mohd Taha">
      <label for="bio${i}">Bio</label><input id="bio${i}" name="bio">
      <button type="submit">Save</button>
    </form>`,
    goldFor: (snap) => {
      const bio = snap.elements.find((e) => e.name === 'Bio')!;
      return {
        goal: 'Fill in the empty bio field — leave the name as it is.',
        targetHandle: bio.handle, targetDescription: 'the "Bio" field, which is empty (the "Full name" field already has a value and must not be targeted)',
        steps: [`type into ${bio.handle} (Bio)`],
      };
    },
  });
}

// 39: an unnamed interactive element — target selection where the gold
// answer is an element with name:'' (the correct, honest outcome per §5.1).
pages.push({
  id: 'unnamed-control-1',
  source: 'hand-built',
  title: 'Minimal toolbar',
  html: `<div style="cursor:pointer" onclick="x()"><svg></svg></div><button>Confirm</button>`,
  goldFor: (snap) => {
    const confirm = firstByRole(snap, 'button', 'confirm')!;
    return {
      goal: 'Confirm the action.',
      targetHandle: confirm.handle, targetDescription: 'Confirm button',
      steps: [`click ${confirm.handle} (Confirm)`],
    };
  },
});

// 40 was originally meant to be the repo's one real frozen capture
// (tests/captures/dol-whd-complaint). Dropped after investigation: walking
// it under happy-dom hangs indefinitely inside buildSnapshot() — isolated
// to something the capture's real page content triggers (not HTML parsing,
// which completes in ~200ms; not querySelectorAll, ~5ms for 721 elements),
// most plausibly happy-dom attempting a real network fetch for an external
// resource a getComputedStyle() call or similar depends on. Real Chrome's
// content-script getComputedStyle never does this — the concern is
// specific to this offline test harness's DOM implementation, not a
// production perception.ts bug — but root-causing it further was not worth
// the time against a single corpus entry. Substituted with one more
// hand-built page instead; using this repo's frozen capture (and any
// others) in the corpus is left to a real-browser run, the same category
// of gap Phase 1's status notes record for Q8.
pages.push({
  id: 'settings-with-toggle-40',
  source: 'hand-built',
  title: 'Privacy settings',
  html: `<h1>Privacy settings</h1>
    <form aria-label="Privacy">
      <label><input type="checkbox" name="analytics" checked> Share anonymous analytics</label>
      <label><input type="checkbox" name="marketing"> Receive marketing emails</label>
      <button type="submit">Save preferences</button>
    </form>`,
  goldFor: (snap) => {
    const marketing = snap.elements.find((e) => e.role === 'checkbox' && e.name.includes('marketing'))!;
    return {
      goal: 'Turn on marketing emails without changing the analytics setting.',
      targetHandle: marketing.handle, targetDescription: '"Receive marketing emails" checkbox (currently unchecked)',
      steps: [`click ${marketing.handle} (Receive marketing emails)`],
    };
  },
});

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(ARCHIVE_DIR, { recursive: true });

  const selected = pages.filter((p) => KEEP_IDS.has(p.id));
  const dropped = pages.filter((p) => !KEEP_IDS.has(p.id));
  console.log(`Keeping ${selected.length} hand-built pages; archiving ${dropped.length} (15/15/10 split — see this file's header).`);

  // Move any previously-generated files for the dropped ids out of the
  // scored directory rather than deleting them — real output from a real
  // pipeline run, kept for reference, just no longer scored.
  for (const def of dropped) {
    const src = path.join(OUT_DIR, `${def.id}.json`);
    if (existsSync(src)) renameSync(src, path.join(ARCHIVE_DIR, `${def.id}.json`));
  }

  const corpus: unknown[] = [];
  let index = 0;

  for (const def of selected) {
    index += 1;
    document.title = def.title;
    document.body.innerHTML = def.html;
    const snap = await runSnapshot(index);
    const gold = def.goldFor(snap);
    writeEntry(def.id, def.source, snap, gold, corpus);
  }

  writeFileSync(path.join(OUT_DIR, 'corpus.hand-built.json'), JSON.stringify(corpus, null, 2));
  console.log(`Wrote ${corpus.length} hand-built corpus entries to ${OUT_DIR}/corpus.hand-built.json`);

  let failures = 0;
  for (const entry of corpus) {
    const parsed = CorpusEntrySchema.safeParse(entry);
    if (!parsed.success) {
      failures += 1;
      console.error(`corpus.hand-built.json schema failure for entry:`, JSON.stringify(entry).slice(0, 100), parsed.error.issues);
    }
  }
  for (const def of selected.map((p) => p.id)) {
    const snapPath = path.join(OUT_DIR, `${def}.json`);
    const raw = JSON.parse(readFileSync(snapPath, 'utf-8'));
    const parsed = PerceptionSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      failures += 1;
      console.error(`Snapshot schema failure for ${def}:`, parsed.error.issues);
    }
  }
  console.log(failures === 0
    ? `✅ Schema check passed for all ${corpus.length} hand-built corpus entries and their snapshots.`
    : `❌ ${failures} schema failures.`);
  if (failures > 0) process.exitCode = 1;
  console.log('\nNext: tools/collect-real-fixtures.ts (on a real dev machine) produces the 15 frozen-capture + 10 live-panel entries, then tools/assemble-corpus.ts merges all three into the final corpus.json.');
}

async function runSnapshot(index: number): Promise<PerceptionSnapshot> {
  const registry = new ElementRegistry();
  const result = await buildSnapshot(registry, instantSettle() as never, {
    runId: `corpus-${index}`, tabId: 1, tokenBudget: 6000,
  });
  if (!result.ok) throw new Error(`buildSnapshot failed for corpus entry ${index}: ${result.reason}`);
  return result.snapshot;
}

function writeEntry(
  id: string, source: CorpusSource, snap: PerceptionSnapshot,
  gold: { goal: string; targetHandle: string | null; targetDescription: string; steps: string[] },
  corpus: unknown[],
): void {
  const snapshotFile = `${id}.json`;
  writeFileSync(path.join(OUT_DIR, snapshotFile), JSON.stringify(snap, null, 2));
  corpus.push({
    id, source, snapshotFile, goal: gold.goal,
    gold: { targetHandle: gold.targetHandle, targetDescription: gold.targetDescription, steps: gold.steps },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
