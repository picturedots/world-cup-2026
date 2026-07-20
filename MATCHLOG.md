# Hardening `matchLog`

A design proposal for `data/gamestate.json`. **Not implemented** — this documents the
intended shape and migration path.

## Goal

Every consumer of `matchLog` today re-derives structured facts — *which team*, *how many
points*, *which player*, *did ownership change* — by regex-matching English prose. Three
separate parsers exist (`scores-chart.html` `buildDatasets`, `scores-chart.html`
`buildOriginalDatasets`, `ownership-chart.html` `parseAward`), each with a different
pattern set, and `index.html` filters on message text too. A new message shape in
`.github/scripts/update-scores.mjs` drops points **silently** in whichever parsers don't
know it — exactly the champion-bonus bug, where
`"Spain are World Cup Champions → +8 pts for Emily"` matched none of the
`beat` / `advanced to` / `reached` patterns and vanished from two of the three views.

The fix is to make `msg` presentation-only and carry the facts in fields.

## Proposed entry shape

```jsonc
{
  "time": 1784506140752,
  "type": "champion",              // discriminant, see below
  "awards": [                      // every point movement, always explicit
    { "team": "Spain", "player": "p1779936803050", "delta": 8 }
  ],
  "swaps": [],                     // ownership changes, only on switcheroos
  "msg": "Spain are World Cup Champions → +8 pts for Emily"  // display only
}
```

Three rules carry the hardening:

1. **`awards` is the sole source of truth for points.** Never a count to be inferred from
   `type`. A consumer sums `awards` and is correct for every event kind, including ones
   added after it was written.
2. **`player` is the stable player id**, not the display name. Display names go through
   `draft.json` at render time. This also kills the `(\w+)` fragility — a name with a
   space or accent currently truncates silently.
3. **`msg` is never parsed.** It becomes free text that can be reworded, emoji'd, or
   localized without breaking a chart.

## Event types

| `type` | `awards` | `swaps` |
|---|---|---|
| `win` | winner's owner, +3 | — |
| `draw` | each owner, +1 | — |
| `switcheroo` | each owner, +1 | both teams' new owners |
| `group_advance` | advancing team's owner, bonus | — |
| `stage_reached` | team's owner, bonus | — |
| `champion` | champion's owner, +8 | — |

Add `stage` (`"r16"`, `"qf"`, …) and `score` as optional metadata fields where they
apply, so the UI can render richer text without parsing.

`swaps` entries: `{ "team": "Qatar", "from": "p177…", "to": "p177…" }`. Today
`ownership-chart.html` reconstructs ownership by splitting on `"Teams swapped: "` and
`" → "` — a team name containing `→` or a comma would corrupt the ownership replay for
the rest of the timeline.

## Consumer changes

All three parsers collapse to roughly:

```js
for (const e of gamestate.matchLog)
  for (const a of e.awards) push({ time: e.time, player: a.player, team: a.team, delta: a.delta });
```

The two chart *views* then differ only in attribution: the by-player chart credits
`a.player`; the "ignore switcheroos" view credits `teamOwner[a.team]` from `draft.json`.
That's the real payoff — the views stop being three regex dialects that can disagree, and
become one extraction with two attribution policies.

The switcheroo breakdown quirk documented in `ownership-chart.html` (both parties
credited, so per-player sums exceed the country total) stays a *rendering* choice,
derived from `swaps` rather than from prose.

## Migration

The log is append-only history, so old entries can't be regenerated from the feed — they
must be backfilled. Two viable paths:

- **One-shot backfill script**: run the existing regexes over the 300-odd committed
  entries, emit the structured fields, and **assert every entry matched**. The assertion
  is the point: it's the check that never ran, and it's what would have caught the
  champion entry. Commit the rewritten `gamestate.json` once.
- **Tolerant readers during transition**: consumers use `e.awards ?? parseLegacy(e.msg)`.
  Lower risk, but keeps the regexes alive indefinitely — only worth it if you'd rather not
  rewrite history in git.

Recommendation: the backfill. It's a fixed, verifiable, one-time cost, and it lets the
legacy parsers be deleted outright.

## Guardrail worth adding either way

Whatever the shape, add an invariant check at the end of `update-scores.mjs`:

```
sum of all awards[].delta per player  ===  points[player]
```

`points` and `matchLog` are maintained by separate lines of code at each award site, and
nothing currently verifies they agree. That check fails loudly in CI the moment a new
award path updates one and not the other — which is the class of bug underneath this
whole exercise.
