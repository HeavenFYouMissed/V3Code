/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Reciprocal Rank Fusion across engines — the router's merge, k=60 (mirrors
//! the TS side `src/core/rrf.ts::rrfMerge`). Fusion key = `file:line` so the
//! same location surfaced by trigram AND symbol reinforces. The fused `why`
//! names per-engine ranks — auditability survives fusion.

use crate::Hit;
use std::collections::HashMap;

pub const RRF_K: f32 = 60.0;

/// `lists` = (engine_name, engine_weight, ranked hits). Weight = the engine's
/// `can_answer` for THIS query — a channel that says "0.6, not really my kind
/// of query" contributes proportionally less than one claiming 1.0. Measured
/// fix: unweighted fusion let symbol-channel substring noise dilute conceptual
/// queries (fused MRR 0.48 < trigram-only 0.63 on the V3Index golden set).
pub fn rrf_merge(lists: &[(&str, f32, Vec<Hit>)], k: usize) -> Vec<Hit> {
    struct Acc {
        hit: Hit,
        score: f32,
        sources: Vec<String>,
    }
    let mut by_key: HashMap<String, Acc> = HashMap::new();
    for (engine, weight, hits) in lists {
        for (rank, h) in hits.iter().enumerate() {
            let key = format!("{}:{}", h.file, h.line);
            let contribution = weight / (RRF_K + (rank + 1) as f32);
            let entry = by_key.entry(key).or_insert_with(|| Acc {
                hit: h.clone(),
                score: 0.0,
                sources: Vec::new(),
            });
            entry.score += contribution;
            entry.sources.push(format!("{engine}#{}", rank + 1));
            // keep the more informative why from the better-ranked source
            if h.score > entry.hit.score {
                entry.hit = h.clone();
            }
        }
    }
    let mut fused: Vec<Acc> = by_key.into_values().collect();
    fused.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    fused.truncate(k);
    fused
        .into_iter()
        .map(|mut a| {
            a.hit.why = format!("rrf[{}] {}", a.sources.join("+"), a.hit.why);
            a.hit.score = a.score;
            a.hit
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(file: &str, line: u32) -> Hit {
        Hit {
            file: file.into(),
            line,
            span: (line, line),
            score: 1.0,
            why: "w".into(),
            symbol: None,
        }
    }

    #[test]
    fn agreement_outranks_single_source() {
        let fused = rrf_merge(
            &[
                ("a", 1.0, vec![hit("x.rs", 1), hit("y.rs", 2)]),
                ("b", 1.0, vec![hit("x.rs", 1)]),
            ],
            10,
        );
        assert_eq!(fused[0].file, "x.rs"); // two engines agree -> top
        assert!(fused[0].why.starts_with("rrf[a#1+b#1]"));
    }

    #[test]
    fn low_confidence_engine_cannot_outvote() {
        // engine b (weight 0.3) ranks z first; engine a (weight 1.0) ranks x
        // first — x must win despite b's enthusiasm.
        let fused = rrf_merge(
            &[
                ("a", 1.0, vec![hit("x.rs", 1)]),
                ("b", 0.3, vec![hit("z.rs", 9), hit("x.rs", 1)]),
            ],
            10,
        );
        assert_eq!(fused[0].file, "x.rs");
    }
}
