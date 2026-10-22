/** A deliberately small argv grammar, not a shell interpreter. */
export interface ArtifactCommandSegment {
  argv: string[];
  after: 'always' | 'success';
}

/** Preserve quoted separators; reject expansions, pipelines and redirections. */
export function parseArtifactCommandPlan(input: string): ArtifactCommandSegment[] | undefined {
  if (!input.trim() || input.length > 65536 || input.includes('\0')) return undefined;
  const segments: ArtifactCommandSegment[] = [];
  let argv: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  const state: { after: ArtifactCommandSegment['after'] } = { after: 'always' };
  const pushWord = () => {
    if (started) argv.push(word);
    word = '';
    started = false;
  };
  const pushSegment = (next: ArtifactCommandSegment['after'], blankLine = false) => {
    pushWord();
    if (argv.length) {
      segments.push({ argv, after: state.after });
      argv = [];
      state.after = next;
      return segments.length <= 16;
    }
    // Blank lines after && do not turn a conditional command into an unconditional one.
    return blankLine;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) { quote = undefined; continue; }
      if (quote === '"' && (c === '$' || c === '`')) return undefined;
      if (quote === '"' && c === '\\' && ['"', '\\'].includes(input[i + 1])) {
        word += input[++i];
      } else if (quote === '"' && c === '\\' && /[\r\n]/.test(input[i + 1] || '')) {
        if (input[++i] === '\r' && input[i + 1] === '\n') i++;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\') {
      if (i + 1 === input.length) return undefined;
      if (input[i + 1] === '\n' || input[i + 1] === '\r') {
        if (input[++i] === '\r' && input[i + 1] === '\n') i++;
      } else { word += input[++i]; started = true; }
      continue;
    }
    if (c === '&' && input[i + 1] === '&') {
      if (!pushSegment('success')) return undefined;
      i++;
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r') {
      if (!pushSegment('always', c !== ';')) return undefined;
      if (c === '\r' && input[i + 1] === '\n') i++;
      continue;
    }
    if ('|&<>()$`'.includes(c) || (c === '#' && !started) || c === '\0') return undefined;
    if (/\s/.test(c)) { pushWord(); continue; }
    word += c;
    started = true;
  }
  if (quote) return undefined;
  pushWord();
  if (argv.length) segments.push({ argv, after: state.after });
  else if (state.after === 'success') return undefined;
  return segments.length && segments.length <= 16 ? segments : undefined;
}
