/**
 * Conflict resolution module (Section 6.6).
 */

export type {
  ConflictStrategy,
  FieldRule,
  ConflictResolverConfig,
  IncomingValue,
  ExistingValue,
  FieldResolution,
  ConflictResolutionResult,
  ConflictEventData,
  ConflictEventHandler,
} from './conflict-resolver.js';

export { ConflictResolver } from './conflict-resolver.js';
