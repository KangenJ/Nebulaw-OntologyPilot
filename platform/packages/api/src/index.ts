export {
  createGraphQLServer,
  buildResolverContext,
  generateResolvers,
  createOpenFoundryError,
  wrapError,
  encodeCursor,
  decodeCursor,
  resolvePagination,
  buildConnection,
  DEFAULT_CONSENT_PURPOSE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './graphql/index.js';

export type {
  GraphQLServerConfig,
  GraphQLServerInstance,
  ApiDependencies,
  ResolverContext,
  AuthenticatedUserInfo,
  PaginationArgs,
  Connection,
  Edge,
  PageInfo,
} from './graphql/index.js';

export {
  SubscriptionManager,
  InMemorySubscribableEventBus,
  createIdFilteredSubscription,
  createFilteredSubscription,
  mapObjectEvent,
  mapLinkEvent,
} from './subscriptions/index.js';
export type {
  ChangeEvent,
  SubscriptionFilter,
  ConnectionAuthResult,
  ConnectionAuthenticator,
  SubscribableEventBus,
  SubscriptionManagerConfig,
} from './subscriptions/index.js';

export {
  SlidingWindowRateLimiter,
  QueryComplexityAnalyzer,
  withTimeout,
  checkResponseSize,
  createTimeoutError,
  createResponseTooLargeError,
  DEFAULT_EXECUTION_GUARD_CONFIG,
} from './governance/index.js';

export type {
  RateLimitConfig,
  RateLimitWindow,
  RateLimitIdentity,
  RateLimitResult,
  ComplexityConfig,
  ComplexityAnalysis,
  ExecutionGuardConfig,
} from './governance/index.js';

export {
  createFhirRouter,
  buildPatientFilter,
  mapPatientToFhir,
  mapEncounterToFhir,
  NHS_NUMBER_SYSTEM,
  NHS_PATIENT_PROFILE,
  NHS_ENCOUNTER_PROFILE,
} from './fhir/index.js';

export type {
  FhirRequest,
  FhirResponse,
  FhirRouterConfig,
  FhirResource,
  FhirPatient,
  FhirEncounter,
  FhirBundle,
  FhirBundleEntry,
  FhirOperationOutcome,
  FhirIdentifier,
  FhirHumanName,
  FhirReference,
  FhirMeta,
} from './fhir/index.js';

export {
  generateRestRoutes,
  mapErrorToHttpStatus,
  createRestErrorResponse,
  wrapErrorToRest,
} from './rest/index.js';

export type {
  RestRequest,
  RestResponse,
  RestRoute,
} from './rest/index.js';
