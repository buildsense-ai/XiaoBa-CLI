# Skill archive intake

The conversation publishing tool accepts a ZIP-format `.zip` or `.skill` attachment, optionally containing one unambiguous nested archive. Both layers share entry, expanded-size, and elapsed-time budgets. Intake uses a 30-second deadline and the originating turn's cancellation signal; those options are set by the runtime, not tool arguments.

Compressed bytes come from yauzl, while a Node pipeline owns the inflater, byte limiter, CRC-32 check, and destination stream. This avoids relying on yauzl's decompressed endpoint's custom `destroy()` behavior, which can leave a pipeline pending on incorrect expanded-size metadata. Any size mismatch, checksum mismatch, decompression error, cancellation, or deadline rejects intake and removes its private extraction directory before returning. No publishing service is called for a rejected attachment. The deadline interrupts stream and archive callback waits; it cannot preempt a blocked OS filesystem operation or synchronous JavaScript.

Tests cover the original incorrect UTF-8 byte-count archive, CRC-only corruption, stalled entry timeout and cancellation with stream destruction and directory cleanup, pre-cancellation, and rejection before publication. Ordinary direct and nested packages retain the existing path/type/entry/volume restrictions.
