# Routing Rules

Use request fields first. Use intent text only when the request is incomplete.

## Explicit Mode Wins

```text
mode=author   -> author
mode=modify   -> modify
mode=semantic -> semantic
mode=auto     -> infer
```

## Author

Route to `author` when:

```text
input extension is .md, .html, or .htm
request contains delivery_type/content/export fields
intent says generate, create, render, export, html to pdf, markdown to pdf
```

Author does not read or modify existing PDFs.

For author template choice, use `template` or `options.template` when present. The value must match an id in `assets/templates/templates.json`; otherwise the author module uses the default template for the delivery type.

## Modify

Route to `modify.page_ops` when the operation or intent mentions:

```text
merge
split
delete pages
rotate pages
reorder pages
extract pages
```

Route to `modify.overlay` when the operation or intent mentions:

```text
watermark
stamp
page number
highlight
note
annotation
cover box
visible mark
```

Modify works on existing PDFs but does not interpret document meaning.

## Semantic

Route to semantic when the user wants to change document meaning or text content:

```text
replace text
change wording
rewrite
revise content
make it more formal
change account owner
change amount/date/status
apply comments and regenerate
```

Semantic requests produce `edit-plan.json` first, then choose:

```text
short_text_edit
overlay_edit
rebuild
blocked
```

For targeted visible edits, preserve locator fields in the plan:

```text
pages/page
rect
occurrence or match_index
match_mode: auto, exact, normalized, normalized_words
allow_multiple
```

## Blocked

Use `blocked` only for technical inability, such as:

```text
missing input file
target text cannot be uniquely located
semantic PDF rewrite has no read-pdf result or structured content
input PDF cannot be opened by the later execution module
requested fixed layout cannot fit the replacement text
```
