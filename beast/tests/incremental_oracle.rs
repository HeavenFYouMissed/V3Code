//! Differential oracle for Beast incremental indexing.
//!
//! The candidate database is reused across randomized edits (the path future
//! per-file incremental code will update). After every operation, a second
//! database is rebuilt from scratch from the exact same files. Search, symbol,
//! resolved, and graph results must be byte-for-byte equal after normalization.
//! Tantivy's recall-stage ordinal in `why` is intentionally normalized: tied
//! documents can receive different internal addresses in two clean builds even
//! when their returned order and final score are identical. The oracle still
//! compares ordered identities, exact score bits, and the stable explanation.

use beast_index::index;
use beast_index::minindex::{resolved::ResolvedIndex, symbol::SymbolIndex};
use beast_index::resolve::Resolver;
use beast_index::tags::StoredTag;
use beast_index::trace::FileGraph;
use beast_index::{search, MiniIndex, Query};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCRIPT_COUNT: usize = 128;
const SEARCH_QUERIES: &[&str] = &[
    "alphaCore",
    "route request",
    "memory checkpoint",
    "cloud sync",
    "vector fusion",
    "retry budget",
    "branchOnly",
];
const SYMBOL_QUERIES: &[&str] = &[
    "alphaCore",
    "routeRequest",
    "memoryCheckpoint",
    "cloudSync",
    "branchOnly",
];
const GRAPH_QUERIES: &[&str] = &["alphaCore", "routeRequest", "memoryCheckpoint"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum OperationKind {
    Edit,
    Delete,
    Rename,
    Truncate,
    BranchSwitch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    trigram: BTreeMap<String, Vec<String>>,
    symbol: BTreeMap<String, Vec<String>>,
    resolved: BTreeMap<String, Vec<String>>,
    graph: BTreeMap<String, Vec<String>>,
}

struct TempTree {
    root: PathBuf,
}

impl TempTree {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "v3-beast-incremental-oracle-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create oracle temp root");
        Self { root }
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_file(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("fixture file parent")).unwrap();
    fs::write(path, content).unwrap();
}

fn branch_a() -> &'static [(&'static str, &'static str)] {
    &[
        (
            "src/core.ts",
            "export function alphaCore(input: string): string {\n  return `vector fusion ${input}`;\n}\n",
        ),
        (
            "src/router.ts",
            "import { alphaCore } from './core';\nexport function routeRequest(query: string): string {\n  return alphaCore(`route request ${query}`);\n}\n",
        ),
        (
            "src/memory.ts",
            "export function memoryCheckpoint(note: string): string {\n  return `memory checkpoint ${note}`;\n}\n",
        ),
        (
            "src/cloud.ts",
            "import { routeRequest } from './router';\nexport function cloudSync(value: string): string {\n  return routeRequest(`cloud sync retry budget ${value}`);\n}\n",
        ),
        (
            "README.md",
            "# Oracle fixture\n\nThe branch A corpus exercises vector fusion and retry budget search.\n",
        ),
    ]
}

fn branch_b() -> &'static [(&'static str, &'static str)] {
    &[
        (
            "src/core.ts",
            "export function alphaCore(input: string): string {\n  return `branchOnly semantic floor ${input}`;\n}\n",
        ),
        (
            "src/router.ts",
            "import { alphaCore } from './core';\nexport function routeRequest(query: string): string {\n  return alphaCore(`branchOnly route request ${query}`);\n}\n",
        ),
        (
            "src/graph.ts",
            "import { routeRequest } from './router';\nexport function branchOnly(seed: string): string {\n  return routeRequest(`graph branch ${seed}`);\n}\n",
        ),
        (
            "src/memory.ts",
            "export function memoryCheckpoint(note: string): string {\n  return `branchOnly memory checkpoint ${note}`;\n}\n",
        ),
        (
            "README.md",
            "# Oracle fixture\n\nThe branch B corpus exercises branch-switch replacement semantics.\n",
        ),
    ]
}

