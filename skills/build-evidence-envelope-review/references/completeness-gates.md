# Completeness Gates

All mandatory gates must pass for `COMPLETE_ISSUE` or `COMPLETE_CLOSE`.

## G1 Scope gate

The Finding, expected contract, actual behavior, impact, affected population, and decision question are explicit. Scope drift is recorded.

## G2 Source gate

Original evidence is locatable. Mutable sources have timestamps or snapshots. Derived facts name their input and method.

## G3 Claim gate

Every material claim cites evidence. Direct observation, inference, and hypothesis are distinct.

## G4 Coverage gate

Applicable mechanism classes have been considered. Every material hypothesis has a ledger status and materiality judgment.

## G5 Discrimination gate

No unresolved material hypothesis can flip Issue versus Close. Unknown non-material implementation detail is allowed.

## G6 Reproduction gate

When reproduction is relevant, its fidelity is declared: unit mock, local protocol, staging, replay, or natural production event. It is not overstated.

## G7 Negative-evidence gate

Non-reproduction, successful samples, and absent signals include time window, denominator, path representativeness, and known bias. They are not treated as proof of absence.

## G8 Integrity and privacy gate

Redaction rules, forbidden fields, hashes, collector versions, and package manifest are present. Sensitive data minimization passes.

## G9 Challenge gate

An adversarial or independent review has no unanswered material objection. Any disagreement is preserved.

## G10 Decision gate

The evidence entails one terminal recommendation: Issue or Close. If it does not, state remains `INCOMPLETE` with one highest-value next evidence action and a stop condition.

## Important distinction

“Decision-ready to continue sampling” is not complete. “Behavior understood” is not necessarily complete. “Root cause precisely named” is not always required if the violated contract and ownership are already actionable and alternatives cannot change the Issue decision.
