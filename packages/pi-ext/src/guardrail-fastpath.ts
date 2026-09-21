/**
 * Static read-only bash classification (guardrail fast path) now lives in
 * decisionkit-core (single source for all host adapters since 0.1.2).
 * Re-export shim kept for the pi-ext import surface.
 */
export { bashCommandIsReadOnly, bashFirstToken, extractDiscoveryPaths, DISCOVERY_BASH } from "decisionkit-core";
