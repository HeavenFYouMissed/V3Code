/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! ResolvedIndex — the resolution-backed symbol channel. Where the plain
//! SymbolIndex substring-matches names (high recall, noisy — it LOST its
//! default fusion slot on the eval), this channel answers only what the
//! stack-graphs resolver can actually BIND: exact identifier queries resolve
//! to their defs (and top refs), each hit carrying the resolution path as
//! `why`. Precision channel: quiet on conceptual queries, loud and right on
//! identifiers — built to EARN the fusion slot back through the eval gate.

use crate::resolve::Resolver;
use crate::{ChangedFile, Cost, Hit, MiniIndex, Query};

pub struct ResolvedIndex {
    resolver: Resolver,
}

impl ResolvedIndex {
    pub fn new(resolver: Resolver) -> Self {
        Self { resolver }
    }
}

/// Identifier-shaped: one token, alphanumeric/underscore, length >= 3.
fn single_identifier(text: &str) -> Option<&str> {
    let t = text.trim();
    (t.len() >= 3
        && !t.contains(char::is_whitespace)
        && t.chars().all(|c| c.is_alphanumeric() || c == '_'))
    .then_some(t)
}

impl MiniIndex for ResolvedIndex {
    fn name(&self) -> &str {
        "resolved"
    }

    fn can_answer(&self, q: &Query) -> f32 {
        if single_identifier(q.text).is_some() {
            1.0
        } else {
            0.0 // conceptual queries are not resolvable names — stay quiet
        }
    }

    fn search(&self, q: &Query) -> Vec<Hit> {
        let Some(ident) = single_identifier(q.text) else {
            return Vec::new();
        };
        let mut hits: Vec<Hit> = Vec::new();
        for d in self.resolver.resolve(ident) {
            hits.push(Hit {
                file: d.path,
                line: d.line,
                span: d.span,
                score: 2.0, // defs first
                why: d.via,
                symbol: Some(ident.to_string()),
            });
        }
        for r in self.resolver.find_refs(ident).into_iter().take(q.k) {
            hits.push(Hit {
                file: r.path,
                line: r.line,
                span: r.span,
                score: 1.0,
                why: r.via,
                symbol: Some(ident.to_string()),
            });
        }
        hits.truncate(q.k);
        hits
    }

    fn refresh(&mut self, changed: &[ChangedFile]) -> anyhow::Result<()> {
        for c in changed {
            if c.deleted {
                self.resolver.remove_file(&c.path.to_string_lossy());
            }
            // re-adds flow through Resolver::add_file once the caller re-tags.
        }
        Ok(())
    }

    fn cost(&self) -> Cost {
        Cost {
            est_latency_ms: 15,
            builds_index: true,
        }
    }
}
