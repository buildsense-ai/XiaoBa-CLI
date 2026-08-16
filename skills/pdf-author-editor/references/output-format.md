# Output Format

Every run should produce a `manifest.json`.

## Standard Files

```text
final.pdf              final PDF when execution succeeds
source.html            generated HTML when authoring or rebuilding
preview-page-1.png     first-page preview when PDF exists
qa.json                PDF/HTML QA result when execution produces renderable output
edit-plan.json         semantic rewrite plan when route is semantic
semantic-result.json   semantic execution record when route is semantic
semantic-verification.json semantic replacement checks when route is semantic
semantic-visual-diff.json before/after visual evidence for visible semantic edits
rebuild-content.json   generated author-schema content when route is semantic rebuild
manifest.json          stable run record
capability-report.json route capability, inputs, expected outputs, and blocked conditions
qa-report.json         unified QA handoff for author, modify, and semantic routes
self-test-report.json  development self-test record when scripts/self-test.mjs is run
```

v1.2.5 guarantees `manifest.json`, `capability-report.json`, `qa-report.json`, `edit-plan.json` for semantic routes, full HTML/PDF/QA outputs for the `author` route, PDF/QA outputs for `modify` page operations and overlays, PDF/QA/semantic verification outputs for executable semantic edits, visual diff evidence for visible semantic edits, registered author templates, and `self-test-report.json` when the bundled self-test script is run.

Author render manifests include a `template` object when the HTML was generated from a registered template:

```json
{
  "template": {
    "id": "formal-report",
    "delivery_type": "report",
    "label": "Formal report",
    "path": "report/formal-report/template.html"
  }
}
```

`--preflight` writes `capability-report.json` and skips execution modules. Its `evaluation.depth` is `route_and_capability`: it does not open PDF pages to prove target text uniqueness, but it lists the blocked conditions the selected route will check during execution.

For split operations, `outputs.pdfs` contains all generated PDFs and `outputs.partChecks` contains one item per part:

```json
{
  "pdf": "part-1.pdf",
  "qaPath": "qa-part-1.json",
  "qa": {
    "ok": true,
    "page_count": 2,
    "errors": [],
    "warnings": [],
    "blank_pages": []
  },
  "preview": "preview-part-1.png"
}
```

## Manifest Fields

```json
{
  "skill": "pdf-author-editor",
  "version": "1.2.5",
  "status": "routed",
  "request": {},
  "route": {
    "kind": "semantic",
    "name": "semantic.rebuild"
  },
  "execution": {
    "requires_plan": true,
    "selected_route": "rebuild",
    "module_status": "success"
  },
  "outputs": {
    "manifest": "manifest.json",
    "capabilityReport": "capability-report.json",
    "qaReport": "qa-report.json",
    "editPlan": "edit-plan.json",
    "semanticResult": "semantic-result.json",
    "semanticVerification": "semantic-verification.json",
    "semanticVisualDiff": "semantic-visual-diff.json",
    "pdf": "final.pdf",
    "pdfQa": "qa.json",
    "preview": "preview-page-1.png"
  },
  "warnings": []
}
```

## Source File Rule

Never overwrite an input PDF. Write a new file even for small modifications.

## Self-Test Report

`scripts/self-test.mjs` writes `self-test-report.json` under the chosen run directory. It is a development artifact, not a normal user-facing PDF handoff. It records each command step, each assertion, fixture paths, core output paths, and a compact pass/fail summary.
