# Injection corpus — empty by design

Created in Phase 6 (Docs/planning/phase_6_recovery_journal_reporting.md §5,
§11, §13) as an empty placeholder so the directory exists in the tree from
this phase's first commit.

**[Phase 12] fills this** with the adversarial-page corpus and makes "zero
out-of-scope actions" a CI gate over it. Nothing in Phase 6 reads from or
writes to this directory — `lib/policy/suspicion.ts`'s own tests
(`tests/unit/suspicion.spec.ts`) use inline synthetic snapshots, not this
corpus.