fn install_branch(corpus: &Path, branch: usize) {
    if corpus.exists() {
        fs::remove_dir_all(corpus).expect("replace owned fixture corpus");
    }
    fs::create_dir_all(corpus).unwrap();
    for (path, content) in if branch % 2 == 0 { branch_a() } else { branch_b() } {
        write_file(corpus, path, content);
    }
}

fn corpus_files(corpus: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, out: &mut Vec<PathBuf>) {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() { visit(&path, out); } else { out.push(path); }
        }
    }
    let mut out = Vec::new();
    visit(corpus, &mut out);
    out
}

fn next_u64(state: &mut u64) -> u64 {
    // xorshift64*: deterministic, tiny, and independent of rand crate changes.
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    state.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

fn choose_file(corpus: &Path, state: &mut u64) -> PathBuf {
    let files = corpus_files(corpus);
    files[(next_u64(state) as usize) % files.len()].clone()
}

fn apply_operation(corpus: &Path, kind: OperationKind, state: &mut u64, serial: usize) {
    match kind {
        OperationKind::Edit => {
            let path = choose_file(corpus, state);
            let mut content = fs::read_to_string(&path).unwrap_or_default();
            content.push_str(&format!("\n// oracle edit {serial} retry budget {}\n", next_u64(state)));
            fs::write(path, content).unwrap();
        }
        OperationKind::Delete => {
            let files = corpus_files(corpus);
            if files.len() <= 1 {
                install_branch(corpus, serial % 2);
            } else {
                let path = files[(next_u64(state) as usize) % files.len()].clone();
                fs::remove_file(path).unwrap();
            }
        }
        OperationKind::Rename => {
            let path = choose_file(corpus, state);
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("txt");
            let renamed = path.with_file_name(format!("renamed_{serial}.{ext}"));
            fs::rename(path, renamed).unwrap();
        }
        OperationKind::Truncate => {
            let path = choose_file(corpus, state);
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
            let replacement = if matches!(ext, "ts" | "tsx" | "js" | "jsx") {
                format!("export const truncated_{serial} = 'truncated retry budget';\n")
            } else {
                format!("truncated retry budget {serial}\n")
            };
            fs::write(path, replacement).unwrap();
        }
        OperationKind::BranchSwitch => install_branch(corpus, serial % 2),
    }
}

fn read_tags(db: &Path) -> Vec<StoredTag> {
    serde_json::from_str(&fs::read_to_string(db.join("tags.json")).unwrap()).unwrap()
}

fn hit_key(hit: &beast_index::Hit) -> String {
    let stable_why = if let Some((prefix, rest)) = hit.why.split_once("bm25 #") {
        let suffix = rest.find(" → ").map(|at| &rest[at..]).unwrap_or(rest);
        format!("{prefix}bm25 #<recall-rank>{suffix}")
    } else {
        hit.why.clone()
    };
    format!(
        "{}:{}:{}-{}:{}:{:08x}:{}",
        hit.file,
        hit.line,
        hit.span.0,
        hit.span.1,
        hit.symbol.as_deref().unwrap_or(""),
        hit.score.to_bits(),
        stable_why
    )
}

fn normalized_hit_keys(hits: &[beast_index::Hit]) -> Vec<String> {
    let mut hits: Vec<_> = hits.iter().collect();
    // Equal-score ordering is not an index invariant: Tantivy may assign tied
    // documents different internal addresses in two otherwise equal builds.
    // Canonicalize only those ties while preserving every score boundary.
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| hit_key(a).cmp(&hit_key(b)))
    });
    hits.into_iter().map(hit_key).collect()
}

