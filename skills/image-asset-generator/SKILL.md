---
name: image-asset-generator
description: 根据文字需求以及可选的 1-3 张参考图生成并交付一张 PNG、JPEG 或 WebP 图片，默认通过 CatsCo Image2 网关竞速多个服务器中转站，在结构化竞速耗尽或其他明确可 fallback 的故障后转到共享登录的 Dreamina（即梦），也支持用户明确要求直接用即梦。负责取得真实参考图片、绑定来源与哈希、处理可恢复任务、保存结果，并将图片发送到对话或非破坏地保存进项目。适用于用户说“生成图片”“做一张图”“用即梦生成这张图”“照着这个角色画”“用这几张图保持人物/服装/风格”“用上一张继续”“按刚才那张做参考”“画个网站 hero”“出一张海报视觉”“保存为项目素材”等场景。不用于遮罩修补、局部擦除等精细图片编辑、批量生成、透明背景、SVG、代码原生结构图或视频。
skillhub_author: "atridaisuki"
skillhub_version: "1.0.13"
skillhub_uploaded_at: "2026-07-21T08:51:32.163Z"
---

# Image Asset Generator

Create one project-ready raster asset from a text request and up to three optional reference images. The main agent owns the model-facing image prompt and states what each reference is for; bundled scripts own acquisition, immutable file binding, technical output controls, provider calls, persistence, and validation.

Keep this general-purpose skill visually neutral. Do not apply bundled art-direction recipes, house styles, brand palettes, or asset-type templates. A vertical skill or project may provide those decisions in an explicit brief; this skill should preserve and execute them without adding a second generic style layer.

## Boundary

- Generate exactly one new image per run.
- Use Image2 through the CatsCo OpenAI-compatible `POST /images/generations` or `POST /images/edits` gateway as the default provider. The gateway owns two independent provider lanes, per-lane retries, the shared deadline, and winner validation; the Skill makes one gateway call.
- Use the official `dreamina` CLI as an explicit provider or a controlled fallback. It is a shared runtime dependency, not a second Skill and not an account-management layer.
- Dreamina text-to-image uses the explicitly validated `4.7` model node by default instead of the provider's moving default route. Author a compact prompt before submission so the complete assembled prompt normally fits the provider limit. The adapter's recorded compaction remains a compatibility fallback for legacy or unusually long structured requests, not the normal prompt-writing strategy; `request.prompt` remains the complete authored intent.
- With 1-3 references, preserve manifest order and treat the task as reference-guided generation, not a general-purpose image editor. Image2 receives ordered data URLs; Dreamina receives the same hash-bound local files through `image2image`.
- Produce an opaque PNG, JPEG, or WebP file plus `result.json`.
- Do not support masks, localized inpainting, object removal, transparent output, batches, arbitrary client-side providers, or automatic provider switching after an ambiguous direct-provider submission.
- Use HTML/CSS/canvas or a diagram skill when the requested visual should remain code-native or vector-editable.

## Workflow

