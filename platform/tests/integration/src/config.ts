/**
 * Integration test configuration.
 *
 * Reads from environment variables with sensible defaults matching
 * the deploy/docker-compose.yaml and deploy/.env.example.
 */

export const CONFIG = {
  /** API Gateway base URL (GraphQL + REST + FHIR) */
  apiBaseUrl: process.env['API_BASE_URL'] ?? 'http://localhost:4000',

  /** GraphQL endpoint */
  graphqlUrl: process.env['GRAPHQL_URL'] ?? 'http://localhost:4000/graphql',

  /** REST API base */
  restBaseUrl: process.env['REST_BASE_URL'] ?? 'http://localhost:4000/api/v1',

  /** FHIR base URL */
  fhirBaseUrl: process.env['FHIR_BASE_URL'] ?? 'http://localhost:4000/fhir',

  /** WebSocket URL for GraphQL subscriptions */
  wsUrl: process.env['WS_URL'] ?? 'ws://localhost:4000/graphql',

  /** Sync Engine URL */
  syncUrl: process.env['SYNC_URL'] ?? 'http://localhost:4003',

  /** Debezium Connect URL */
  debeziumUrl: process.env['DEBEZIUM_URL'] ?? 'http://localhost:8083',

  /**
   * PostgreSQL connection.
   * TEST-I1: Credentials are read from env vars only — no hardcoded defaults.
   * For local dev, set POSTGRES_URL or individual PGUSER/PGPASSWORD env vars.
   */
  postgresUrl: process.env['POSTGRES_URL'] ??
    `postgresql://${process.env['PGUSER'] ?? 'openfoundry'}:${process.env['PGPASSWORD'] ?? ''}@${process.env['PGHOST'] ?? 'localhost'}:${process.env['PGPORT'] ?? '5432'}/${process.env['PGDATABASE'] ?? 'openfoundry'}`,

  /** Performance thresholds (MVP Section 8) */
  perf: {
    singleObjectReadMs: 50,
    filteredListMs: 100,
    actionExecutionMs: 300,
  },
} as const;
