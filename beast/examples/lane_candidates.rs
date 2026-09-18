/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Emit candidate lists for the five Beast-backed measurement lanes in one
//! process. This avoids reparsing a large tags/graph file once per query and is
//! intentionally an example binary: it adds observability, not product routing.

use beast_index::index;
use beast_index::minindex::{memory::MemoryIndex, resolved::ResolvedIndex, symbol::SymbolIndex};
use beast_index::resolve::Resolver;
use beast_index::tags::StoredTag;
use beast_index::trace::FileGraph;
use beast_index::{search, MiniIndex, Query};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    #[serde(default)]
    literal: bool,
    symbol: Option<String>,
    target: Option<String>,
    depth: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct MemoryFixture {
    text: String,
    files: Vec<String>,
    #[serde(default)]
    symbols: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GoldenQuery {
    id: String,
    lane: String,
    query: String,
    relevant: Vec<String>,
    #[serde(default)]
    probe: Option<Probe>,
    #[serde(default)]
    fixture: Option<MemoryFixture>,
}

#[derive(Debug, Serialize)]
struct Candidate {
    file: String,
    start: u32,
    end: u32,
    why: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryCandidates {
    id: String,
    intended_lane: String,
    query: String,
    relevant: Vec<String>,
    candidates: BTreeMap<String, Vec<Candidate>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    schema: u32,
    goldset: String,
    db: String,
    top_k: usize,
    queries: Vec<QueryCandidates>,
}

struct TempMemory {
    db: PathBuf,
    store: PathBuf,
}

impl TempMemory {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let db = std::env::temp_dir().join(format!(
            "v3-lane-eval-memory-{}-{nanos}",
            std::process::id()
        ));
        let name = db.file_name().unwrap().to_string_lossy();
        let store = db.with_file_name(format!("{name}.memory.jsonl"));
        Self { db, store }
    }
}

impl Drop for TempMemory {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.store);
        let _ = std::fs::remove_file(self.store.with_extension("lock"));
    }
}

fn usage() -> ! {
    eprintln!("usage: cargo run --example lane_candidates -- --goldset FILE --db DIR --output FILE [--topk N]");
    std::process::exit(2);
}

fn parse_args() -> (PathBuf, PathBuf, PathBuf, usize) {
    let mut args = std::env::args().skip(1);
    let mut goldset = None;
    let mut db = None;
    let mut output = None;
    let mut top_k = 10usize;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--goldset" => goldset = args.next().map(PathBuf::from),
            "--db" => db = args.next().map(PathBuf::from),
            "--output" => output = args.next().map(PathBuf::from),
            "--topk" => {
                top_k = args.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage())
            }
            _ => usage(),
        }
    }
    (
        goldset.unwrap_or_else(|| usage()),
        db.unwrap_or_else(|| usage()),
        output.unwrap_or_else(|| usage()),
        top_k,
    )
}

fn read_goldset(path: &Path) -> anyhow::Result<Vec<GoldenQuery>> {
    let raw = std::fs::read_to_string(path)?;
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn read_tags(db: &Path) -> anyhow::Result<Vec<StoredTag>> {
    Ok(serde_json::from_str(&std::fs::read_to_string(db.join("tags.json"))?)?)
}

fn hit_candidate(hit: beast_index::Hit) -> Candidate {
    Candidate {
        file: hit.file,
        start: hit.span.0,
        end: hit.span.1,
        why: hit.why,
    }
}

fn main() -> anyhow::Result<()> {
    let (goldset_path, db, output_path, top_k) = parse_args();
    let gold = read_goldset(&goldset_path)?;
    let bi = index::open(&db)?;
    let tags = read_tags(&db)?;
    let symbol = SymbolIndex::from_tags(tags.clone());
    let resolved = ResolvedIndex::new(Resolver::from_tags(&tags));
    let graph = FileGraph::load(&db).ok_or_else(|| anyhow::anyhow!("graph.json is absent or invalid"))?;

    let temp_memory = TempMemory::new();
    let mut memory = MemoryIndex::load(&temp_memory.db)?;
    for fixture in gold.iter().filter_map(|query| query.fixture.as_ref()) {
        memory.remember(&fixture.text, fixture.files.clone(), fixture.symbols.clone(), 1)?;
    }

    let mut queries = Vec::with_capacity(gold.len());
    for query in gold {
        let mut candidates = BTreeMap::new();

        candidates.insert(
            "trigram".into(),
            search::search(
                &bi,
                &query.query,
                top_k,
                query.probe.as_ref().is_some_and(|probe| probe.literal),
            )?
            .into_iter()
            .map(hit_candidate)
            .collect(),
        );

        let symbol_name = query.probe.as_ref().and_then(|probe| probe.symbol.as_deref());
        candidates.insert(
            "symbol".into(),
            symbol_name
                .map(|name| {
                    symbol
                        .lookup(name, query.probe.as_ref().is_some_and(|probe| probe.literal) || query.lane == "symbol")
                        .into_iter()
                        .take(top_k)
                        .map(|tag| Candidate {
                            file: tag.path.clone(),
                            start: tag.span.0,
                            end: tag.span.1,
                            why: format!("symbol {} {}", if tag.is_definition { "def" } else { "ref" }, tag.name),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        );

        candidates.insert(
            "resolved".into(),
            symbol_name
                .map(|name| {
                    resolved
                        .search(&Query {
                            text: name,
                            k: top_k,
                            literal: false,
                            filepath: None,
                            embedding: None,
                        })
                        .into_iter()
                        .map(hit_candidate)
                        .collect()
                })
                .unwrap_or_default(),
        );

        candidates.insert(
            "graph".into(),
            query
                .probe
                .as_ref()
                .and_then(|probe| probe.target.as_deref().map(|target| (target, probe.depth.unwrap_or(2))))
                .map(|(target, depth)| {
                    let impacts = if target.contains('/') || target.contains('.') {
                        graph.trace_file(target, depth)
                    } else {
                        graph.trace_symbol(target, depth)
                    };
                    impacts
                        .into_iter()
                        .take(top_k)
                        .map(|hit| Candidate {
                            file: hit.file,
                            start: 1,
                            end: u32::MAX,
                            why: hit.why,
                        })
                        .collect()
                })
                .unwrap_or_default(),
        );

        candidates.insert(
            "memory".into(),
            memory
                .recall_text(&query.query, top_k)
                .into_iter()
                .map(hit_candidate)
                .collect(),
        );

        queries.push(QueryCandidates {
            id: query.id,
            intended_lane: query.lane,
            query: query.query,
            relevant: query.relevant,
            candidates,
        });
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = Output {
        schema: 1,
        goldset: goldset_path.to_string_lossy().into_owned(),
        db: db.to_string_lossy().into_owned(),
        top_k,
        queries,
    };
    std::fs::write(output_path, serde_json::to_string_pretty(&payload)? + "\n")?;
    Ok(())
}