1. Choose one input mode and keep provenance explicit.
   - **Natural request:** copy the relevant user wording verbatim into `raw-request.txt`. Then write a complete, freeform, model-facing prompt into `prompt.txt`. The prompt is the agent's authored interpretation, not a quotation of the user.
   - Organize the user's requirements into clear visual instructions and add only supporting details that improve renderability. Preserve explicit subjects, relationships, style, mood, composition, exclusions, and required text.
   - For the normal `auto` route, keep `prompt.txt` deliberately compact, usually about 500-700 characters, so reference guidance and the fixed technical wrapper can still fit Dreamina's default 900-character provider budget if fallback is needed. Exceed that target only when the user's actual requirements cannot be preserved otherwise; never pad the prompt with generic quality adjectives.
   - Do not invent identity-defining facts about named people, fictional characters, products, brands, uniforms, or locations. When recognizable identity matters, use an actual user-provided or web-acquired reference image instead of turning search snippets into a longer text description.
   - When acquiring a web reference, prefer an official or primary source when available. Obtain the direct image bytes with image search/browser download; a page URL, thumbnail description, or search summary is not a reference image.
   - When the user says "use the previous image," "continue from the one just shown," or equivalent, locate the most recent semantically matching image path in the visible conversation history, such as a `本地缓存路径`, `[图片: ...]`, or earlier `output.image_path`. Treat it as a valid local reference and pass it directly to `prepare-reference.mjs`; `read_file` is not a prerequisite for submission. Do not claim the image is unavailable or ask the user to upload it again unless that helper explicitly reports that the file is missing, unreadable, or unsupported. Ask only when multiple plausible historical images cannot be disambiguated.
   - Do not require a pre-generation visual inspection of a reference. Selection provenance plus the user's intended `use_for` is sufficient; absence of a vision model must not block the reference pipeline.
   - State what the model should take from every reference, such as `character identity and facial features only` or `outfit design, not pose or background`. Attach no more than three nonduplicate images.
   - Do not force natural requests into mandatory `subject`/`scene`/`style` slots. A well-written freeform prompt is the normal semantic input.
   - **Structured upstream request:** a vertical skill may write `request.json` directly with `prompt`, optional `reference_images`, and separately supplied semantic fields. Do not add generic style recipes on top of upstream art direction.
   - The user's explicit ratio or size wins. When a known target placement makes the canvas unambiguous, select the matching `aspect_ratio` or exact `size`. Otherwise omit both fields and let the generator send `size=auto` so the image model can choose from the prompt; do not force the main agent to guess an orientation or ask the user solely for a ratio.
   - Extract `exact_text` only when the user explicitly requires exact rendered text, and copy those strings exactly. Keep size, quality, format, filename, count, and background in their dedicated fields rather than repeating them as semantic constraints.
   - `creative_freedom` is optional. Set it only when an explicit strict/balanced/open instruction would help; otherwise let the authored prompt carry the creative decision.
   - Never copy semantic content, palette, or style from a bundled file, memory, example, or prior run. Vertical skills may deliberately supply heavier recipes.
   - Ask only when a missing decision would materially change the image.
2. Create a fresh run directory outside the skill folder, preferably:

   ```text
   work/image-asset-generator-runs/<run-id>/
   ```

3. If references are needed, acquire each real image into the run directory before preparing the request. Repeat this command once per reference:

   ```bash
   node "<SKILL_DIR>/scripts/prepare-reference.mjs" --input "<local-image-or-direct-image-url>" --out-dir "<run-dir>" --use-for "<what to preserve or borrow>" [--source-url "<source-page-url>"]
   ```

   The helper copies or downloads the actual pixels, accepts only PNG/JPEG/WebP, strips query credentials from recorded provenance, enforces byte/dimension/count limits, and appends a hash-bound descriptor to `references.json`. Inputs over 3 MiB or with a long edge over 1536 px are converted once into a quality-85 WebP transport copy capped at 1536 px; the source file is never changed, and ordinary inputs keep their original bytes. If a site blocks direct downloading, use the available browser to save the image locally and pass that local path with `--source-url` for provenance. Do not hand-write data URLs or paste base64 into a request.
4. For a natural request, write both text files, then create the request deterministically:

   ```bash
   node "<SKILL_DIR>/scripts/prepare-request.mjs" --prompt "<run-dir>/prompt.txt" --raw-request "<run-dir>/raw-request.txt" --request "<run-dir>/request.json" [--aspect-ratio "<landscape|portrait|square|supported W:H>" | --size "<WIDTHxHEIGHT|auto>"] [--references "<run-dir>/references.json"] [other explicit output options only]
   ```

   The helper hash-binds both text files and every prepared reference without rewriting them. Pass `--references` only when step 3 produced the manifest. If neither `--aspect-ratio` nor `--size` is supplied, the Image2 text-generation adapter sends `size=auto`, the Image2 edits adapter omits `size` because OpenAI-compatible edit routes may reject the literal `auto`, and the Dreamina adapter omits `--ratio`; none silently substitutes a square canvas. An explicit user size is preserved for either Image2 operation. Pass `--quality`, `--output-format`, or `--creative-freedom` only when supplied or deliberately selected. A descriptive ASCII `--filename` is allowed because it does not change image semantics. Structured upstream input may likewise omit both layout fields when writing `request.json` directly against `schemas/request.schema.json`. `--brief/source_brief` exists only to resume or inspect an already-created legacy run; never choose it for a new request, even when memory or an older example recommends it.
