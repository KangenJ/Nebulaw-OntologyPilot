/**
 * GraphQL API server.
 *
 * Creates an Apollo Server instance with auto-generated schema and resolvers
 * from the ODL ParsedSchema.
 */

import crypto from 'node:crypto';
import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLSchema } from 'graphql';
import { generateGraphQLSchema } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import type { ApiDependencies, ResolverContext, AuthenticatedUserInfo } from './types.js';
import { generateResolvers } from './resolver-generator.js';
import { QueryComplexityAnalyzer } from '../governance/index.js';
import type { PubSub } from 'graphql-subscriptions';

export interface GraphQLServerConfig {
  schema: ParsedSchema;
  deps: ApiDependencies;
  /** Development mode flag — enables introspection, relaxes governance. */
  isDev?: boolean;
}

export interface GraphQLServerInstance {
  server: ApolloServer<ResolverContext>;
  pubsub: PubSub;
  sdl: string;
  /** Executable GraphQL schema (shared by Apollo and graphql-ws). */
  executableSchema: GraphQLSchema;
}

/**
 * Create the GraphQL server with auto-generated schema and resolvers.
 *
 * Builds a single executable schema shared by both the Apollo HTTP transport
 * and the graphql-ws WebSocket transport. This ensures mutations publish to
 * the same PubSub instance that subscription resolvers listen on.
 */
export function createGraphQLServer(config: GraphQLServerConfig): GraphQLServerInstance {
  // 1. Generate GraphQL SDL from ODL schema. CDM fields are capability-gated:
  // omitted when the deployment's packs do not declare `cdm` (config.deps.
  // cdmEnabled === false), keeping the SDL in lockstep with the resolvers.
  const sdl = generateGraphQLSchema(config.schema, { cdm: config.deps.cdmEnabled });

  // 2. Generate resolvers (creates a single PubSub instance)
  const { resolvers, pubsub } = generateResolvers(config.schema, config.deps);

  // 3. Build a single executable schema used by both transports
  const executableSchema = makeExecutableSchema({
    typeDefs: sdl,
    resolvers,
    // Warn (not error) — deferred bulk-action types lack resolvers (see TODO above).
    resolverValidationOptions: { requireResolversToMatchSchema: 'warn' },
  });

  // 4. Create Apollo Server with the executable schema
  const isDev = config.isDev ?? false;
  const complexityAnalyzer = new QueryComplexityAnalyzer();

  const server = new ApolloServer<ResolverContext>({
    schema: executableSchema,
    introspection: isDev,
    includeStacktraceInErrorResponses: false,
    plugins: [
      // Query complexity gate — rejects queries exceeding depth/breadth/cost limits
      // before execution begins (Section 8.7).
      {
        async requestDidStart() {
          return {
            async didResolveOperation(requestContext: { document: import('graphql').DocumentNode }) {
              const analysis = complexityAnalyzer.analyze(requestContext.document);
              if (!analysis.valid) {
                throw complexityAnalyzer.createComplexityError(analysis);
              }
            },
          };
        },
      },
    ],
  });

  return { server, pubsub, sdl, executableSchema };
}

/**
 * Build a ResolverContext from an authenticated user and dependencies.
 */
export function buildResolverContext(
  user: AuthenticatedUserInfo,
  deps: ApiDependencies,
): ResolverContext {
  return {
    requestContext: {
      tenantId: user.tenantId,
      actorId: user.id,
      traceId: crypto.randomUUID(),
    },
    user,
    deps,
  };
}
