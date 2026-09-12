/**
 * PostgreSQL transaction wrapper.
 *
 * Wraps a pg PoolClient in a BEGIN/COMMIT/ROLLBACK lifecycle.
 * All CRUD operations accept an optional PgTransaction to participate
 * in the same database transaction.
 */

import type { PoolClient, Pool } from 'pg';

/** Thin wrapper around a pg PoolClient with transaction lifecycle. */
export class PgTransaction {
  private _committed = false;
  private _rolledBack = false;
  private _client: PoolClient;

  private constructor(client: PoolClient) {
    this._client = client;
  }

  /** Begin a new transaction and return the wrapper. */
  static async begin(pool: Pool, isolationLevel?: string): Promise<PgTransaction> {
    const client = await pool.connect();
    try {
      const level = isolationLevel ?? 'READ COMMITTED';
      await client.query(`BEGIN ISOLATION LEVEL ${level}`);
      return new PgTransaction(client);
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /** Access the underlying PoolClient for queries within this transaction. */
  get client(): PoolClient {
    this.assertOpen();
    return this._client;
  }

  /** Commit and release the client back to the pool. */
  async commit(): Promise<void> {
    this.assertOpen();
    try {
      await this._client.query('COMMIT');
      this._committed = true;
    } finally {
      this._client.release();
    }
  }

  /** Rollback and release the client back to the pool. */
  async rollback(): Promise<void> {
    this.assertOpen();
    try {
      await this._client.query('ROLLBACK');
      this._rolledBack = true;
    } finally {
      this._client.release();
    }
  }

  get isOpen(): boolean {
    return !this._committed && !this._rolledBack;
  }

  private assertOpen(): void {
    if (this._committed) throw new Error('Transaction already committed');
    if (this._rolledBack) throw new Error('Transaction already rolled back');
  }
}

/**
 * Helper type: something that can execute parameterized queries.
 * Either a Pool (auto-connect) or a PoolClient (within a transaction).
 */
export type Queryable = Pool | PoolClient;

/**
 * Resolve the queryable from an optional PgTransaction.
 * If a transaction is provided, use its client; otherwise use the pool.
 */
export function resolveQueryable(pool: Pool, tx?: PgTransaction): Queryable {
  return tx ? tx.client : pool;
}