5. On a chat surface where `send_text` is available, send one concise visible progress message before starting the provider call because generation can take several minutes. Send at most one such message per run, skip it when there is no outbound chat channel, and never claim completion before the output exists. Then generate the image:

   ```bash
   node "<SKILL_DIR>/scripts/run-image.mjs" --request "<request.json>" --out-dir "<run-dir>"
   ```

   `run-image.mjs` owns provider routing and records it in `provider-state.json`. It makes one synchronous CatsCo gateway call; the gateway starts two fully capable Image2 provider lanes concurrently, retries transient failures independently within the shared deadline, and accepts only the first validated completed image. The Skill must not repeat that gateway call or reconstruct provider retry policy. A task ID is not a winning gateway response. In `auto` mode, structured `race_exhausted` or `providers_unavailable` results then start one Dreamina fallback without asking. Missing configuration, a missing edits route, and the existing explicit rejection allowlist remain fallback paths. An unstructured timeout, connection loss, HTTP 500/502/504/524, or ambiguous direct-provider submission still does not authorize fallback.

   When the user explicitly asks for Dreamina, bypass Image2 deliberately:

   ```bash
   node "<SKILL_DIR>/scripts/run-image.mjs" --provider dreamina --request "<request.json>" --out-dir "<run-dir>"
   ```

   The runner rechecks every reference's bytes, format, dimensions, and SHA-256 before either provider sees it. `request.json`, Image2 dry-run output, logs, and `result.json` never contain full reference-image base64. When using `execute_shell`, allow at least `2190000` ms with default Image2 and async polling timeouts.

6. Let the runner handle either provider response:
   - Image2 direct result: continue immediately with the returned image.
   - Image2 direct-provider asynchronous result: save `pending.json`, poll the recorded task, and never change provider while it is pending. CatsCo gateway mode is synchronous and never accepts a task ID as the race winner.
- Dreamina asynchronous result: save `dreamina-task.json` with its `submit_id`, query that exact task, and download into the run directory. A query or download failure resumes the same task and never resubmits. Downloaded bytes are validated through a temporary file before replacing the run output; a corrupt provider cache is discarded, and a missing or damaged local output is repaired from the original task.
- If Dreamina returns a trustworthy `submit_id` together with an initial failure status, do not treat that first status as terminal. Query the saved task once and continue only from the returned task state; this handles official CLI responses where submit reports `InvalidNode` but `query_result` reports the same task as `querying`.
   - `auth_required`: tell the user the shared Dreamina account needs administrator login. Do not call `login`, `relogin`, or `logout` from this Skill. Re-run the same command after the administrator finishes; no generation was submitted during the failed credit preflight.
   - Every failure result includes `failure.phase`, `failure.submission_state`, `failure.retry_safe`, `failure.fallback_safe`, and a machine-readable `recovery` action. `submission_state=exhausted` means the gateway used its configured relay race without obtaining a valid image before its terminal condition; it may already have created duplicate upstream work, but this route deliberately permits one Dreamina fallback. Route from these fields instead of reconstructing policy from an HTTP status or error message.
   - `recovery.next_action=resume_same_task`: rerun the same command against the recorded Image2 or Dreamina task without asking for confirmation and without submitting a new task.
   - `recovery.next_action=confirm_new_dreamina_run`: for an ambiguous direct-provider submission, stop the current run and explain plainly that Image2 may still be processing. Ask once before starting a fresh Dreamina run.
