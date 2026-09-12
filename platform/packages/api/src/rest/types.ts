/**
 * REST API types.
 *
 * Framework-agnostic request/response types for the auto-generated REST layer.
 * Route handlers receive RestRequest and return RestResponse, allowing any
 * HTTP framework (Express, Fastify, Node http) to adapt to these types.
 */

import type { AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

/**
 * Inbound REST request — framework-agnostic.
 */
export interface RestRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  user: AuthenticatedUserInfo;
}

/**
 * Outbound REST response — framework-agnostic.
 */
export interface RestResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A single REST route definition.
 */
export interface RestRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  pattern: string;
  handler: (req: RestRequest, ctx: ResolverContext) => Promise<RestResponse>;
}
