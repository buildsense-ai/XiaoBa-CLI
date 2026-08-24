# Hypothesis Method

## Purpose

Build an exhaustive-enough explanation space without pretending logical infinity is achievable. Exhaustion means all plausible material mechanism classes are represented, challenged, and tied to discriminating evidence.

## Ledger fields

Each hypothesis needs:

- `id` and concise mechanism statement;
- affected layer and preconditions;
- predicted observations if true;
- evidence supporting it;
- counter-evidence weakening it;
- missing discriminating evidence;
- status: `SUPPORTED`, `WEAKENED`, `EXCLUDED`, `UNRESOLVED`;
- materiality: can it change Issue versus Close?
- next action and stop condition if unresolved.

## Generation passes

1. Vertical pass: walk caller → local logic → protocol → dependency → infrastructure → persistence → user surface.
2. Cross-cutting pass: configuration, version, concurrency, permissions, capacity, privacy, data integrity, and observability.
3. Counterfactual pass: name expected signals if each hypothesis is false.
4. Independent challenge: ask another reviewer to add omitted mechanism classes.

## Saturation rule

Hypothesis generation is saturated when two consecutive challenge passes add no new material mechanism class. Saturation alone does not mean completeness; unresolved material hypotheses still block a terminal recommendation.

## Evidence language

Use precise states:

- supported: evidence positively predicts the hypothesis;
- weakened: counter-evidence lowers plausibility but does not exclude it;
- excluded: reliable discriminating evidence contradicts required predictions;
- unresolved: available evidence cannot discriminate.

Do not rank probabilities numerically unless the data supports calibration.