7. Read the emitted `result.json` after every run. Treat a nonzero exit as a real failure; report its error code and action instead of inventing an output. On success, make chat delivery the first post-generation action: when `send_file` is available, call it immediately with `output.image_path`, before `read_file`, visual review, project copying, or further analysis. Returning only a local path does not count as chat delivery. If `send_file` is unavailable, provide the host's usable artifact link or path immediately. Do not delay the user's preview while performing internal QA.
   - `result.prompt` is the exact prompt assembled and sent by this client; `result.request.prompt` is the agent-authored semantic prompt, while `result.request.raw_request` preserves the user wording. `result.request.reference_images` records only paths, hashes, dimensions, provenance, and `use_for`, never image bytes. If asked what Image2 received, read and show `result.prompt` and the reference descriptors rather than claiming they are unavailable.
   - If polling times out, keep `pending.json` and resume the existing task without submitting a new generation:

     ```bash
     node "<SKILL_DIR>/scripts/run-image.mjs" --request "<request.json>" --out-dir "<run-dir>" --task-id "<task-id>"
     ```

   - Never create a second paid task while `pending.json` exists.
   - Resume only the task recorded in `pending.json`. The script rejects a changed task ID, request file, model, polling endpoint, request path, or output directory.
   - When `result.status=pending` and `result.routing.selected_provider=dreamina`, rerun the same `run-image.mjs` command without `--task-id`; `dreamina-task.json` supplies the saved `submit_id`.
8. Visual review is optional and never blocks chat delivery. Run it only when the user asks for verification, an upstream workflow explicitly requires machine acceptance, or the image will be published automatically without a human preview. Normal chat generation stops at user-visible delivery and leaves `result.review.status=not_run`; do not call `read_file` merely because image reading exists. When review is required, inspect `output.image_path` against the raw user request first and the authored prompt second. In XiaoBa, call `read_file` on that image path so the host can use either the main model's vision capability or its configured reader proxy:
   - Check brief fidelity, purpose fitness, composition, visual coherence, `must_include`, unintended text, obvious corruption, and severe visual defects. Merely containing the requested objects is not enough when the result is visibly generic, awkward, or unusable for its stated purpose.
   - Do not claim pixel-perfect typography or small-text accuracy when it is unreadable.
   - Treat proper names as proper names. Do not reinterpret a named character or product literally during review. If identity cannot be verified visually, mark that check uncertain instead of fabricating a mismatch.
   - A reference does not need to be opened before submission. After generation, compare output identity or appearance to the reference only when the host can actually inspect both; otherwise mark that check uncertain.
   - Do not regenerate merely because another style might be nicer. Regenerate only for a concrete requirement failure or when the user asks.
   - If `read_file` explicitly says a remote channel did not forward image data, leave `status=not_run`; host logs that mention image preprocessing do not count as a visual result.
9. Only when step 8 actually ran, write `review.json` matching `schemas/review.schema.json`, then record it deterministically:

   ```bash
   node "<SKILL_DIR>/scripts/record-review.mjs" --result "<run-dir>/result.json" --review "<run-dir>/review.json"
   ```

   If review was skipped, do not create `review.json` or call `record-review.mjs`; the generator's existing `not_run` status is sufficient. Do not edit the `review` field in `result.json` directly. The recorder verifies that an actually reviewed image still matches its recorded SHA-256.
10. After the chat preview has been sent, decide whether the result is also a project-bound asset. If the user named a destination, or the current project's asset convention makes the destination unambiguous, copy the generated image into the project with the delivery helper while keeping the run artifacts intact:

   ```bash
   node "<SKILL_DIR>/scripts/deliver-asset.mjs" --result "<run-dir>/result.json" --destination-dir "<project-asset-dir>"
   ```

   Use `--destination-file "<project-file>"` when a specific filename is required. Never pass `--overwrite` unless the user explicitly approved replacing that exact file. If a different file already exists, choose a versioned sibling filename or ask the user. If the destination is ambiguous, keep the already-delivered preview instead of guessing. Do not leave a project-bound final asset only in the run directory.
