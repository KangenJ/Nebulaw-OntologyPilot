/**
 * CloudEvents 1.0 interface (Section 4.2).
 */

import type { DateTime } from './scalars.js';

/** CloudEvents 1.0 compliant event envelope. */
export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  id: string;
  source: string;
  type: CloudEventType;
  subject?: string;
  time: DateTime;
  datacontenttype?: string;
  data?: T;
}

/** Known Open Foundry event types emitted by the platform. */
export type CloudEventType =
  | 'openfoundry.object.created'
  | 'openfoundry.object.updated'
  | 'openfoundry.object.deleted'
  | 'openfoundry.link.created'
  | 'openfoundry.link.updated'
  | 'openfoundry.link.deleted'
  | 'openfoundry.action.submitted'
  | 'openfoundry.action.completed'
  | 'openfoundry.action.failed'
  | 'openfoundry.schema.updated'
  | (string & {}); // Allow extension event types
