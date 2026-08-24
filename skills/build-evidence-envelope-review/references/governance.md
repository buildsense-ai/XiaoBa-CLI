# Review Governance

## Constitution

If a Review Constitution exists, treat it as human-owned policy. Record its path, version or hash, and the clauses used to judge the Finding. The agent may identify ambiguity and propose a revision, but must not silently rewrite the Constitution.

If no Constitution exists, make the expected contract explicit from product requirements, tests, documented behavior, or owner instruction. Mark ambiguity as evidence, not as permission to invent a rule.

## Separation of duties

- Main reviewer: owns scope, hypothesis coverage, completeness, and recommendation.
- Evidence workers or sub-skills: collect, reproduce, sample, test, map, or render.
- Independent reviewer: challenges omissions and overclaims.
- Human owner: authorizes production-impacting actions and accepts Issue or Close.

## Immutability

Preserve the original Finding. Scope changes and reframed Findings must be linked, not overwritten. An observability gap discovered during review may become a new Finding with its own Envelope.
