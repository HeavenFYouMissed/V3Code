/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! The router — the actual product. Fans a query out to the engines whose
//! `can_answer` clears the threshold, fuses with RRF(k=60), returns hits whose
//! `why` names every contributing engine. Engines are hot-swappable via the
//! MiniIndex contract; the trigram floor is always registered, so the router
//! never has zero engines.

use crate::rrf;
use crate::{Hit, MiniIndex, Query};

const CAN_ANSWER_THRESHOLD: f32 = 0.3;

pub fn route(engines: &[&dyn MiniIndex], q: &Query) -> Vec<Hit> {
    let mut lists: Vec<(&str, f32, Vec<Hit>)> = Vec::new();
    for e in engines {
        let confidence = e.can_answer(q);
        if confidence >= CAN_ANSWER_THRESHOLD {
            let hits = e.search(q);
            if !hits.is_empty() {
                // confidence-weighted fusion: an engine's RRF vote scales with
                // how strongly it claims the query (measured fix — see rrf.rs).
                lists.push((e.name(), confidence, hits));
            }
        }
    }
    rrf::rrf_merge(&lists, q.k)
}
