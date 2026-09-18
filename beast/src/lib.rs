/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! beast-index — Engine C, the hardened Rust core of "the beast".
//!
//! Design invariant (the whole trick): FILES are the only source of truth. Every
//! index below is a disposable, rebuildable ACCELERATOR that resolves to `file:line`.
//! The agent re-reads the file to confirm, so a wrong index costs a re-read, never a
//! wrong answer. That floor is what lets us take risks with the fancy engines on top.
//!
//! This crate is one `MiniIndex` implementation (symbol + trigram) that the router
//! (TS side, `src/core/rrf.ts`) fuses alongside Editor-A and Cloud-B engines. The
//! trait shape here is byte-identical to `src/core/miniIndex.ts` so an engine can
//! move A<->B<->C without router changes.
//!
//! Provenance: seeded from tabby (Apache-2.0), bloop (Apache-2.0), opencode (MIT),
//! sourcegraph/scip (Apache-2.0). Non-permissive research source was not incorporated.

pub mod chunk;
pub mod eval;
pub mod id;
pub mod index;
pub mod lang;
pub mod minindex;
pub mod quality;
pub mod resolve;
pub mod router;
pub mod rrf;
pub mod search;
pub mod tags;
pub mod trace;
pub mod tokenize;
pub mod walk;

use std::path::PathBuf;

/// A retrieval hit. EVERY hit resolves to file:line. `why` is mandatory — it is
/// what makes the system auditable (the agent sees *why* each hit matched).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Hit {
    pub file: String,
    pub line: u32,
    pub span: (u32, u32),
    pub score: f32,
    /// Non-empty by contract (assert at construction). E.g. "trigram bm25 #3".
    pub why: String,
    /// SCIP symbol string when known — the stable cross-index fusion/identity key.
    pub symbol: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Query<'a> {
    pub text: &'a str,
    pub k: usize,
    pub literal: bool,
    pub filepath: Option<&'a str>,
    pub embedding: Option<&'a [f32]>,
}

#[derive(Debug, Clone)]
pub struct ChangedFile {
    pub path: PathBuf,
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Cost {
    pub est_latency_ms: u32,
    pub builds_index: bool,
}

/// The hot-swappable contract. Rust Engine C, TS Editor A, and TS Cloud B all
/// implement this identical shape so the router can fuse + compare them.
pub trait MiniIndex: Send + Sync {
    fn name(&self) -> &str;
    /// 0..1 — "is this my kind of query?" (drives routing).
    fn can_answer(&self, q: &Query) -> f32;
    /// Every returned `Hit.why` must be non-empty.
    fn search(&self, q: &Query) -> Vec<Hit>;
    /// Incremental; cheap; per-engine staleness.
    fn refresh(&mut self, changed: &[ChangedFile]) -> anyhow::Result<()>;
    fn cost(&self) -> Cost;
}
