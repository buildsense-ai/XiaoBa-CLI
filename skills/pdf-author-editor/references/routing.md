# Routing Overview

`pdf-author-editor` has one user-facing entrypoint and three internal lanes:

```text
shell/router
  -> author
  -> modify
  -> semantic
```

The shell does not do PDF surgery itself. It turns a loose user request or request JSON into:

```text
normalized request
route
execution assessment
optional edit-plan.json
manifest.json
```

## Shell Steps

1. Parse CLI args and request JSON.
2. Infer mode when `mode` is `auto`.
3. Decide the route:
   - `author`: create new PDF from known content.
   - `modify.page_ops`: merge, split, delete, rotate, reorder, extract.
   - `modify.overlay`: watermark, stamp, page number, highlight, note, cover box.
   - `semantic.short_text_edit`: targeted PDF text change.
   - `semantic.overlay_edit`: visible semantic replacement.
   - `semantic.rebuild`: rebuild a new PDF from revised content.
   - `semantic.blocked`: cannot execute with current inputs.
4. If semantic, create `edit-plan.json`.
5. Execute the selected module. Semantic routes write `edit-plan.json` first, then run `scripts/semantic/semantic-edit.py`.
6. Always write `manifest.json`.

## Output Location

Never write generated outputs inside the skill folder. Default to:

```text
work/pdf-author-editor-runs/<input-name>-<timestamp>/
```
