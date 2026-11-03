# SkillHub presentation generation

After a local Skill publication succeeds, XiaoBa starts a background attempt to create the version-bound Chinese guide shown in SkillHub. This applies to the chat publication tool, Dashboard workspace publication and CatsCo device RPC publication. The Skill upload result does not wait for guide generation, and a guide-generation failure never rolls back the published Skill. The caller's message says an attempt started; it is not a success signal. Check the SkillHub catalogue later for the result.

The generator uses the current publisher model configuration: the active Bot's effective CatsCo model when available, otherwise XiaoBa's configured default model. The publisher's model account incurs the generation usage. XiaoBa sends the selected text files from the uploaded package (up to 64 KiB total, with a required complete root `SKILL.md`) to that model provider. The text is treated as untrusted data and is never executed. Do not publish a package containing credentials or other material you do not intend to send to the configured model provider.

SkillHub publication is asynchronous. The generator waits for the exact version to become readable after a 404, using bounded backoff for up to about 90 seconds. If the package is still not visible, the model fails, or the presentation API rejects the write, the attempt stops and the Skill remains published. Retrying publication or a later explicit operation may start another attempt. Concurrent attempts for the same version in one XiaoBa process are coalesced.

An existing published guide or author draft is preserved. A newly generated guide is saved as a draft and immediately published with the returned revision. Optional lists omitted by the model are stored as empty lists. Examples must be labeled “示意，非实测”.

The SkillHub Cloud environment must have both `SKILLHUB_PRESENTATIONS_READ_ENABLED=1` and `SKILLHUB_PRESENTATIONS_WRITE_ENABLED=1`; writes require reads. Production defaults both switches off. Image upload configuration is unrelated to generated text guides.
