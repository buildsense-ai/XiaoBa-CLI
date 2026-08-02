import { Message } from '../types';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';
import { BranchRunOutcome, BranchSession, BranchSessionOptions } from './branch-session';

export interface ObservationBranchSessionOptions extends BranchSessionOptions {
  queue: SyntheticObservationQueue;
}

export interface ObservationBranchDisposition {
  inject: boolean;
  logPayload?: Record<string, unknown>;
}

export type ObservationBranchCompletionStatus =
  | 'published'
  | 'suppressed'
  | 'discarded'
  | 'cancelled'
  | 'failed';

export interface ObservationBranchCompletion {
  branchId: string;
  branchType: string;
  status: ObservationBranchCompletionStatus;
  observationId?: string;
  observationRefs?: string[];
  observationRefDigests?: Record<string, string>;
  toolNames: string[];
  errorCode?: 'branch_execution_failed';
}

/**
 * BranchSession specialization for side branches that publish synthetic
 * runtime observations back to the parent runner.
 */
export abstract class ObservationBranchSession<TFinishPayload> extends BranchSession {
  private finishPayload: TFinishPayload | null = null;

  protected constructor(protected readonly observationOptions: ObservationBranchSessionOptions) {
    super(observationOptions);
  }

  async run(): Promise<ObservationBranchCompletion> {
    try {
      while (this.shouldContinue() && !this.finishPayload) {
        const outcome = await this.runConversation();
        if (this.finishPayload || !this.shouldContinue()) break;

        this.handleStrayOutput(outcome);
        this.messages.push(this.buildFinishReminderMessage(outcome));
      }

      if (!this.finishPayload) {
        if (!this.shouldContinue()) {
          this.logCancelledBeforeFinish(false);
        }
        return this.completion('cancelled');
      }
      if (!this.shouldContinue()) {
        this.logger.write('finished_after_cancel', this.buildFinishedAfterCancelLogPayload(this.finishPayload));
        return this.completion('cancelled');
      }

      const disposition = this.getObservationDisposition(this.finishPayload);
      if (!disposition.inject) {
        this.logger.write('suppressed_observation', {
          reason: 'inject_false',
          ...(disposition.logPayload || {}),
        });
        return this.completion('suppressed');
      }

      const observation = this.buildObservation(this.finishPayload);
      const pushed = this.observationOptions.queue.push(observation);
      const logPayload = this.buildPublishedObservationLogPayload(this.finishPayload, observation);
      if (pushed) {
        this.logger.write('published_observation', logPayload);
        return this.completion('published', observation);
      } else {
        this.logger.write('discarded_observation', {
          ...logPayload,
          reason: 'queue_closed_or_duplicate',
        });
        return this.completion('discarded', observation);
      }
    } catch (error: any) {
      if (this.isAbortError(error) || !this.shouldContinue()) {
        this.logCancelledBeforeFinish(true);
        return this.completion('cancelled');
      } else {
        this.logFailure(error);
        return this.completion('failed', undefined, 'branch_execution_failed');
      }
    }
  }

  protected complete(payload: TFinishPayload): void {
    this.finishPayload = payload;
  }

  protected hasFinishPayload(): boolean {
    return this.finishPayload !== null;
  }

  protected getFinishPayload(): TFinishPayload | null {
    return this.finishPayload;
  }

  protected handleStrayOutput(outcome: BranchRunOutcome): void {
    const strayOutput = String(outcome.result?.response || '').trim();
    if (strayOutput) {
      this.logger.write('stray_assistant_output', { text: strayOutput });
    }
  }

  protected buildFinishReminderMessage(_outcome: BranchRunOutcome): Message {
    return {
      role: 'user',
      content: [
        'Your previous response will not be sent to the parent agent.',
        'This branch can only finish by calling its finish tool.',
        'Use the best currently available summary and evidence, or finish with inject:false if there is nothing useful to inject.',
      ].join(' '),
    };
  }

  protected buildFinishedAfterCancelLogPayload(payload: TFinishPayload): Record<string, unknown> {
    const disposition = this.getObservationDisposition(payload);
    return {
      inject: disposition.inject,
      ...(disposition.logPayload || {}),
    };
  }

  protected buildPublishedObservationLogPayload(
    payload: TFinishPayload,
    observation: SyntheticObservation,
  ): Record<string, unknown> {
    const disposition = this.getObservationDisposition(payload);
    return {
      observation_id: observation.id,
      ...(disposition.logPayload || {}),
      tool_result_content: observation.formattedContent,
    };
  }

  protected abstract getObservationDisposition(payload: TFinishPayload): ObservationBranchDisposition;
  protected abstract buildObservation(payload: TFinishPayload): SyntheticObservation;

  private completion(
    status: ObservationBranchCompletionStatus,
    observation?: SyntheticObservation,
    errorCode?: ObservationBranchCompletion['errorCode'],
  ): ObservationBranchCompletion {
    return {
      branchId: this.branchId,
      branchType: this.branchType,
      status,
      ...(observation?.id ? { observationId: observation.id } : {}),
      ...(Array.isArray(observation?.metadata?.refs) ? {
        observationRefs: observation.metadata.refs
          .filter((ref): ref is string => typeof ref === 'string' && Boolean(ref.trim())),
      } : {}),
      ...(isStringRecord(observation?.metadata?.refDigests) ? {
        observationRefDigests: observation.metadata.refDigests,
      } : {}),
      toolNames: this.getExecutedToolNames(),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private logCancelledBeforeFinish(includeFinishFlag: boolean): void {
    this.logger.write('cancelled_before_finish', {
      message_count: this.messages.length,
      ...(includeFinishFlag && { has_finish_payload: this.hasFinishPayload() }),
    });
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(item => typeof item === 'string');
}
