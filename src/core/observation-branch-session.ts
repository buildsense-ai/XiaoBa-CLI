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

/**
 * BranchSession specialization for side branches that publish synthetic
 * runtime observations back to the parent runner.
 */
export abstract class ObservationBranchSession<TFinishPayload> extends BranchSession {
  private finishPayload: TFinishPayload | null = null;

  protected constructor(protected readonly observationOptions: ObservationBranchSessionOptions) {
    super(observationOptions);
  }

  async run(): Promise<void> {
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
        return;
      }
      if (!this.shouldContinue()) {
        this.logger.write('finished_after_cancel', this.buildFinishedAfterCancelLogPayload(this.finishPayload));
        return;
      }

      const disposition = this.getObservationDisposition(this.finishPayload);
      if (!disposition.inject) {
        this.logger.write('suppressed_observation', {
          reason: 'inject_false',
          ...(disposition.logPayload || {}),
        });
        return;
      }

      const observation = this.buildObservation(this.finishPayload);
      const pushed = this.observationOptions.queue.push(observation);
      const logPayload = this.buildPublishedObservationLogPayload(this.finishPayload, observation);
      if (pushed) {
        this.logger.write('published_observation', logPayload);
      } else {
        this.logger.write('discarded_observation', {
          ...logPayload,
          reason: 'queue_closed_or_duplicate',
        });
      }
    } catch (error: any) {
      if (this.isAbortError(error) || !this.shouldContinue()) {
        this.logCancelledBeforeFinish(true);
      } else {
        this.logFailure(error);
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

  private logCancelledBeforeFinish(includeFinishFlag: boolean): void {
    this.logger.write('cancelled_before_finish', {
      message_count: this.messages.length,
      ...(includeFinishFlag && { has_finish_payload: this.hasFinishPayload() }),
    });
  }
}
