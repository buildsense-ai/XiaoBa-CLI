# External Provider Reads Use Bounded Concurrency

Status: accepted

The Runtime completes its Internal Source Work Lane first, then reads and normalizes eligible External Source Work Lanes concurrently with a configurable limit of one to eight and a default of three. Distinct providers may overlap because their cursors, locks, backoff, and quarantine state are independent; work for the same provider remains serialized.

External reads do not become parallel evidence writers. A single External Admission Coordinator commits ready pages in work-conserving round-robin order, one page per provider turn, using the existing Episode → Capsule → provenance → cursor-ack order. This captures the latency benefit of overlapping xURL processes without introducing concurrent writes to shared local stores or changing the Skill Evolution pipeline.

At a scheduling deadline or provider disable, replayable reads are canceled and ready-but-uncommitted pages are discarded without acknowledgement. Only a durable commit that has already started may drain; scheduler cancellation does not count as provider failure, quarantine, backoff, or Operational Review Retry.
