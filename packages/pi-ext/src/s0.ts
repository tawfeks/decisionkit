/**
 * S0 (pre-turn context assembly) and the deterministic tax fast path now live
 * in decisionkit-core (single source for ALL host adapters since 0.1.2 —
 * plan-v3 parity across pi / opencode / kilo / claude / codex). This module is
 * a re-export shim kept for the pi-ext import surface and the s0 eval rig.
 */
export {
  contentFileSearch,
  extractOutline,
  extractTerms,
  finishS0,
  importClosure,
  runS0,
  s0LocalPrep,
  DIGEST_MARKER,
  type Card,
  type S0Deps,
  type S0Edge,
  type S0Outcome,
  type S0Prep,
  type SearchHit,
} from "decisionkit-core";
