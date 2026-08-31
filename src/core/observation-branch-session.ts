import { Message } from '../types';
import { SyntheticObservation, SyntheticObservationQueue } from './synthetic-observation';
import { BranchRunOutcome, BranchSession, BranchSessionOptions } from './branch-session';

export interface ObservationBranchSessionOptions extends BranchSessionOptions {
  queue: SyntheticObservationQueue;
}

export type ObservationDelivery = 'context' | 'audit' | 'discard';

export interface ObservationBranchDisposition {
  /** Legacy flag retained for callers that have not adopted delivery yet. */
  inject: boolean;
  /**
   * Where the completed observation goes:
   * - context: enqueue it for the parent agent;
   * - audit: retain it in the branch audit log only;
   * - discard: do not retain or enqueue it.
   */
  delivery?: ObservationDelivery;
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
        if (this.isBudgetExhausted()) break;
        if (this.finishPayload || !this.shouldContinue()) break;

        this.handleStrayOutput(outcome);
        this.messages.push(this.buildFinishReminderMessage(outcome));
      }

      if (!this.finishPayload) {
        if (this.isBudgetExhausted()) return;
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
      const delivery = disposition.delivery || (disposition.inject ? 'context' : 'discard');
      if (delivery === 'discard') {
        this.logger.write('suppressed_observation', {
          reason: 'delivery_discard',
          delivery,
          ...(disposition.logPayload || {}),
        });
        return;
      }

      const observation = this.buildObservation(this.finishPayload);
      const logPayload = this.buildPublishedObservationLogPayload(this.finishPayload, observation);
      if (delivery === 'audit') {
        this.logger.write('audited_observation', {
          ...logPayload,
          delivery,
        });
        return;
      }

      const pushed = this.observationOptions.queue.push(observation);
      if (pushed) {
        this.logger.write('published_observation', { ...logPayload, delivery });
      } else {
        this.logger.write('discarded_observation', {
          ...logPayload,
          delivery,
          reason: 'queue_closed_or_duplicate',
        });
      }
    } catch (error: any) {
      if (this.isBudgetExhausted()) {
        return;
      }
      if (this.isAbortError(error) || !this.shouldContinue()) {
        this.logCancelledBeforeFinish(true);
      } else {
        this.logFailure(error);
      }
    } finally {
      this.clearBudgetTimer();
    }
  }

  protected complete(payload: TFinishPayload): void {
    this.finishPayload = payload;
    // Once the finish tool has produced a valid payload, the deadline should
    // no longer race the short publication/audit step below. The branch still
    // honours external cancellation through shouldContinue().
    this.clearBudgetTimer();
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
      ...(disposition.delivery ? { delivery: disposition.delivery } : {}),
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
