/**
 * Consent management module (Section 7.3).
 */

export type {
  ConsentManagerConfig,
  ConsentFilterResult,
  SingleObjectConsentResult,
  ConsentStore,
} from "./types.js";
export { ConsentError } from "./types.js";

export { ConsentService } from "./consent-service.js";
export { MemoryConsentStore } from "./memory-consent-store.js";
