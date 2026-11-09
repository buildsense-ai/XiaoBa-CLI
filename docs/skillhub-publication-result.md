# Conversation publication results

After an accepted share, `share_skillhub_skill` reads the exact assigned public version, downloads its package, verifies its certificate/signature/checksum, and compares every file with the validated upload copy. Only Hub tracking metadata may differ in SKILL.md. No package is installed by this check. Ordinary, automatic-repair, and confirmed-description shares use the same wrapper; already verified Bot-reference finalization retains its published result.

The tool waits up to 60 seconds for public verification. A verified package returns `published`; signature, identity, or content mismatch returns `verification_failed`. Missing/not-ready versions and network errors remain uncertain (`submitted`); none of these read outcomes retries the upload. Chinese guide generation remains separate.

If still uncertain and a valid same-conversation follow-up callback exists, read-only polling continues every 15 seconds for at most ten further minutes. A later success/verification failure, or uncertainty at the deadline, is sent to the original conversation. Notification delivery retries at most three times. This is bounded in-process follow-up, not a durable queue: runtime restart interrupts it, and stopping/clearing the originating conversation suppresses its notification. Absent a valid channel or sufficient retention capacity, the receipt explicitly says follow-up is unavailable instead of promising a notification. Background retention is limited to 64 jobs / 64 MiB of encoded source files.

CatsCo captures the original reply_to when creating the callback. It never consults a later turn's reply tracker or emits a completion marker for that later turn. The outbound scope gateway must approve the original conversation before the callback is used.

Validation covers delayed readiness, read outages and deadlines, verification failure, cancellation/capacity, exact signed version reads without installation, altered content, stale conversation routing, and accepted-upload preservation when follow-up setup fails.
