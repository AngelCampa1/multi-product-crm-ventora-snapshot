/**
 * Real-D1 test harness — uses node:sqlite (built-in, Node 22+, no install needed).
 *
 * Builds an in-memory SQLite database by applying every migration file from
 * `migrations/` in lexical order, then returns a thin adapter that implements
 * the D1Database surface used by src/db/*.ts.
 *
 * The adapter is cast once at the boundary with `as unknown as D1Database`.
 * All node:sqlite calls are fully typed against the actual node:sqlite API.
 */

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";

// Resolve migrations directory relative to this file, not relative to cwd.
const thisDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(thisDir, "..", "..", "migrations");

// ---------------------------------------------------------------------------
// D1 surface types — only what src/db/*.ts actually calls
// ---------------------------------------------------------------------------

interface D1RunResult {
  success: true;
  meta: { changes: number; last_row_id: number };
}

interface D1AllResult<T> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number };
}

interface BoundStatement {
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
  all<T>(): Promise<D1AllResult<T>>;
}

interface PreparedStatement {
  bind(...args: unknown[]): BoundStatement;
  // D1 also allows calling first/run/all directly without bind (no params).
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
  all<T>(): Promise<D1AllResult<T>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeRunResult(changes: number, lastInsertRowid: number): D1RunResult {
  return { success: true, meta: { changes, last_row_id: lastInsertRowid } };
}

function makeAllResult<T>(rows: T[], changes = 0, lastInsertRowid = 0): D1AllResult<T> {
  return { results: rows, success: true, meta: { changes, last_row_id: lastInsertRowid } };
}

/**
 * Execute a node:sqlite StatementSync with bound args and return a BoundStatement
 * conforming to the D1 surface (async, D1 result shapes).
 */
function bindToD1(rawStmt: StatementSync, args: SQLInputValue[]): BoundStatement {
  return {
    async first<T>(): Promise<T | null> {
      const row = rawStmt.get(...args) as T | undefined;
      return row ?? null;
    },
    async run(): Promise<D1RunResult> {
      const r = rawStmt.run(...args);
      return makeRunResult(Number(r.changes), Number(r.lastInsertRowid));
    },
    async all<T>(): Promise<D1AllResult<T>> {
      const rows = rawStmt.all(...args) as T[];
      return makeAllResult(rows);
    },
  };
}

function wrapPrepared(rawStmt: StatementSync): PreparedStatement {
  // .bind() with args returns a BoundStatement
  const bound = (args: SQLInputValue[]): BoundStatement => bindToD1(rawStmt, args);

  return {
    bind(...args: unknown[]): BoundStatement {
      return bound(args as SQLInputValue[]);
    },
    // Without .bind() — no args
    async first<T>(): Promise<T | null> {
      const row = rawStmt.get() as T | undefined;
      return row ?? null;
    },
    async run(): Promise<D1RunResult> {
      const r = rawStmt.run();
      return makeRunResult(Number(r.changes), Number(r.lastInsertRowid));
    },
    async all<T>(): Promise<D1AllResult<T>> {
      const rows = rawStmt.all() as T[];
      return makeAllResult(rows);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory SQLite database with all migrations applied.
 * Returns an object cast to D1Database for use in src/db/*.ts modules.
 *
 * Each test file should call `createRealD1()` in a `beforeEach` to get a
 * clean, isolated database for each test.
 */
export function createRealD1(): D1Database {
  const db = new DatabaseSync(":memory:");

  // Enable FK constraints — critical for ON DELETE CASCADE / RESTRICT tests.
  db.exec("PRAGMA foreign_keys = ON;");

  // Apply every migration in lexical (numeric) order.
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexical sort is correct for 0001_, 0002_, … 0010_

  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, filename), "utf-8");
    db.exec(sql);
  }

  // Build the adapter without a structural annotation — the single boundary cast
  // below maps our narrow adapter to the full D1 surface.
  // Only the methods that src/db/*.ts actually calls are implemented above.
  const adapter = {
    prepare(sql: string): PreparedStatement {
      const rawStmt = db.prepare(sql);
      return wrapPrepared(rawStmt);
    },
  };

  // Single well-contained cast: maps our narrow adapter to the full D1 surface.
  return adapter as unknown as D1Database;
}
