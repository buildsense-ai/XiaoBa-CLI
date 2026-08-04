# QA Checklist

Use this checklist once an execution module produces files.

## Always

```text
manifest.json exists
capability-report.json exists
qa-report.json exists
status is success, routed, planned, or blocked
warnings are explicit
outputs are outside the skill folder
source PDFs are not overwritten
qa-report summary has zero failed checks for successful runs
capability-report selected_capability matches the executed route
```

## Author/Rebuild PDF

```text
source.html exists when HTML was used
selected template id is recorded in author-render-manifest.json when a registered template is used
HTML QA passes before PDF export
PDF exists and starts with %PDF
PDF page count matches delivery type
first-page preview exists
```

## Modify PDF

```text
output PDF exists
page count matches expected operation
modified pages render to preview images
actions are recorded in manifest
```

## Semantic Rewrite

```text
edit-plan.json exists
recommended route is short_text_edit, overlay_edit, rebuild, or blocked
change list is explicit
semantic-result.json records applied_changes for visible edits
semantic-verification.json records replacement presence and match methods
semantic-visual-diff.json records page before/after previews and region before/after previews for visible edits
visual diff summary has at least one changed region for a successful visible edit
occurrence/match_index is used when target text appears multiple times
blocked includes a technical reason
rebuild output includes source.html, rebuild-content.json, and semantic-verification.json
```

## Development Self-Test

```text
scripts/self-test.mjs exits 0
self-test-report.json exists outside the skill folder
self-test-report summary has zero failed steps
self-test-report summary has zero failed assertions
self-test covers default author report, formal report, briefing note, tabler report, executive one-pager, modify merge, semantic normalized visible edit, semantic preflight, and semantic rebuild
```