11. Finish with a concise status and the final saved path. Keep `raw-request.txt`, `prompt.txt`, optional `references.json` plus `references/`, `request.json`, optional `review.json`, and `result.json` in the run directory for traceability. Do not burden the user with an "unreviewed preview" disclaimer merely because optional machine review was skipped, but never claim visual approval unless a review actually succeeded.

## Configuration

The script reads configuration from the runtime environment:

- In XiaoBa/CatsCo, no image-specific user configuration is required. The script detects the existing `CATSCO_HTTP_BASE_URL`, appends `/v1`, and first uses the current bot's `CATSCO_API_KEY`. When that gateway identity is explicitly rejected with HTTP 401 and an existing `CATSCO_USER_TOKEN` is available, it retries exactly once with the user's login identity; a 401 is an explicit rejection and cannot represent an accepted image task. Missing bot identity uses the user token directly.
- `CATSCO_IMAGE_API_BASE` remains an optional explicit gateway override. `IMAGE_GEN_DISABLE_CATSCO_GATEWAY=true` disables only automatic discovery for a deliberate direct-provider run.
- `IMAGE_GEN_API_KEY` is preferred; `OPENAI_API_KEY` is accepted as a fallback.
- `IMAGE_GEN_API_BASE` defaults to `https://api.openai.com/v1`.
- `IMAGE_GEN_MODEL` defaults to `gpt-image-2`.
- `IMAGE_GEN_TIMEOUT_MS` defaults to `600000`. The deployed CatsCo gateway and its reverse proxy must use shorter ordered budgets so they can return a structured terminal response before the client aborts.
- `IMAGE_GEN_MAX_RETRIES` defaults to `1`. It applies only to an explicitly rejected Image2 submit with HTTP 429 and to safe image-URL downloads; it never retries an ambiguous paid submission.
- `IMAGE_GEN_RETRY_DELAY_MS` defaults to `1000` between safe retries.
- `IMAGE_GEN_ASYNC_SUBMIT=true` applies only to deliberate direct-provider text generation. CatsCo gateway mode always requests a completed synchronous image because a task ID cannot win a multi-relay race. Reference-guided `/images/edits` requests also stay synchronous.
- `IMAGE_GEN_ASYNC_POLL_BASE` defaults to the selected image endpoint origin.
- Direct-provider asynchronous polling uses the configured polling origin. CatsCo gateway mode does not poll client-side tasks.
- `IMAGE_GEN_ASYNC_POLL_INTERVAL_MS` defaults to `3000`.
- `IMAGE_GEN_ASYNC_TIMEOUT_MS` defaults to `1800000` (30 minutes).
- `IMAGE_GEN_PROVIDER` defaults to `auto`; use `image2` to disable fallback or `dreamina` only for an explicit provider choice.
- `DREAMINA_CLI_BIN` may point to the official CLI; otherwise it must be available as `dreamina` on `PATH`.
- `DREAMINA_CLI_TIMEOUT_MS` defaults to `120000` per CLI command. `DREAMINA_IMAGE_WAIT_SECONDS` controls inline polling and defaults to `120`.
- `DREAMINA_IMAGE_MODEL_VERSION` overrides the explicit Dreamina model. Text-to-image defaults to the validated `4.7` node; reference-guided image-to-image keeps the provider default unless overridden.
- `DREAMINA_IMAGE_PROMPT_MAX_CHARS` defaults to `900`. The main agent should normally stay within that assembled provider budget proactively. Longer legacy or structured prompts are compacted across paragraph sections as a recorded compatibility fallback rather than silently keeping only the beginning.
- Dreamina OAuth state belongs to the shared cloud runtime account. This Skill reads it through the CLI but never installs the CLI or performs login/account lifecycle operations.
- On every run, missing image and CatsCo gateway variables are also loaded from `IMAGE_GEN_ENV_FILE`, the XiaoBa/CatsCo runtime `.env`, or the current working directory `.env`, in that order. Existing process environment values always win, so changing the dedicated runtime `.env` does not require restarting XiaoBa.
- Never place API keys in `request.json`, shell arguments, logs, or `result.json`.
- Never send a CatsCo user or bot credential to `IMAGE_GEN_API_BASE`; CatsCo credentials are sent only to the explicit gateway override or the gateway derived from the runtime's existing CatsCo service URL.
- Image2 reference-guided runs require `/images/edits`. In `auto` mode, a missing route is a safe fallback condition for Dreamina `image2image`; in `image2` mode it remains `REFERENCE_GATEWAY_UNAVAILABLE`.

