// Summary-only readers must ignore transcript/runtime/future event rows.
// Keep support for legacy summaries without an entry_type discriminator.
function readTurnSummaries(content) {
  const turns = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || (entry.entry_type !== undefined && entry.entry_type !== 'turn')) continue;
      if (typeof entry.turn !== 'number' || typeof entry.timestamp !== 'string'
        || typeof entry.user?.text !== 'string' || typeof entry.assistant?.text !== 'string'
        || !Array.isArray(entry.assistant?.tool_calls)) continue;
      turns.push(entry);
    } catch {
      // A damaged line or unfinished tail must not discard valid summaries.
    }
  }
  return turns;
}

module.exports = { readTurnSummaries };