fn snapshot(db: &Path) -> Snapshot {
    let bi = index::open(db).unwrap();
    let mut trigram = BTreeMap::new();
    for query in SEARCH_QUERIES {
        let hits = search::search(&bi, query, 20, false).unwrap();
        trigram.insert((*query).to_string(), normalized_hit_keys(&hits));
    }

    let tags = read_tags(db);
    let symbol_index = SymbolIndex::from_tags(tags.clone());
    let resolved_index = ResolvedIndex::new(Resolver::from_tags(&tags));
    let graph_index = FileGraph::load(db).expect("graph.json must be complete");

    let mut symbol = BTreeMap::new();
    let mut resolved = BTreeMap::new();
    for query in SYMBOL_QUERIES {
        symbol.insert(
            (*query).to_string(),
            symbol_index
                .lookup(query, false)
                .into_iter()
                .take(20)
                .map(|tag| format!("{}:{}:{}-{}:{}", tag.path, tag.line, tag.span.0, tag.span.1, tag.is_definition))
                .collect(),
        );
        resolved.insert(
            (*query).to_string(),
            normalized_hit_keys(&resolved_index.search(&Query {
                    text: query,
                    k: 20,
                    literal: false,
                    filepath: None,
                    embedding: None,
                })),
        );
    }

    let mut graph = BTreeMap::new();
    for query in GRAPH_QUERIES {
        graph.insert(
            (*query).to_string(),
            graph_index
                .trace_symbol(query, 2)
                .into_iter()
                .map(|hit| format!("{}:{}:{}:{}", hit.file, hit.distance, hit.is_hub, hit.why))
                .collect(),
        );
    }

    Snapshot { trigram, symbol, resolved, graph }
}

fn required_kind(script: usize) -> OperationKind {
    match script % 5 {
        0 => OperationKind::Edit,
        1 => OperationKind::Delete,
        2 => OperationKind::Rename,
        3 => OperationKind::Truncate,
        _ => OperationKind::BranchSwitch,
    }
}

fn random_kind(state: &mut u64) -> OperationKind {
    required_kind(next_u64(state) as usize)
}

#[test]
#[ignore = "explicit release gate: runs 128 randomized edit scripts"]
fn incremental_matches_from_scratch_after_randomized_edits() {
    let temp = TempTree::new();
    let mut coverage: BTreeMap<OperationKind, usize> = BTreeMap::new();

    for script in 0..SCRIPT_COUNT {
        let script_root = temp.root.join(format!("script-{script:03}"));
        let corpus = script_root.join("corpus");
        let candidate_db = script_root.join("candidate-db");
        install_branch(&corpus, script % 2);
        index::build(&corpus, &candidate_db, &[]).unwrap();

        let mut rng = 0x9e37_79b9_7f4a_7c15_u64 ^ (script as u64).wrapping_mul(0x1000_0000_01b3);
        let extra_steps = (next_u64(&mut rng) % 3) as usize;
        let mut operations = vec![required_kind(script)];
        operations.extend((0..extra_steps).map(|_| random_kind(&mut rng)));

        for (step, kind) in operations.into_iter().enumerate() {
            *coverage.entry(kind).or_default() += 1;
            apply_operation(&corpus, kind, &mut rng, script * 10 + step);

            // Candidate path is intentionally reused. Today build() rebuilds on
            // change; future incremental code will update this same database.
            index::build(&corpus, &candidate_db, &[]).unwrap();

            // The oracle always starts empty and sees only current files.
            let fresh_db = script_root.join(format!("fresh-{step}"));
            index::build(&corpus, &fresh_db, &[]).unwrap();

            let incremental = snapshot(&candidate_db);
            let from_scratch = snapshot(&fresh_db);
            assert_eq!(
                incremental, from_scratch,
                "incremental drift after script {script}, step {step}, operation {kind:?}, seed {rng:#x}"
            );
        }
    }

    for kind in [
        OperationKind::Edit,
        OperationKind::Delete,
        OperationKind::Rename,
        OperationKind::Truncate,
        OperationKind::BranchSwitch,
    ] {
        assert!(coverage.get(&kind).copied().unwrap_or(0) >= SCRIPT_COUNT / 5);
    }
}
