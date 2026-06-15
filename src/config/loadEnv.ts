/**
 * Load the .env file into process.env at startup (B3 / README `cp .env.example .env`).
 *
 * This module is imported FIRST in src/index.ts — before ./config/env.js — so
 * that env vars are populated before the typed config snapshot is read (ESM
 * evaluates imported modules in source order, and config/env.js reads
 * process.env at module-eval time).
 *
 * Uses Node 22's native process.loadEnvFile() — no `dotenv` dependency. A
 * missing or unreadable .env is non-fatal: it is wrapped in try/catch so config
 * simply falls back to the real process environment / its built-in defaults.
 */
try {
  process.loadEnvFile()
} catch {
  // No .env present (or unreadable) — fall back to the real environment / defaults.
}
