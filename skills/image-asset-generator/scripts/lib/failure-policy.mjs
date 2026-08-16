const IMAGE2_FALLBACK_CODES = new Set([
  "INVALID_CONFIGURATION",
  "MISSING_API_KEY",
  "MISSING_CATSCO_IDENTITY",
  "REFERENCE_GATEWAY_UNAVAILABLE",
]);

const IMAGE2_RACE_FALLBACK_CODES = new Set([
  "IMAGE_RACE_EXHAUSTED",
  "IMAGE_RACE_UNAVAILABLE",
]);

const IMAGE2_FALLBACK_HTTP_STATUSES = new Set([401, 404, 429, 501, 503]);
const REFERENCE_ATTACHMENT_REJECTION_PATTERNS = [
  /\b(?:please\s+)?(?:upload|attach)\s+(?:the\s+|a\s+)?reference image\b/i,
  /\bneed(?:s)?\s+(?:the\s+|a\s+)?reference image(?:\s+first)?\b/i,
];
const IMAGE2_UNKNOWN_CODES = new Set([
  "API_NETWORK_ERROR",
  "API_TIMEOUT",
  "SUBMISSION_UNKNOWN",
  "UPSTREAM_TIMEOUT",
]);
const IMAGE2_RESUMABLE_CODES = new Set([
  "ASYNC_POLL_FAILED",
  "ASYNC_TASK_TIMEOUT",
  "IMAGE_DOWNLOAD_FAILED",
  "PENDING_TASK_EXISTS",
]);
const IMAGE2_TASK_TERMINAL_CODES = new Set([
  "ASYNC_TASK_FAILED",
  "ASYNC_TASK_NOT_FOUND",
]);
const IMAGE2_VALIDATION_CODES = new Set([
  "IMAGE_DIMENSION_MISMATCH",
  "IMAGE_TOO_LARGE",
  "INVALID_IMAGE",
]);
const REQUEST_CODES = new Set([
  "INVALID_ARGUMENT",
  "INVALID_PENDING_TASK",
  "INVALID_REQUEST",
  "INVALID_REQUEST_FILE",
  "PENDING_TASK_CONTEXT_MISMATCH",
  "PENDING_TASK_NOT_FOUND",
  "PENDING_TASK_PROVIDER_MISMATCH",
  "PENDING_TASK_REQUEST_MISMATCH",
  "ASYNC_TASK_ID_MISMATCH",
  "UNSUPPORTED_DREAMINA_RATIO",
  "UNSUPPORTED_OPERATION",
]);

function contract({
  phase,
  submissionState,
  retrySafe = false,
  fallbackSafe = false,
  nextAction,
  canResumeSameTask = false,
  requiresUserConfirmation = false,
  duplicateGenerationRisk = false,
}) {
  return {
    failure: {
      phase,
      submission_state: submissionState,
      retry_safe: Boolean(retrySafe),
      fallback_safe: Boolean(fallbackSafe),
    },
    recovery: {
      next_action: nextAction,
      can_resume_same_task: Boolean(canResumeSameTask),
      requires_user_confirmation: Boolean(requiresUserConfirmation),
      duplicate_generation_risk: Boolean(duplicateGenerationRisk),
    },
  };
}

function unknownImage2Submission() {
  return contract({
    phase: "submit",
    submissionState: "unknown",
    nextAction: "confirm_new_dreamina_run",
    requiresUserConfirmation: true,
    duplicateGenerationRisk: true,
  });
}

