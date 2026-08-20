# portfolio/

Retrospective documentation for Ventora CRM, an internal CRM and embeddable-testimonial system
that ran in production on Cloudflare Workers and has since been retired.

These pages are written **after** the fact and **for a reader**. Every claim is meant to be
checkable against the tree: a file, a line number, or the command that produced a number. If a
statement here cannot be traced that way, it is a bug in the document.

The working residue (this repository's own cleanup ledger and the raw screenshot archive) is
in [`../docs/`](../docs/) and stays there. It was written for the author while doing the work,
is dated and open-ended, and is not part of this set.

## The pages

| | Length | |
|---|---:|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 304 lines | Request lifecycle, data model, widget embedding, the ingest pipeline, and the staged rollout |
| [SECURITY.md](./SECURITY.md) | 273 lines | Every trust boundary, the conflict-of-interest firewall, and what each mechanism does *not* protect against |
| [SCREENSHOTS.md](./SCREENSHOTS.md) | 269 lines | The full gallery: 25 captures across six categories, each with the route or component it shows |
| [TESTING.md](./TESTING.md) | 183 lines | The four test layers, why coverage is scoped to seven modules, the real-SQL harness, and what isn't tested |
| [ENGINEERING-LOG.md](./ENGINEERING-LOG.md) | 112 lines | Five defects (two live regressions and three found while preparing this snapshot), each with root cause and the fix |
| [METRICS.md](./METRICS.md) | 100 lines | Every number in the README, with the counting rule and the regex that produced it |
| [`screenshots/`](./screenshots/) | 25 images | The 25 image files SCREENSHOTS.md and the README embed, out of the 33 `npm run shots` produces |

`portfolio/` holds the six write-ups above and the 25 screenshots they embed: finite, retrospective,
addressed to a reader evaluating the system after the fact.

## If you are only going to read one

[ENGINEERING-LOG.md](./ENGINEERING-LOG.md) §2: a lead-scoring wiring bug that would have
persisted `NULL` instead of a number, caught only because a regression test asserted the exact
value round-tripped rather than just checking the column was non-empty.
