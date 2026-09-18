/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! TrigramIndex — the first real `MiniIndex`. The unkillable exact-search floor:
//! canAnswer ~1 for identifier/literal-shaped queries, lower (but nonzero) for
//! prose — the router prefers cheaper/smarter engines when they exist, but this
//! one never has zero answers for text that literally appears in the repo.

use crate::index::BeastIndex;
use crate::{search, ChangedFile, Cost, Hit, MiniIndex, Query};

pub struct TrigramIndex {
    bi: BeastIndex,
}

impl TrigramIndex {
    pub fn new(bi: BeastIndex) -> Self {
        Self { bi }
    }
}

impl MiniIndex for TrigramIndex {
    fn name(&self) -> &str {
        "trigram"
    }

    fn can_answer(&self, q: &Query) -> f32 {
        if q.literal {
            return 1.0;
        }
        // identifier-shaped tokens (camelCase / snake_case / len>=4) are our home turf
        let ident = q
            .text
            .split_whitespace()
            .any(|t| t.len() >= 4 && t.chars().all(|c| c.is_alphanumeric() || c == '_'));
        if ident {
            0.9
        } else {
            0.5
        }
    }

    fn search(&self, q: &Query) -> Vec<Hit> {
        search::search(&self.bi, q.text, q.k, q.literal).unwrap_or_default()
    }

    fn refresh(&mut self, changed: &[ChangedFile]) -> anyhow::Result<()> {
        // M2: rebuild-world on refresh (cheap enough at editor scale); the
        // delete_term-by-path incremental path lands with M3.
        let _ = changed;
        anyhow::bail!("incremental refresh lands in M3 — re-run `beast index`")
    }

    fn cost(&self) -> Cost {
        Cost {
            est_latency_ms: 30,
            builds_index: true,
        }
    }
}
