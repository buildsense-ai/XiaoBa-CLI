---
name: pdf-author-editor
description: Create new PDFs and modify existing PDFs through this skill's own router and manifest workflow. Use when the user wants to generate, export, revise, edit, annotate, watermark, stamp, merge, split, reorder, delete pages, or semantically rewrite a PDF. Handles known content to PDF, page-level PDF operations, visible annotations, and planned content edits. When this skill is loaded for a PDF output/editing task, the final PDF must be produced by scripts/pdf-author-editor.mjs and a manifest.json handoff, not by ad hoc HTML writing plus export-pdf. For deep PDF reading, OCR, MinerU, multimodal extraction, or analysis without producing/modifying a PDF, use read-pdf first.
argument-hint: <input path or request.json> [--mode auto|author|modify|semantic] [--template <id>] [--out-dir <dir>] [--preflight] [--capabilities]
user-invocable: true
skillhub_author: "atridaisuki"
skillhub_version: "1.2.5"
skillhub_uploaded_at: "2026-07-09T08:00:59.739Z"
---

# PDF Author Editor

Use this skill as the single PDF production and editing entrypoint.

## Execution Rules

When this skill is loaded for a PDF output or PDF editing task, treat the task as incomplete until `scripts/pdf-author-editor.mjs` has run and written `manifest.json`.

Do not finish by hand-writing HTML and then calling `export-pdf`. Do not call `export-pdf` as a parallel or replacement delivery route when `pdf-author-editor` owns the task. `export-pdf` is only an internal/fallback renderer when the router cannot run; if used directly, state that the `pdf-author-editor` route was not completed.

For upstream intake tasks, such as `read-pdf -> summary -> PDF`, first let `read-pdf` provide source material. Then create a compact author input and call this skill's router:

```json
{
  "mode": "author",
  "intent": "Create a PDF report from extracted PDF source material.",
  "input": {
    "path": "<run-dir>/content.json",
    "type": "json"
  },
  "options": {
    "name": "<short-output-name>",
    "template": "tabler-report",
    "output_dir": "<run-dir>"
  }
}
```

The final response should cite the PDF path from `manifest.json` and mention `qa-report.json` status. If there is no `manifest.json`, do not claim this skill produced the PDF.

## Boundary

Do:
- Create new PDFs from known Markdown, JSON, HTML, or finalized content.
- Modify existing PDFs with page-level operations such as merge, split, delete, rotate, reorder, and extract.
- Add visible PDF marks such as watermark, stamp, page number, highlight, note, and cover boxes.
- Plan and execute semantic PDF rewrites through short text edit, overlay edit, rebuild, or blocked output.
- Select author templates through `template` or `options.template` using `assets/templates/templates.json`.
- Write outputs outside the skill folder, usually under `work/pdf-author-editor-runs/`.

Do not:
- Deep-read PDFs, OCR scans, run MinerU, or do multimodal page interpretation. Use read-pdf first.
- Promise native in-place PDF text editing for every PDF.
- Overwrite source PDFs.
- Split author, modify, and semantic rewrite into separate user-facing skills.

## Workflow

1. Normalize the user request into a request object matching `schemas/request.schema.json`.
2. If the source content is only in the conversation, write a small `content.json` outside the skill folder under `work/pdf-author-editor-runs/<run-name>/`, then write `request.json` next to it.
3. Run the shell router:

```bash
node <skill_dir>/scripts/pdf-author-editor.mjs <input-or-request.json> --out-dir <run-dir>
```

4. Let the router choose one of:
   - `author`: known content to new HTML/PDF.
   - `modify.page_ops`: page-level PDF operations.
   - `modify.overlay`: visible annotation or overlay operations.
   - `semantic.*`: planned content rewrite.
5. For semantic requests, create `edit-plan.json` before execution.
6. Return `manifest.json` as the stable handoff record.

Use preflight when the agent needs the route and capability boundary without producing a PDF:

```bash
node <skill_dir>/scripts/pdf-author-editor.mjs <input-or-request.json> --preflight --out-dir <run-dir>
node <skill_dir>/scripts/pdf-author-editor.mjs --capabilities
```

v1.2.5 implements the shell/router, planning records, the `author` execution route, `modify` execution for page operations and visible overlays, and `semantic` execution for targeted visible text edits plus rebuild-from-structured-content. Every route writes `capability-report.json` and `qa-report.json`. Semantic edits support explicit occurrence selection, normalized word matching, `semantic-verification.json`, and `semantic-visual-diff.json` with before/after page and region previews. Short text and overlay semantic edits change the rendered appearance; use rebuild when the revised PDF should be regenerated from structured content. Author templates are registered in `assets/templates/templates.json`, including `formal-report`, `briefing-note`, `executive-brief`, and `tabler-report`. `tabler-report` is an original template inspired by Tabler's mature card, table, and status-report information rhythm. This version keeps examples domain-neutral, keeps raw HTML inputs on the public `raw_html` block path, lets visible overlay targeting use `target_text`, `target`, or `text`, fixes Tabler report pagination so the first content section can start on page 1 instead of being pushed to a title-only first page, and avoids wording that causes SkillHub search metadata to infer an unrelated domain category. `scripts/self-test.mjs` runs the package check plus representative author templates, modify, semantic visible edit, semantic preflight, and semantic rebuild paths.
When a report request does not name a template, the author route should use the default report template declared in `assets/templates/templates.json`; in this build that default is `tabler-report`.

## References

- Read `references/routing.md` for the high-level shell flow.
- Read `references/routing-rules.md` when deciding author vs modify vs semantic.
- Read `references/capability-matrix.json` when a machine-readable capability boundary is needed.
- Read `assets/templates/templates.json` when choosing a PDF author template.
- Read `references/execution-policy.md` for direct execution, plan-then-execute, and blocked behavior.
- Read `references/output-format.md` before returning artifacts.
- Read `references/qa-checklist.md` before handoff once execution modules produce PDFs.

## Development Checks

Run after edits:

```bash
node <skill_dir>/scripts/pdf-author-editor.mjs <skill_dir>/examples/author-report-request.json --out-dir work/pdf-author-editor-runs/author-shell
node <skill_dir>/scripts/pdf-author-editor.mjs <skill_dir>/examples/semantic-rewrite-request.json --out-dir work/pdf-author-editor-runs/semantic-shell
node <skill_dir>/scripts/self-test.mjs --out-dir work/pdf-author-editor-runs/self-test
```
