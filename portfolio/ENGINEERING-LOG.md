# Engineering log

Defects worth reading about, with the root cause and the file that carries the fix. Not a
changelog. Every entry here is checkable against the tree.

The ordering is by how much each one taught, not by date: this repository has no commit history
to date it against; see [METRICS.md](./METRICS.md).

---

## 1. A lead worker could resolve the wrong product and silently drop the lead

**Found by:** a regression test (`tests/unit/sdr-ingest.test.ts:817`): `REGRESSION: resolves
product by slug, NOT by widget_public_key`.
**Fix:** `src/routes/sdr-ingest/index.ts:373-374`.

The AI-SDR Worker calls `POST /s/ingest/leads/:productKey`, and it sends the product's **slug** in
that path segment: the comment at `sdr-ingest/index.ts:21` says so explicitly. An earlier version
of the handler looked the product up by `widget_public_key` instead. Slug and widget key are both
opaque per-product strings, so nothing in the type system caught the mismatch: the lookup compiled,
ran, and simply found no row for a real, correctly-signed request, returning a 404 the caller had no
way to distinguish from an actually-unknown product.

**Blast radius.** A signed, valid lead submission from the AI-SDR Worker would be silently dropped
for any product whose slug didn't happen to equal its widget key. Nothing paged anyone: a 404 for an
"unknown product" is indistinguishable from an unrelated product genuinely not existing yet.

The fix is one call: `ProductsDB.getBySlug(c.env.DB, slug)`. The regression test seeds a product
whose `slug` and `widget_public_key` deliberately differ, submits a signed request keyed by slug,
and asserts a `200` with a real `leadId` landing in `sdr_leads`, a test that would fail
immediately under the old `getByWidgetKey()` code path.

---

## 2. Qualification scores were wired to the wrong place and would have landed as `NULL`

**Found by:** a regression guard (`tests/unit/sdr-ingest.test.ts:658-681`): `persists fit_score,
intent_score, and status to sdr_leads`.
**Fix:** `src/routes/sdr-ingest/index.ts:447-448` into `src/db/sdr-leads.ts:181-182`.

`fitScore` and `intentScore` arrive in the request body, get validated
(`sdr-ingest/index.ts:196-207`), and have to cross two naming boundaries before they reach D1: the
camelCase request field to the camelCase `UpsertLeadInput` property, and that property to the
snake_case `fit_score` / `intent_score` columns
(`sdr-leads.ts:165-166`, `181-182`). A wiring bug at either boundary (a field left off the object
passed into `upsertLeadBySession`, say) would not throw. The insert still succeeds; the two
columns just persist as `NULL`, and every downstream lead-scoring read gets a silently missing
number instead of an error.

The test comment names the failure mode directly: *"a wiring bug that dropped fitScore/intentScore
between the route handler and upsertLeadBySession would leave fit_score/intent_score null in D1,
failing the assertions below."* It asserts the exact numeric values round-trip, not just that the
columns are non-null, so a swap between the two scores would also fail it.

---

## 3. Promoting the docs to `portfolio/` would have corrupted the published test ratio

**Found:** while moving `docs/{ARCHITECTURE,METRICS,SECURITY,TESTING}.md` to a root `portfolio/`
directory, a prior documentation pass on this repository (see
[`../docs/goal-portfolio-public/LEDGER.md`](../docs/goal-portfolio-public/LEDGER.md), PP-01).
**Fix:** `scripts/repo-metrics.mjs`, `classify()` at line 172 and `area()` at line 187.

`scripts/repo-metrics.mjs` is the script that produces the numbers in
[METRICS.md](./METRICS.md) and the README's `## By the numbers` table, including the
application-to-test line-count ratio the README asks a reader to trust. Before the fix, `classify()`
defined "documentation" as "path starts with `docs/`", so a root-level `portfolio/` directory didn't
match that rule and fell through to the default `application` branch. Every line of every promoted
write-up would have been counted as shipped product code, inflating the application total and
quietly corrupting the one ratio this README leans on hardest.

Verified by running `node scripts/repo-metrics.mjs --check` after the fix, which fails the build if
the committed `METRICS.md` and the actual tree disagree.

---

## 4. The same script miscounted `LICENSE` for the same reason

**Found:** immediately after fix #3, same review pass (LEDGER.md, PP-11).
**Fix:** `scripts/repo-metrics.mjs:176-177`.

`classify()`'s root-level documentation exception originally matched on file extension:
`extname(base) === ".md"`. `LICENSE` has no extension, so it fell through to `application` for the
same structural reason `portfolio/` had: the classifier's default branch is "shipped code," and
anything that doesn't match a docs rule lands there by default rather than by review. A license file
is not application code, and it pushed the published application-line total up by its own length
every time it was counted. The fix special-cases `LICENSE` and `NOTICE` by basename at the root,
with a comment explaining why they need it: no extension, so nothing else would catch them.

---

## 5. Two "distinct" screenshots were the same file under two names, for months

**Found:** while preparing this snapshot for publication, not during development (LEDGER.md,
Cycle 5).
**Current state:** both duplicates deleted; `docs/screenshots/` and `portfolio/screenshots/`
together hold 33 captures, not 35.

`tests/screenshots/capture.spec.ts` took the same full-screen shot twice under two different
filenames in two places: once implying a distinct "customer activity timeline" view and once
implying a focused "settings embed snippet" capture, when both were actually identical to a
neighboring screenshot already in the set. `certutil -hashfile ... SHA256` confirmed both pairs were
byte-identical, not just visually similar.

Nothing in the test suite caught it, because nothing asserted image *content*, only that a file
of the expected name got written. **What isn't tested**, per
[TESTING.md §8](./TESTING.md#8-what-isnt-tested), is explicit about this: "no visual regression
testing... nothing fails if the UI shifts." That statement was true of the screenshots, and this is
what it cost in practice: two filenames that promised something the capture harness never actually
produced. The unused half of each pair was deleted rather than relabeled, and the repository's own
count of committed captures (33, not the 35 the harness can produce) now says so directly instead of
leaving a reader to hash the directory to find out.
