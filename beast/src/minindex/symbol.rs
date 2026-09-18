/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! SymbolIndex — MiniIndex over the persisted tags (db/tags.json). Answers
//! "where is X defined / who calls X" with def/ref-typed, file:line-resolving
//! hits. Substring-matches identifier sub-tokens so "propagate" finds
//! `propagateFromSeeds`; defs outscore refs.

use crate::tags::StoredTag;
use crate::{ChangedFile, Cost, Hit, MiniIndex, Query};
use anyhow::Context;
use std::path::Path;

pub struct SymbolIndex {
    tags: Vec<StoredTag>,
}

impl SymbolIndex {
    pub fn load(db: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(db.join("tags.json"))
            .with_context(|| format!("no tags at {} (re-run `beast index`)", db.display()))?;
        Ok(Self {
            tags: serde_json::from_str(&raw)?,
        })
    }

    pub fn from_tags(tags: Vec<StoredTag>) -> Self {
        Self { tags }
    }

    pub fn lookup(&self, name: &str, defs_only: bool) -> Vec<&StoredTag> {
        let needle = name.to_lowercase();
        let mut out: Vec<&StoredTag> = self
            .tags
            .iter()
            .filter(|t| (!defs_only || t.is_definition) && t.name.to_lowercase().contains(&needle))
            .collect();
        // exact name > prefix > substring; defs before refs
        out.sort_by_key(|t| {
            let ln = t.name.to_lowercase();
            let rank = if ln == needle {
                0
            } else if ln.starts_with(&needle) {
                1
            } else {
                2
            };
            (rank, !t.is_definition, t.path.clone(), t.line)
        });
        out
    }
}

impl MiniIndex for SymbolIndex {
    fn name(&self) -> &str {
        "symbol"
    }

    fn can_answer(&self, q: &Query) -> f32 {
        let tokens: Vec<&str> = q.text.split_whitespace().collect();
        let identish = tokens
            .iter()
            .filter(|t| t.len() >= 3 && t.chars().all(|c| c.is_alphanumeric() || c == '_'))
            .count();
        match tokens.len() {
            1 if identish == 1 => 1.0,
            2 if identish > 0 => 0.6,
            // Measured (V3Index golden set): on 3+-word conceptual queries the
            // symbol channel diluted fusion (0.53 fused < 0.70 trigram-only) —
            // it is a locator, not a concept engine. Low weight, not zero:
            // exact multi-term name matches still reinforce.
            _ if identish > 0 => 0.35,
            _ => 0.1,
        }
    }

    fn search(&self, q: &Query) -> Vec<Hit> {
        let terms: Vec<String> = q
            .text
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| t.len() >= 3)
            .map(|t| t.to_lowercase())
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }
        // A name matching 1 of 4 query terms is noise, not signal — on 3+-term
        // queries require at least 2 matched terms (measured fusion fix).
        let min_matched = if terms.len() >= 3 { 2 } else { 1 };
        let mut scored: Vec<(f32, &StoredTag, Vec<&str>)> = Vec::new();
        for t in &self.tags {
            let name_low = t.name.to_lowercase();
            let matched: Vec<&str> = terms
                .iter()
                .filter(|term| name_low.contains(term.as_str()))
                .map(|s| s.as_str())
                .collect();
            if matched.len() < min_matched {
                continue;
            }
            let mut s = matched.len() as f32;
            if t.is_definition {
                s *= 2.0; // defs are what you usually want (callable-over-value spirit)
            }
            if name_low == terms[0] {
                s *= 1.5;
            }
            scored.push((s, t, matched));
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(q.k)
            .map(|(s, t, matched)| Hit {
                file: t.path.clone(),
                line: t.line,
                span: t.span,
                score: s,
                why: format!(
                    "symbol {}({:?}) {} [{}]",
                    if t.is_definition { "def" } else { "ref" },
                    t.kind,
                    t.name,
                    matched.join("+")
                ),
                symbol: Some(t.name.clone()),
            })
            .collect()
    }

    fn refresh(&mut self, _changed: &[ChangedFile]) -> anyhow::Result<()> {
        anyhow::bail!("symbol refresh = re-run `beast index` (incremental lands with M3b)")
    }

    fn cost(&self) -> Cost {
        Cost {
            est_latency_ms: 5,
            builds_index: true,
        }
    }
}
