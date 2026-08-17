# The path matrix

**If you change the flow, change this file and `test/paths.test.ts` together.**

Every bug in this feature that reached real use was a *sequence* bug, not a logic bug — a second
round replaying the first, a finished try leaving its ticket alive, a fix mistaken for a repeat, a
successful handback rendering as a red error. In each case every function involved was individually
correct. Unit suites cover components; only a matrix covers orderings.

The matrix lives in `test/paths.test.ts` and is walked end to end against a real daemon app. This
page is the human-readable index of it, and the checklist to work through when you add an entry
point, a decision, or a finish signal.

---

## The invariant that outranks the others

**Whatever happens, the bytes on disk after a handback are the learner's.**

Assert that in every row that ends in a handback, and assert it *in addition to* whatever the hook
returned. The decision has already changed shape twice — `deny` first, then `allow` with the write
neutralised — and each time the tests that asserted the *verdict* had to be rewritten while the
tests that asserted the *file* stayed correct. Test the thing that cannot move.

---

## A — a single round

| # | Path | Expected |
|---|---|---|
| A1 | menu → **Yes** | `ask`, with the explanation |
| A2 | menu → **Let me try**, typed correctly | handback carries both versions |
| A3 | typed wrongly | handback carries both; the learner's broken version is on disk |
| A4 | typed nothing | the empty file is reported, not the agent's intent |
| A5 | tool call first, no explanation | `deny` with a ticket, then `ask` once explained |

## B — two rounds on the same file

The round-2 cases exist because `/try` once preferred a stale ticket over a fresh pre-explanation,
so a second try replayed the first round's code and notes.

| # | Path | Expected |
|---|---|---|
| B1 | right → right, different code | round 2's code only, in both tutorial and handback |
| B2 | right → right, **identical** code | not mistaken for a repeat |
| B3 | **wrong → right** (the correction loop) | the fix reaches the comparison |
| B4 | nothing → right | two tutorials opened |
| B5 | try → Yes | round 2 is an ordinary `ask` |
| B6 | Yes → try | round 2 opens with round 2's code |

## C — the agent repeating itself

| # | Path | Expected |
|---|---|---|
| C1 | same call again, nothing new proposed | `deny`, "already typed"; their file untouched |
| C2 | a genuinely different change | normal gate — mints a ticket |
| C3 | `let_me_try` twice in one round | one editor, one tutorial |
| C4 | armed, then abandoned for another file | the stale intent never fires |

## D — saying you are done

| # | Path | Expected |
|---|---|---|
| D1 | tick the checkbox in the tutorial | handback |
| D2 | `let-me-explain done`, nothing else waiting | handback |
| D3 | `done` with two in flight | names both; `--target` resolves one and leaves the other |

## E — more than one thing at once

| # | Path | Expected |
|---|---|---|
| E1 | two files in flight | separate tutorials, separate editors |
| E2 | two sessions, same file | isolated; the second has nothing to take over |
| E3 | plugin switched **off** mid-try | the typing is not abandoned — **assert the file, not the verdict** |
| E4 | window surface, decided by the buttons | `deny` telling the agent to stand down, then the usual path |

## F — things that should fail cleanly

| # | Path | Expected |
|---|---|---|
| F1 | explanation with no notes | `400` |
| F2 | `let_me_try` on a file nobody proposed | `404` |
| F3 | tutorial deleted mid-try | `done` still works |
| F4 | a tool with nothing to explain | passes straight through |

## G — the shape of the handback

A denial renders as a red `Error:` block, which is wrong for a flow that succeeded. Where the write
can be made harmless it is allowed instead — but only where that is *provably* safe.

| # | Path | Expected |
|---|---|---|
| G1 | `Write` completes a try | `allow` + `updatedInput` replacing the **whole** input; no `permissionDecisionReason` |
| G2 | `Edit` completes a try | `deny` — a no-op edit is not expressible |
| G3 | `Bash` completes a try | `deny` — the target is `'shell'`, there is no file |
| G4 | `permissionMode: acceptEdits` | `deny` — measured, the rewrite lands ~1 time in 3 there |
| G5 | wait expiry, still typing | `deny` — the denial is what makes the agent retry, which extends the wait |
| G6 | any handback | `systemMessage` tells the learner, in neutral styling |

## H — if the rewrite were ever ignored

This is the one path in the system that must not fail open.

| # | Path | Expected |
|---|---|---|
| H1 | the agent's version landed on the file | restored to the learner's, logged `try.restored` |
| H2 | the learner kept typing after clicking done | **not** clobbered — the net only restores an exact match to the agent's version |
| H3 | both versions already agree | the net does nothing |

---

## Adding to the matrix

Work the cross-product, not the happy path:

1. **Entry point** — explained-then-menu, or tool-call-first-then-ticket.
2. **Choice** — Yes, Let me try, Explain more.
3. **Repetition** — first round, second round on the same file, a repeat of an identical call.
4. **Outcome** — typed correctly, typed wrongly, typed nothing.
5. **Finish signal** — checkbox, CLI, VS Code button.
6. **Environment** — surface, permission mode, tool type, concurrent tries.

Two questions catch most of it:

- **If I add a second route to an existing operation, which invariants did the old route enforce,
  and does the new one enforce them too?** Validation once lived only on the ticket path; when the
  menu made the pre-explanation path primary, nothing was checked at all — no error, no failing
  test, just an invariant that quietly stopped holding.
- **When two pieces of state could describe "the change in front of us", does the newest win?**
  Three separate bugs were the same answer: no.

## Related

- [../features/04-let-me-try.md](../features/04-let-me-try.md) — the flow these paths walk
- [../decisions.md](../decisions.md) — why each guard exists, and what was rejected
- [../development.md](../development.md) — running the suites
