// Objects
export {
  ObjectManager,
  type ObjectManagerConfig,
  validateObjectProperties,
  validationError,
  type ValidationFailure,
  type ValidationResult,
} from './objects/index.js';

// Links
export {
  LinkManager,
  type LinkManagerConfig,
  generateUUIDv7,
} from './links/index.js';

// Events
export {
  type EventBus,
  InMemoryEventBus,
  EngineEventEmitter,
  type EventCause,
  type ChangeSet,
  type ObjectEventData,
  type LinkEventData,
} from './events/index.js';

// Computed fields
export {
  ComputedFieldEvaluator,
  type ComputedFieldEvaluatorConfig,
  type ComputeContext,
  type ComputeFunction,
} from './computed/index.js';

// Lineage
export {
  LineageRecorder,
  type LineageRecorderConfig,
  type LineageStore,
  type LineageQueryOptions,
  InMemoryLineageStore,
} from './lineage/index.js';

// Object Sets
export {
  InMemoryObjectSetStore,
  ObjectSetManager,
} from './object-sets/index.js';
