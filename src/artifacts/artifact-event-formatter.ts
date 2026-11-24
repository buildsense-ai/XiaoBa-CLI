import {
  type AnnotationAnchor,
  type AnnotationEventPayload,
  type A2uiActionPayload,
  type A2uiEventPayload,
  type A2uiFormSubmitPayload,
  type A2uiStateChangePayload,
  type ArtifactEventEnvelope,
  artifactEventFamily,
} from './artifact-event-contract';

/**
 * Render validated artifact events into structured, model-facing wake prompts.
 * The prompts are plain markdown text blocks designed to be injected as a user
 * turn or wake message by the event router.
 */

export function formatArtifactEventPrompt(envelope: ArtifactEventEnvelope): string {
  return artifactEventFamily(envelope.kind) === 'a2ui'
    ? formatA2uiEventPrompt(envelope)
    : formatAnnotationEventPrompt(envelope);
}

/**
 * Render a coalesced annotation batch (multiple annotations on one artifact)
 * into a single wake prompt.
 */
export function formatAnnotationBatchPrompt(envelopes: ArtifactEventEnvelope[]): string {
  const annotations = envelopes.filter(e => artifactEventFamily(e.kind) === 'annotation');
  const artifactId = annotations[0]?.artifactId ?? 'unknown';
  const lines: string[] = [
    '[Artifact Annotation Batch]',
    `Artifact: ${artifactId}`,
    `Annotations: ${annotations.length}`,
    '',
  ];
  annotations.forEach((envelope, index) => {
    const payload = envelope.payload as AnnotationEventPayload;
    lines.push(`${index + 1}. ${annotationVerb(envelope.kind)} (annotation ${payload.annotationId})`);
    const anchorText = formatAnchor(payload.anchor);
    if (anchorText) lines.push(`   Anchor: ${anchorText}`);
    if (payload.quote) lines.push(`   Quote: "${truncate(payload.quote, 200)}"`);
    if (payload.comment) lines.push(`   Comment: ${payload.comment}`);
  });
  lines.push(
    '',
    'Instructions:',
    '- The user submitted the annotations above on this artifact. Address each numbered annotation.',
    '- Acknowledge what was reviewed and apply the requested changes or replies.',
    '- If an annotation is unclear, state your interpretation before acting.',
  );
  return lines.join('\n');
}

function formatA2uiEventPrompt(envelope: ArtifactEventEnvelope): string {
  const payload = envelope.payload as A2uiEventPayload;
  const lines: string[] = [
    `[Artifact A2UI Event] ${envelope.kind}`,
    `Artifact: ${envelope.artifactId}`,
    `Component: ${payload.componentId}`,
  ];

  switch (envelope.kind) {
    case 'a2ui_action': {
      const action = payload as A2uiActionPayload;
      lines.push(`Action: ${action.actionName}`);
      if (action.params && Object.keys(action.params).length > 0) {
        lines.push(`Params: ${stableJson(action.params)}`);
      }
      break;
    }
    case 'a2ui_form_submit': {
      const submit = payload as A2uiFormSubmitPayload;
      lines.push(`Action: ${submit.actionName}`);
      lines.push('Form data:');
      for (const [key, value] of Object.entries(submit.formData)) {
        lines.push(`  - ${key}: ${formatScalar(value)}`);
      }
      break;
    }
    case 'a2ui_state_change': {
      const change = payload as A2uiStateChangePayload;
      lines.push(`New state: ${stableJson(change.state)}`);
      if (change.previousState) {
        lines.push(`Previous state: ${stableJson(change.previousState)}`);
      }
      break;
    }
  }

  if (envelope.actorUserId) lines.push(`Actor: ${envelope.actorUserId}`);
  lines.push(
    '',
    'Instructions:',
    '- The user interacted with the artifact above. Respond to this interaction and update the artifact or conversation state accordingly.',
    '- Do not re-render or re-send the artifact unless the interaction requires it.',
  );
  return lines.join('\n');
}

function formatAnnotationEventPrompt(envelope: ArtifactEventEnvelope): string {
  const payload = envelope.payload as AnnotationEventPayload;
  const lines: string[] = [
    `[Artifact Annotation] ${envelope.kind}`,
    `Artifact: ${envelope.artifactId}`,
    `Annotation: ${payload.annotationId}`,
  ];
  const anchorText = formatAnchor(payload.anchor);
  if (anchorText) lines.push(`Anchor: ${anchorText}`);
  if (payload.quote) lines.push(`Quote: "${truncate(payload.quote, 200)}"`);
  if (payload.comment) lines.push(`Comment: ${payload.comment}`);
  if (envelope.actorUserId) lines.push(`Actor: ${envelope.actorUserId}`);
  lines.push(
    '',
    'Instructions:',
    `- The user ${annotationVerb(envelope.kind).toLowerCase()} an annotation on this artifact.`,
    '- Address the annotation: apply the requested change, reply to the comment, or confirm the resolution.',
  );
  return lines.join('\n');
}

function annotationVerb(kind: string): string {
  switch (kind) {
    case 'annotation_create': return 'Created';
    case 'annotation_update': return 'Updated';
    case 'annotation_resolve': return 'Resolved';
    case 'annotation_dismiss': return 'Dismissed';
    default: return kind;
  }
}

function formatAnchor(anchor: AnnotationAnchor | undefined): string | undefined {
  if (!anchor) return undefined;
  switch (anchor.type) {
    case 'text': {
      const parts = [`text "${truncate(anchor.exact, 80)}"`];
      if (anchor.start !== undefined) parts.push(`offset ${anchor.start}`);
      if (anchor.end !== undefined) parts.push(`-${anchor.end}`);
      return parts.join(' ');
    }
    case 'region': {
      const parts = [`region (x=${anchor.x}, y=${anchor.y}, w=${anchor.width}, h=${anchor.height})`];
      if (anchor.page !== undefined) parts.push(`page ${anchor.page}`);
      return parts.join(' ');
    }
    case 'component': {
      const parts = [`component ${anchor.componentId}`];
      if (anchor.selector) parts.push(`(${anchor.selector})`);
      return parts.join(' ');
    }
    default:
      return undefined;
  }
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return stableJson(value);
  return String(value);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    return String(value);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
