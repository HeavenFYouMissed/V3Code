/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! M4 — the golden-set eval. Reads `golden.jsonl` ({"query", "relevant":
//! ["path[:start-end]", ...]}), runs each query through the index, and scores
//! MRR / Recall@5 / Recall@10 with the SHARED relevance rule used against the
//! TS index: a hit is relevant iff its file path SUFFIX-matches a golden path
//! AND its line span overlaps the golden span (whole file when no span given).
//! Rank = position of the first relevant hit in unique-file order — MRR math
//! mirrors V3Index scripts/header-experiment.ts.

use crate::Hit;
use anyhow::{Context, Result};
use std::path::Path;

#[derive(serde::Deserialize)]
struct GoldenQuery {
    query: String,
    relevant: Vec<String>,
}

struct Target {
    path_suffix: String,
    start: u32,
    end: u32,
}

fn parse_target(s: &str) -> Target {
    // "path/to/file.ts:10-400" | "path/to/file.ts"
    if let Some((path, range)) = s.rsplit_once(':') {
        if let Some((a, b)) = range.split_once('-') {
            if let (Ok(start), Ok(end)) = (a.parse(), b.parse()) {
                return Target {
                    path_suffix: path.replace('\\', "/"),
                    start,
                    end,
                };
            }
        }
    }
    Target {
        path_suffix: s.replace('\\', "/"),
        start: 1,
        end: u32::MAX,
    }
}

pub struct QueryResult {
    pub query: String,
    pub first_rank: Option<usize>, // 1-based rank of first relevant unique FILE
    pub top_files: Vec<String>,
}

pub struct Report {
    pub per_query: Vec<QueryResult>,
    pub mrr: f64,
    pub recall_at_5: f64,
    pub recall_at_10: f64,
}

/// `search_fn(query, k)` — inject the engine under test (single MiniIndex or
/// the fused router) so the same harness scores every configuration.
pub fn run(
    search_fn: impl Fn(&str, usize) -> Result<Vec<Hit>>,
    golden_path: &Path,
    k: usize,
) -> Result<Report> {
    let raw = std::fs::read_to_string(golden_path)
        .with_context(|| format!("golden set not found: {}", golden_path.display()))?;
    let mut per_query = Vec::new();

    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let gq: GoldenQuery = serde_json::from_str(line).context("bad golden.jsonl line")?;
        let targets: Vec<Target> = gq.relevant.iter().map(|s| parse_target(s)).collect();
        let hits = search_fn(&gq.query, k * 3)?;

        // Dedupe hits to unique files, keeping first (= best) hit's span per file.
        let mut files: Vec<(String, u32, u32)> = Vec::new();
        for h in &hits {
            if !files.iter().any(|(f, _, _)| *f == h.file) {
                files.push((h.file.clone(), h.span.0, h.span.1));
            }
        }
        files.truncate(k);

        let first_rank = files.iter().enumerate().find_map(|(i, (f, s, e))| {
            let hit_matches = targets.iter().any(|t| {
                f.ends_with(&t.path_suffix) && *s <= t.end && *e >= t.start
            });
            hit_matches.then_some(i + 1)
        });

        per_query.push(QueryResult {
            query: gq.query,
            first_rank,
            top_files: files.into_iter().take(5).map(|(f, _, _)| f).collect(),
        });
    }

    let n = per_query.len().max(1) as f64;
    let mrr = per_query
        .iter()
        .map(|q| q.first_rank.map(|r| 1.0 / r as f64).unwrap_or(0.0))
        .sum::<f64>()
        / n;
    let recall_at = |cut: usize| {
        per_query
            .iter()
            .filter(|q| q.first_rank.is_some_and(|r| r <= cut))
            .count() as f64
            / n
    };
    Ok(Report {
        mrr,
        recall_at_5: recall_at(5),
        recall_at_10: recall_at(10),
        per_query,
    })
}

pub fn print_report(r: &Report) {
    println!("beast eval — {} queries", r.per_query.len());
    println!("  MRR       : {:.3}", r.mrr);
    println!("  Recall@5  : {:.3}", r.recall_at_5);
    println!("  Recall@10 : {:.3}", r.recall_at_10);
    println!();
    for q in &r.per_query {
        match q.first_rank {
            Some(rank) => println!("  [rank {rank:>2}] {}", q.query),
            None => println!("  [ miss  ] {}", q.query),
        }
        if q.first_rank.map_or(true, |r| r > 1) {
            for (i, f) in q.top_files.iter().enumerate().take(3) {
                println!("             {}. {}", i + 1, f);
            }
        }
    }
}
