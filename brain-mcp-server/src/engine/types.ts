/**
 * Brain Engine v7.0 — Type Definitions
 *
 * Contracts for the modular engine architecture. Every domain component
 * implements BrainComponent. The engine wires components together via
 * ComponentContext, StorageAdapter, and EventBus.
 *
 * No runtime code — just interfaces and type aliases.
 *
 * @module engine/types
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

/** JSON Schema for a tool's input parameters */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  /**
   * When `false`, the gateway enforces strict-input contract: any arg key not
   * present in `properties` is rejected at dispatch time. Optional for
   * backwards compatibility — schemas without this field remain permissive.
   * (TD-128)
   */
  additionalProperties?: boolean;
}

/** A single MCP tool exposed by a component */
export interface ToolDefinition {
  /** Tool name as registered with the MCP server (e.g. "igris_memory_store") */
  name: string;
  /** Human-readable description shown to the LLM */
  description: string;
  /** JSON Schema for the tool's input */
  inputSchema: ToolInputSchema;
  /** Handler function — receives parsed arguments, returns MCP response */
  handler: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

/** Standard MCP tool response — compatible with SDK's CallToolResult */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: string; text: string }[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Database Migration
// ---------------------------------------------------------------------------

/** A schema migration owned by a component */
export interface Migration {
  /** Monotonically increasing version number (component-scoped) */
  version: number;
  /** Human-readable description */
  description: string;
  /** SQL to execute (may contain multiple statements separated by ;) */
  sql: string;
  /**
   * BR-083 D1a — OPTIONAL pre-flight, run OUTSIDE `db.transaction()`.
   *
   * `runMigrations` executes `sql` inside a transaction. Two things a
   * destructive migration needs cannot happen there, and BOTH fail SILENTLY
   * rather than loudly:
   *
   *  - `VACUUM INTO` (the shipped backup mechanism, `db.ts:1466`) **cannot run
   *    inside a transaction** — SQLite refuses it.
   *  - `PRAGMA foreign_keys = OFF`, required by SQLite's documented 12-step
   *    table rebuild, is a **no-op inside a transaction** and reports no error.
   *    The adapter sets `foreign_keys = ON` at `sqlite.ts:115`.
   *
   * Returning `false` ABORTS this migration: the component stays at the
   * previous version and the next boot retries. That is `db.ts` v22's posture
   * verbatim — *a backup nobody verified is not a backup, it is a hope*.
   * A throw is treated the same way as `false` (logged, migration skipped) so
   * a broken pre-flight can never take the process down mid-boot.
   *
   * `post` runs after the transaction COMMITS, for assertions that need the
   * new schema to exist (`PRAGMA foreign_key_check`) and for restoring any
   * pragma `pre` toggled. It cannot un-apply the migration — it reports.
   *
   * Typed as `unknown` rather than `Database.Database` because `types.ts` is
   * the engine's driver-agnostic contract and must not import better-sqlite3;
   * `sqlite.ts` passes its real handle and the hook narrows it.
   */
  pre?: (db: unknown) => boolean;
  /** BR-083 D1a — optional post-commit verification. See {@link Migration.pre}. */
  post?: (db: unknown) => void;
}

// ---------------------------------------------------------------------------
// Event System
// ---------------------------------------------------------------------------

/** Metadata describing an event a component emits or listens to */
export interface EventDef {
  /** Dot-namespaced event name (e.g. "memory.stored", "component.loaded") */
  name: string;
  /** Human-readable description */
  description: string;
}

/** Payload passed to event handlers */
export interface EventPayload {
  /** Event name */
  event: string;
  /** Arbitrary event data */
  data: Record<string, unknown>;
  /** ISO timestamp of when the event was emitted */
  timestamp: string;
}

/** Handler function for bus events */
export type EventHandler = (payload: EventPayload) => void;

/** Typed event bus interface */
export interface EventBus {
  /** Subscribe to an event. Supports wildcards (e.g. "memory.*") */
  on(event: string, handler: EventHandler): void;
  /** Unsubscribe a handler */
  off(event: string, handler: EventHandler): void;
  /** Emit an event synchronously to all matching handlers */
  emit(event: string, data: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Storage Adapter
// ---------------------------------------------------------------------------

/**
 * StorageAdapter wraps the underlying database connection.
 *
 * Mirrors the better-sqlite3 API surface used by existing tool modules
 * (prepare, exec, transaction, pragma) so that getDb() can be bridged
 * without changing any tool handler code.
 */
export interface StorageAdapter {
  /** The raw better-sqlite3 Database instance for bridge compatibility */
  readonly rawConnection: Database.Database;

  /** Execute raw SQL (no return value) */
  exec(sql: string): void;

  /** Prepare a parameterized statement */
  prepare(sql: string): Database.Statement;

  /** Run a function inside a transaction */
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;

  /** Set a PRAGMA value */
  pragma(directive: string): unknown;

  /** Run component migrations */
  runMigrations(componentName: string, migrations: Migration[]): void;

  /** Close the database connection */
  close(): void;
}

// ---------------------------------------------------------------------------
// Component Context
// ---------------------------------------------------------------------------

/** Context passed to each component during init() */
export interface ComponentContext {
  /** Storage adapter for database operations */
  storage: StorageAdapter;
  /** Event bus for inter-component communication */
  bus: EventBus;
  /** Logger scoped to the component */
  log: ComponentLogger;
  /** Component-specific configuration (from engine config) */
  config: Record<string, unknown>;
}

/** Scoped logger interface */
export interface ComponentLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Brain Component
// ---------------------------------------------------------------------------

/** The contract every domain component must implement */
export interface BrainComponent {
  /** Component name (e.g. "memory", "projects") */
  readonly name: string;
  /** Semantic version (e.g. "1.0.0") */
  readonly version: string;
  /** Names of components this one depends on (resolved by registry) */
  readonly depends: string[];

  /** Return database migrations owned by this component */
  schema(): Migration[];
  /** Return MCP tools provided by this component */
  tools(): ToolDefinition[];
  /** Return events this component emits and listens to */
  events(): { emits: EventDef[]; listens: EventDef[] };

  /** Initialize the component with its context */
  init(ctx: ComponentContext): void;
  /** Clean up resources on shutdown */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Engine Configuration
// ---------------------------------------------------------------------------

/** Per-component configuration */
export interface ComponentConfig {
  /** Whether this component is enabled (default: true) */
  enabled: boolean;
  /** Additional component-specific settings */
  [key: string]: unknown;
}

/** Top-level engine configuration */
export interface EngineConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Per-component configuration keyed by component name */
  components: Record<string, ComponentConfig>;
}
