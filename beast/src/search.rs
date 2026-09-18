/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Two-stage search — bloop `execute.rs:460-546` (Apache-2.0), adapted:
//!   STAGE 1 (recall):  trigram BM25 over `content_trigram` — deliberately
//!                      over-returns (trigrams of the query terms, OR'd).
//!   STAGE 2 (confirm): scan the STORED content for literal term matches and
//!                      map them to exact lines. A hit is emitted ONLY for a
//!                      line where a query term verifiably appears — the
//!                      re-read guarantee baked into the index itself.
//! Doc score = BM25 * SegmentScorer (lang / line-length / recency). `why` names
//! the matched terms + line — auditability is the contract.

use crate::index::{ranking, BeastIndex};
use crate::Hit;
use anyhow::Result;
use std::collections::HashSet;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, TermQuery};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::{TantivyDocument, Term};

const MAX_GRAMS: usize = 96;
const MAX_LINES_PER_FILE: usize = 3;
const RECALL_FACTOR: usize = 12;

pub fn search(bi: &BeastIndex, query: &str, k: usize, literal: bool) -> Result<Vec<Hit>> {
    // Confirm terms: the query itself when --literal, else its >=2-char tokens.
    let terms: Vec<String> = if literal {
        vec![query.to_lowercase()]
    } else {
        query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| t.len() >= 2)
            .map(|t| t.to_lowercase())
            .collect()
    };
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    // STAGE 1 — trigram recall.
    let mut grams: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for t in &terms {
        let chars: Vec<char> = t.chars().collect();
        if chars.len() < 3 {
            if seen.insert(t.clone()) {
                grams.push(t.clone());
            }
            continue;
        }
        for w in chars.windows(3) {
            let g: String = w.iter().collect();
            if seen.insert(g.clone()) {
                grams.push(g);
                if grams.len() >= MAX_GRAMS {
                    break;
                }
            }
        }
        if grams.len() >= MAX_GRAMS {
            break;
        }
    }
    let subqueries: Vec<(Occur, Box<dyn Query>)> = grams
        .iter()
        .map(|g| {
            (
                Occur::Should,
                Box::new(TermQuery::new(
                    Term::from_field_text(bi.fields.content_trigram, g),
                    IndexRecordOption::WithFreqs,
                )) as Box<dyn Query>,
            )
        })
        .collect();
    let recall_query = BooleanQuery::new(subqueries);
    let searcher = bi.reader.searcher();
    let top = searcher.search(
        &recall_query,
        &TopDocs::with_limit((k * RECALL_FACTOR).clamp(50, 400)),
    )?;

    // STAGE 2 — confirm on stored content, map to exact lines.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hits: Vec<Hit> = Vec::new();
    for (rank, (bm25, addr)) in top.iter().enumerate() {
        let doc: TantivyDocument = searcher.doc(*addr)?;
        let get_str = |f| doc.get_first(f).and_then(|v| v.as_str()).unwrap_or("");
        let path = get_str(bi.fields.path).to_string();
        let content = get_str(bi.fields.content);
        let language = get_str(bi.fields.lang);
        let avg_line = doc
            .get_first(bi.fields.avg_line_length)
            .and_then(|v| v.as_f64())
            .unwrap_or(60.0);
        let mtime = doc
            .get_first(bi.fields.mtime)
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let score = ranking::segment_score(
            *bm25,
            !language.is_empty(),
            avg_line,
            now.saturating_sub(mtime),
        );

        // Best-matching lines: rank by distinct terms on the line.
        let mut best: Vec<(usize, u32, Vec<&str>)> = Vec::new(); // (count, line, terms)
        for (i, line) in content.lines().enumerate() {
            let low = line.to_lowercase();
            let matched: Vec<&str> = terms
                .iter()
                .filter(|t| low.contains(t.as_str()))
                .map(|t| t.as_str())
                .collect();
            if !matched.is_empty() {
                best.push((matched.len(), (i + 1) as u32, matched));
            }
        }
        if best.is_empty() {
            continue; // trigram recall was a false positive — confirm rejected it.
        }
        best.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for (count, line, matched) in best.into_iter().take(MAX_LINES_PER_FILE) {
            hits.push(Hit {
                file: path.clone(),
                line,
                span: (line, line),
                // weight multi-term lines above single-term ones within the doc score
                score: score * count as f32,
                why: format!(
                    "trigram bm25 #{} → confirmed [{}] @L{}",
                    rank + 1,
                    matched.join("+"),
                    line
                ),
                symbol: None,
            });
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(k);
    Ok(hits)
}
