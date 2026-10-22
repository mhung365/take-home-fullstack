import type { StateId } from '../model/types';
import type { RuleFailure } from '../rules/types';

/**
 * runSystemTasks runs the transitions whose roles include this role, whoever calls it;
 * who may call it is actions.runSystemTasks.roles.
 */
export const SYSTEM_ROLE = 'system';

export interface ProcessedSystemTask {
  claimId: string;
  transitionId: string;
  from: StateId;
  to: StateId;
  /** Claim version after the transition. */
  version: number;
}

export type SystemTaskSkipReason =
  /** Another request holds the claim's lock; the next run picks it up. */
  | 'busy'
  /** The claim left the transition's from state between the scan and the lock. */
  | 'state_changed'
  | 'preconditions_not_met'
  | 'cycle_limit_reached'
  /** Something threw; the claim's transaction was rolled back. */
  | 'error';

export interface SkippedSystemTask {
  claimId: string;
  transitionId: string;
  reason: SystemTaskSkipReason;
  message: string;
  /** For preconditions_not_met. */
  failures?: RuleFailure[];
}

export interface SystemTasksResult {
  processed: ProcessedSystemTask[];
  skipped: SkippedSystemTask[];
}