Read `references/provider-api.md` only when configuring a custom endpoint or troubleshooting an API failure.

## Rules

- Write outputs outside the skill directory.
- Keep `raw-request.txt` and `prompt.txt` unchanged after request preparation. The generator verifies both SHA-256 digests before dry-run, submission, and resume.
- Keep prepared files under `references/` unchanged after request preparation. The generator rejects changed bytes, metadata, format, or SHA-256 before any provider call.
- Pass actual reference pixels through `prepare-reference.mjs`; never substitute a web-search summary, prose description, page HTML, manually assembled base64, or a duplicate image.
- Keep the user's source image unchanged. Let `prepare-reference.mjs` create the one-time transport copy only when its fixed oversized-image threshold is crossed; do not pre-compress it separately.
- Keep each reference's `use_for` narrow and explicit. The script preserves the order and adds only that mapping to the model-facing prompt; it does not invent reference semantics.
- Do not require a multimodal preflight review of references. Reference acquisition and deterministic validation must also work when the main model cannot see images.
- Use `source_prompt` plus `source_request` for ordinary natural requests. Use direct `prompt` and semantic helper fields for structured upstream input. Treat `source_brief` as legacy compatibility only.
- Keep the deterministic wrapper technical and conditional: framing, one opaque raster output, and no unsolicited text, watermark, or signature. Put visual semantics in the agent-authored prompt.
- Treat this loaded Skill and its current scripts as authoritative over memory, prior-run summaries, and examples that describe an older prompt workflow.
- If the host blocks required script execution, report the blocked step. Do not reconstruct hashes or dry-run output manually, and do not create alternate runner scripts or documentation as a workaround.
- Keep `count` equal to `1` and `background` equal to `opaque`.
- Use a new run directory instead of overwriting prior outputs.
- On successful generation, attempt `send_file` before any `read_file`, visual review, or project-delivery work. Optional QA must never hide or delay the generated image.
- The generation script intentionally has no overwrite option. Only the separate project-delivery helper may overwrite an exact destination after explicit user approval.
- Resume a direct-provider Image2 task recorded in `pending.json` or the Dreamina task recorded in `dreamina-task.json`; never infer task identity from provider history.
- Allow provider switching only through `run-image.mjs`: explicit `--provider dreamina`, or its safe fallback allowlist. Never reconstruct fallback decisions in the main agent.
- Never fallback after an unstructured Image2 timeout, network loss, HTTP 500/502/504/524, safety rejection, malformed input, or unknown direct-provider submission. The explicit exception is a CatsCo gateway `race_exhausted` or `providers_unavailable` contract: the server has finished its bounded relay strategy, and `auto` deliberately starts one Dreamina fallback even though duplicate upstream work may exist.
- A failed visual review does not authorize another billable generation. Report the concrete failure and ask before starting a fresh run.
- The Skill submits one billable POST to the CatsCo gateway. Do not reconstruct or repeat the gateway's internal relay rounds in the main agent or Skill scripts. For deliberate direct-provider mode, retry a billable Image2 POST only after an explicit HTTP 429 rejection; do not retry HTTP 500/502/503/504/524, a client timeout, connection loss, or an invalid success response. The only identity replay is an explicit CatsCo ApiKey HTTP 401 followed once by the already-available user Bearer token. An HTTP 400 is fallback-safe only when an edits request explicitly says the attached reference was not received; ordinary request rejection remains terminal.
- Keep non-billable retries bounded. The adapters may retry a transient Dreamina credit preflight, query the same saved task again, or retry an image-URL download; none of these retries may create a new generation task.
- Do not describe an image as visually approved unless an image-reading pass actually succeeded.
