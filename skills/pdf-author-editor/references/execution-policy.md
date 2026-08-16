# Execution Policy

This skill does not add interaction gates. Boundaries are managed by technical routing and blocked output.

## Direct Execution

Run directly when the route is deterministic:

```text
author from known content
merge PDFs
split PDFs
extract pages
rotate pages
delete pages
reorder pages
watermark
stamp
page number
highlight
visible note
cover box
```

## Plan Then Execute

Create `edit-plan.json` before semantic operations:

```text
replace existing PDF text
change document wording
rewrite a section
change an entity, date, amount, or status field
apply comments to regenerate a revised PDF
rebuild a scanned or complex-layout PDF from structured content
```

The plan is an execution artifact, not a pause point. It tells later scripts:

```text
what to change
where to locate targets
which route to use
why alternatives were rejected
what output files to expect
```

## Blocked Output

Return `blocked` instead of producing a bad PDF when inputs are technically insufficient:

```text
target text is missing or appears multiple times
no structured read-pdf result is available for semantic rewrite
replacement cannot fit and rebuild content is missing
input file does not exist
requested operation is outside the current routing boundary
```
