# Report: race-logica (RR.Race)

## Summary
Wrote RR.Heroes, RR.Tracks and RR.Race in parts/pure-race.js, and a 47-test node:test suite. All tests pass in about 2.6 s. Heroes (4) and Tracks (8) use the agreed ids, names and themes. Each hero has a Dutch `animal` noun and a one-sentence `tagline`. Each track has a one-sentence `blurb` and length 10. Both lists are deeply frozen.

Race is a pure, deterministic state machine. `create` validates hero, track and seed with clear TypeErrors. One seeded rng shuffles the lane order and pre-draws every rival gain, so the rivals' race depends only on the seed and never on the player's answers. Positions are kept as integer thousandths, so ties are exact and the tie rule is reliable. Rival gain per sum is `tempo +/- jitter`, capped at 0.98. Jitter is symmetric, with amplitude `min(0.12, 0.98 - tempo)`. A perfect player (1.0 per sum) is therefore strictly ahead of every rival after every sum, by at least 0.02 per sum.

I also ran mutation testing: 28 deliberately broken copies of the module, all caught by the suite.

The suite covers: data shape, freezing and Dutch-copy rules; the IP rule on names; every error case; determinism; JSON round-trip of the state; no use of Math.random or Date; invariants at every step over 3200 races, recomputed independently; the perfect-wins proof; the tie rule; advance after done; and calibration over 5000 seeds per track.

Measured calibration, taken over all 8 tracks:
- Perfect kid: wins 100%.
- Typical kid (80/10/10): wins 74% on track 1, falling to 46% on track 8. Top 2 in 98%, falling to 89%. Last in at most 0.4%.
- Struggling kid (50/20/30): last in 6.7% on track 1, rising to 24% on track 8. Every race always finishes.

The brief's tempo ranges already hit all targets with a large margin, so I kept them as they are.

## Deviations from BRIEF
(none)

## Limitations
- Only a perfect player actually reaches the finish line (length 10) when the 10th sum is done; every other kart, including every rival, stops short of it. The Scene and finish screen need a roll-out so everyone visibly crosses the line. I added RR.Race.rollout(state) for this (see extra).
- summary().place is the player's CURRENT place while the race runs and the final place once done is true. It is never null. At zero sums answered it is 1, because the player wins the all-tied start by the tie rule. Show it only when done is true.
- Hero pace order is fixed by RR.Heroes order (egel slowest, then eekhoorn, pad, uil). Among the three rivals the slow, middle and fast tempo goes to the heroes in that order. Only the lane is shuffled by seed. Do not reorder RR.Heroes without re-running the tests.
- Jitter amplitude shrinks for the fast rival on high tracks (0.08 on track 1 down to 0.04 on track 8) to stay under the 0.98 ceiling. The fastest rival is therefore the most predictable one.
- seed is normalised with >>> 0 (unsigned 32 bit). A missing, NaN or non-number seed throws TypeError instead of silently becoming 0.
- State is plain JSON-serialisable data (it includes the pre-drawn rival gains, so treat it as opaque). Callers should use the API and only read state.track and state.hero, not the internals. The tie-rule and stub tests do poke state.units and replace RR.Rng.make; both rely on Race calling Rng.make through the RR.Rng object at call time and on RR.Rng not being frozen.
- Calibration is simulated with independent per-sum accuracy. A real kid's accuracy varies with the sums.

## Extra
RUN TESTS: cd /home/user/Cijfer-Ninja && RR_PARTS_DIR=/tmp/claude-0/-home-user-Cijfer-Ninja/00d1ad9b-1373-5505-a589-45c7888ab89a/scratchpad/parts node --test tests/rekenrace-race.test.mjs (47 tests, about 2.6 s). Without RR_PARTS_DIR it loads the fenced PURE block of rekenrace/index.html. The part file has no top-level declarations other than the RR.Heroes, RR.Tracks and RR.Race assignments, and it needs RR.Rng loaded before it. It does not declare `const RR`.

FINAL RIVAL TEMPO TABLE (gain per sum in track units, slow / middle / fast rival; jitter is uniform +/- min(0.12, 0.98 - tempo)):
track 1 tulips   0.700 / 0.800 / 0.900   jitter 0.12 / 0.12 / 0.080
track 2 windmill 0.709 / 0.809 / 0.906   jitter 0.12 / 0.12 / 0.074
track 3 beach    0.717 / 0.817 / 0.911   jitter 0.12 / 0.12 / 0.069
track 4 forest   0.726 / 0.826 / 0.917   jitter 0.12 / 0.12 / 0.063
track 5 canal    0.734 / 0.834 / 0.923   jitter 0.12 / 0.12 / 0.057
track 6 harbour  0.743 / 0.843 / 0.929   jitter 0.12 / 0.12 / 0.051
track 7 ice      0.751 / 0.851 / 0.934   jitter 0.12 / 0.12 / 0.046
track 8 hills    0.760 / 0.860 / 0.940   jitter 0.12 / 0.12 / 0.040
Linear interpolation between track 1 and track 8, rounded to thousandths. Per-sum rival gain is a multiple of 0.001 in [0, 0.98].

PUBLIC API (contract plus additive extras):
- Contract: Race.create, advance, positions, standings, summary, racers.
- Extras: Race.rollout(state), Race.rivalTempos(trackIdOrEntry), and the constants Race.OUTCOMES, Race.PLAYER_GAIN (frozen 1 / 0.8 / 0.5), Race.RIVAL_MAX_GAIN (0.98) and Race.RIVAL_JITTER (0.12).
- rollout(state) returns { heroId: pos } once done. It throws Error('race_not_done') before that. Every kart is carried the same extra distance, so gaps and order stay exactly as they were, until the last kart is 0.5 units past the line. A perfect race ends around 12 to 13.5 and the last kart at length + 0.5.

BEHAVIOUR DETAILS:
- Errors: advance after done throws Error('race_done'), and that check comes before the outcome check. A bad outcome throws TypeError and leaves the state untouched. A non-state argument throws TypeError. rollout before done throws Error('race_not_done').
- create accepts either an id or an entry for track (number 1..8) and hero (string); anything else is a TypeError. It also accepts a Tracks or Heroes entry and looks it up by id (a modified copy is not trusted). Lane order is a seeded shuffle of the rivals, so the fastest rival lands in each of lanes 1..3 about a third of the time.
- Return values: standings() rows are { id, name, pos, place, isPlayer }, with distinct places 1..4, ties broken by index, player first and then lane. positions() returns { heroId: number } and racers() returns [{ id, name, isPlayer, lane }], both fresh copies on every call. advance() returns { gains: { all four heroIds: number in track units }, done }.
- Positions are exact thousandths, e.g. 8.4. The player's finishing position is the exact sum of the 1.0 / 0.8 / 0.5 gains.
- State fields (read-only for callers): v, track (frozen Tracks entry), hero (frozen Heroes entry), seed, sums, lanes, outcomes, units, plan, done.

DEV TOOLS (scratchpad only, not deliverables): /tmp/claude-0/-home-user-Cijfer-Ninja/00d1ad9b-1373-5505-a589-45c7888ab89a/scratchpad/race-dev/ holds sim.mjs (place-distribution table), mutate.mjs (28-mutant mutation test), explore.cjs and tempos.mjs.