export function isImage2ReferenceAttachmentRejected(error = {}) {
  if (String(error?.code || "") !== "API_REQUEST_FAILED") return false;
  if (Number(error?.details?.status) !== 400) return false;
  if (String(error?.details?.operation || "") !== "edits") return false;
  const message = String(error?.message || "");
  return REFERENCE_ATTACHMENT_REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

export function image2FailurePolicy(error = {}) {
  const code = String(error?.code || "IMAGE2_EXECUTOR_FAILED");
  const status = Number(error?.details?.status);

  if (IMAGE2_UNKNOWN_CODES.has(code)) return unknownImage2Submission();
  if (code === "INVALID_API_RESPONSE") return unknownImage2Submission();

  if (IMAGE2_RACE_FALLBACK_CODES.has(code)) {
    return contract({
      phase: "submit",
      submissionState: "exhausted",
      fallbackSafe: true,
      nextAction: "fallback_to_dreamina",
      duplicateGenerationRisk: true,
    });
  }

  if (IMAGE2_RESUMABLE_CODES.has(code)) {
    return contract({
      phase: code === "IMAGE_DOWNLOAD_FAILED" ? "download" : "query",
      submissionState: "submitted",
      retrySafe: true,
      nextAction: "resume_same_task",
      canResumeSameTask: true,
    });
  }

  if (IMAGE2_TASK_TERMINAL_CODES.has(code)) {
    return contract({
      phase: "query",
      submissionState: "submitted",
      nextAction: "stop",
    });
  }

  if (IMAGE2_VALIDATION_CODES.has(code)) {
    return contract({
      phase: "validation",
      submissionState: "submitted",
      nextAction: "stop",
    });
  }

  if (IMAGE2_FALLBACK_CODES.has(code)) {
    return contract({
      phase: code === "REFERENCE_GATEWAY_UNAVAILABLE" ? "submit" : "preflight",
      submissionState: "not_submitted",
      retrySafe: code !== "REFERENCE_GATEWAY_UNAVAILABLE",
      fallbackSafe: true,
      nextAction: "fallback_to_dreamina",
    });
  }

  if (isImage2ReferenceAttachmentRejected(error)) {
    return contract({
      phase: "submit",
      submissionState: "not_submitted",
      fallbackSafe: true,
      nextAction: "fallback_to_dreamina",
    });
  }

  if (code === "API_REQUEST_FAILED") {
    if (IMAGE2_FALLBACK_HTTP_STATUSES.has(status)) {
      return contract({
        phase: "submit",
        submissionState: "not_submitted",
        retrySafe: status === 429,
        fallbackSafe: true,
        nextAction: "fallback_to_dreamina",
      });
    }
    if (status >= 500 || !Number.isFinite(status)) return unknownImage2Submission();
    return contract({
      phase: "submit",
      submissionState: "not_submitted",
      nextAction: "fix_request",
    });
  }

  if (REQUEST_CODES.has(code)) {
    return contract({
      phase: "preflight",
      submissionState: "not_submitted",
      nextAction: "fix_request",
    });
  }

  if (code === "OUTPUT_EXISTS") {
    return contract({
      phase: "local",
      submissionState: "not_submitted",
      nextAction: "use_existing_output",
    });
  }

  return contract({
    phase: "local",
    submissionState: "not_submitted",
    nextAction: "fix_runtime",
  });
}

export function dreaminaFailurePolicy(error = {}, options = {}) {
  const code = String(error?.code || "INTERNAL_ERROR");
  const hasTask = Boolean(options.hasTask);

  if (code === "SUBMISSION_UNKNOWN") {
    return contract({
      phase: "submit",
      submissionState: "unknown",
      nextAction: "confirm_new_run",
      requiresUserConfirmation: true,
      duplicateGenerationRisk: true,
    });
  }

  if (hasTask) {
    if ([
      "AUTH_REQUIRED",
      "COMPLIANCE_CONFIRMATION_REQUIRED",
      "DOWNLOAD_FAILED",
      "INSUFFICIENT_CREDIT",
      "PROVIDER_UNAVAILABLE",
      "QUERY_FAILED",
    ].includes(code)) {
      return contract({
        phase: code === "DOWNLOAD_FAILED" ? "download" : "query",
        submissionState: "submitted",
        retrySafe: true,
        nextAction: "resume_same_task",
        canResumeSameTask: true,
      });
    }
    return contract({
      phase: "query",
      submissionState: "submitted",
      nextAction: "stop",
    });
  }

  if ([
    "AUTH_REQUIRED",
    "CLI_UNAVAILABLE",
    "COMPLIANCE_CONFIRMATION_REQUIRED",
    "INSUFFICIENT_CREDIT",
    "PROVIDER_UNAVAILABLE",
  ].includes(code)) {
    return contract({
      phase: "preflight",
      submissionState: "not_submitted",
      retrySafe: true,
      nextAction: "retry_same_run",
    });
  }

  if (REQUEST_CODES.has(code) || code === "REQUEST_MISMATCH") {
    return contract({
      phase: "preflight",
      submissionState: "not_submitted",
      nextAction: "fix_request",
    });
  }

  return contract({
    phase: "submit",
    submissionState: "not_submitted",
    nextAction: "stop",
  });
}

export function pendingRecovery() {
  return {
    next_action: "resume_same_task",
    can_resume_same_task: true,
    requires_user_confirmation: false,
    duplicate_generation_risk: false,
  };
}
