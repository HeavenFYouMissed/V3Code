/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! `beast` CLI. M1: index (walk -> quality -> hash -> tantivy). M2: two-stage
//! trigram search returning file:line Hits with `why`. M4: golden-set eval
//! (MRR / Recall@k). M3 `symbol` lands with tree-sitter tags.

use beast_index::minindex::{resolved::ResolvedIndex, symbol::SymbolIndex, trigram::TrigramIndex};
use beast_index::resolve::Resolver;
use beast_index::tags::StoredTag;
use beast_index::{eval, index, router, trace, MiniIndex, Query};
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};

fn load_tags(db: &Path) -> anyhow::Result<Vec<StoredTag>> {
    let raw = std::fs::read_to_string(db.join("tags.json"))?;
    Ok(serde_json::from_str(&raw)?)
}

#[derive(Parser)]
#[command(
    name = "beast",
    version,
    about = "Engine C — the hardened Rust code index. Files are truth; every hit resolves to file:line."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Build/rebuild the index over a repo (walk + quality-gate + hash + trigram).
    Index {
        path: PathBuf,
        /// Index dir (default: <path>/.beast)
        #[arg(long)]
        db: Option<PathBuf>,
        /// Corpus-relative path prefixes to skip (repeatable).
        #[arg(long)]
        exclude: Vec<String>,
    },
    /// Two-stage trigram search: recall via trigram BM25, confirm on real lines.
    Search {
        query: String,
        #[arg(long, default_value_t = 10)]
        k: usize,
        /// Treat the query as one literal string instead of tokenizing it.
        #[arg(long)]
        literal: bool,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit hits as JSON lines instead of text.
        #[arg(long)]
        json: bool,
        /// Engines: "trigram" (default — best measured MRR) | "symbol" | "all".
        /// Symbol joins the default fusion once it beats trigram-only on the
        /// golden eval (needs M3b resolution) — the no-regression ship gate.
        #[arg(long, default_value = "trigram")]
        engines: String,
    },
    /// Tag def/ref lookup: where is X defined, who references X.
    Symbol {
        name: String,
        /// Only definitions.
        #[arg(long)]
        defs: bool,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit tags as JSON lines instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Cross-file resolution (stack-graphs): where does NAME resolve, who references it.
    Resolve {
        name: String,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit results as JSON lines ({"role":"def"|"ref",...}) instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Save a memory note anchored to files/symbols (re-saving the same text re-confirms it).
    Remember {
        text: String,
        /// Anchor file(s), repeatable.
        #[arg(long)]
        file: Vec<String>,
        /// Anchor symbol(s), repeatable.
        #[arg(long)]
        symbol: Vec<String>,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit the stored note as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Delete a memory note by id or exact text (the editor's forget tool).
    Forget {
        /// Note id to delete.
        #[arg(long)]
        id: Option<u64>,
        /// Exact note text to delete (case-insensitive).
        #[arg(long)]
        text: Option<String>,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit {"deleted": n} as JSON instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Recall memory: by text, or --near FILE|SYMBOL for the graph pull
    /// (everything we know about the seed's blast-radius neighborhood).
    Recall {
        /// Text query (ignored when --near is given).
        #[arg(default_value = "")]
        query: String,
        /// Graph-pull seed: a file suffix or symbol name.
        #[arg(long)]
        near: Option<String>,
        #[arg(long, default_value_t = 2)]
        depth: u32,
        #[arg(long, default_value_t = 8)]
        k: usize,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit hits as JSON lines instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Blast radius: what breaks if FILE-or-SYMBOL changes (hub-skipping ripple BFS).
    Trace {
        /// A file path suffix (contains '/' or '.') or a symbol name.
        target: String,
        #[arg(long, default_value_t = 2)]
        depth: u32,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        /// Emit impacted files as JSON lines instead of text.
        #[arg(long)]
        json: bool,
    },
    /// Determinism check: index the SAME corpus twice into scratch dirs and
    /// assert the two builds are identical. Catches a non-deterministic corpus
    /// walk — the failure mode where the index silently loses or gains files
    /// while retrieval metrics stay flat, so no eval score can see it.
    Verify {
        path: PathBuf,
        /// Corpus-relative path prefixes to skip (repeatable) — must match the
        /// excludes the real index is built with, or the fingerprints differ
        /// for a legitimate reason.
        #[arg(long)]
        exclude: Vec<String>,
        /// Where to put the two throwaway indexes (default: a temp dir).
        #[arg(long)]
        scratch: Option<PathBuf>,
    },
    /// Run the shared golden set: MRR / Recall@5 / Recall@10.
    Eval {
        #[arg(long)]
        golden: PathBuf,
        #[arg(long, default_value = ".beast")]
        db: PathBuf,
        #[arg(long, default_value_t = 10)]
        k: usize,
        /// Which engines to score: "trigram" (default) | "symbol" | "all".
        #[arg(long, default_value = "trigram")]
        engines: String,
    },
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().cmd {
        Cmd::Index { path, db, exclude } => {
            let db = db.unwrap_or_else(|| path.join(".beast"));
            let t0 = std::time::Instant::now();
            let stats = index::build(&path, &db, &exclude)?;
            if stats.skipped_unchanged {
                // Nothing was written; the existing index is byte-for-byte intact.
                println!(
                    "beast index {} → {} (up to date, skipped)",
                    path.display(),
                    db.display()
                );
                println!("  files scanned : {}", stats.scanned);
                println!("  took          : {:.2?}", t0.elapsed());
                return Ok(());
            }
            println!("beast index {} → {}", path.display(), db.display());
            println!("  files scanned : {}", stats.scanned);
            println!("  files indexed : {}", stats.indexed);
            println!(
                "  files skipped : {}  (quality gate: minified/generated/binary)",
                stats.skipped_quality
            );
            println!(
                "  symbols       : {} defs, {} refs",
                stats.tag_defs, stats.tag_refs
            );
            println!("  took          : {:.2?}", t0.elapsed());
            Ok(())
        }
        Cmd::Search {
            query,
            k,
            literal,
            db,
            json,
            engines,
        } => {
            let trigram = TrigramIndex::new(index::open(&db)?);
            let symbol = SymbolIndex::load(&db)?;
            let resolved = ResolvedIndex::new(Resolver::from_tags(&load_tags(&db)?));
            let active: Vec<&dyn MiniIndex> = engines
                .split(',')
                .flat_map(|t| -> Vec<&dyn MiniIndex> {
                    match t.trim() {
                        "trigram" => vec![&trigram],
                        "symbol" => vec![&symbol],
                        "resolved" => vec![&resolved],
                        "all" => vec![&trigram, &symbol, &resolved],
                        _ => vec![],
                    }
                })
                .collect();
            let t0 = std::time::Instant::now();
            let hits = router::route(
                &active,
                &Query {
                    text: &query,
                    k,
                    literal,
                    filepath: None,
                    embedding: None,
                },
            );
            if json {
                for h in &hits {
                    println!("{}", serde_json::to_string(h)?);
                }
            } else {
                for h in &hits {
                    println!("{}:{}  [{:.4}]  {}", h.file, h.line, h.score, h.why);
                }
                eprintln!("({} hits in {:.2?})", hits.len(), t0.elapsed());
            }
            Ok(())
        }
        Cmd::Symbol {
            name,
            defs,
            db,
            json,
        } => {
            let symbols = SymbolIndex::load(&db)?;
            for t in symbols.lookup(&name, defs).into_iter().take(25) {
                if json {
                    println!("{}", serde_json::to_string(&t)?);
                } else {
                    println!(
                        "{}:{}  {} {}({:?})",
                        t.path,
                        t.line,
                        if t.is_definition { "def" } else { "ref" },
                        t.name,
                        t.kind
                    );
                }
            }
            Ok(())
        }
        Cmd::Resolve { name, db, json } => {
            let resolver = Resolver::from_tags(&load_tags(&db)?);
            if json {
                for d in resolver.resolve(&name) {
                    println!(
                        "{}",
                        serde_json::json!({ "role": "def", "file": d.path, "line": d.line, "via": d.via })
                    );
                }
                for r in resolver.find_refs(&name).into_iter().take(25) {
                    println!(
                        "{}",
                        serde_json::json!({ "role": "ref", "file": r.path, "line": r.line, "via": r.via })
                    );
                }
            } else {
                println!("== definitions ==");
                for d in resolver.resolve(&name) {
                    println!("{}:{}  ({})", d.path, d.line, d.via);
                }
                println!("== references ==");
                for r in resolver.find_refs(&name).into_iter().take(25) {
                    println!("{}:{}  ({})", r.path, r.line, r.via);
                }
            }
            Ok(())
        }
        Cmd::Remember {
            text,
            file,
            symbol,
            db,
            json,
        } => {
            let mut m = beast_index::minindex::memory::MemoryIndex::load(&db)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let n = m.remember(&text, file, symbol, now)?;
            if json {
                println!("{}", serde_json::to_string(&n)?);
            } else {
                println!(
                    "remembered #{} (conf {:.2}) anchored to [{}]",
                    n.id,
                    n.confidence,
                    n.files.join(", ")
                );
            }
            Ok(())
        }
        Cmd::Forget { id, text, db, json } => {
            let mut m = beast_index::minindex::memory::MemoryIndex::load(&db)?;
            let deleted = m.forget(id, text.as_deref())?;
            if json {
                println!("{}", serde_json::json!({ "deleted": deleted }));
            } else {
                println!("deleted {deleted} note(s)");
            }
            Ok(())
        }
        Cmd::Recall {
            query,
            near,
            depth,
            k,
            db,
            json,
        } => {
            let m = beast_index::minindex::memory::MemoryIndex::load(&db)?;
            let hits = match near {
                Some(seed) => {
                    // graph.json is the prebuilt FileGraph (written at index
                    // time); parsing tags.json instead is ~20s on a big repo —
                    // over the editor's spawn timeout.
                    let graph = trace::FileGraph::load(&db)
                        .map(Ok::<_, anyhow::Error>)
                        .unwrap_or_else(|| Ok(trace::FileGraph::build(&load_tags(&db)?)))?;
                    m.recall_near(&graph, &seed, depth, k)
                }
                None => m.recall_text(&query, k),
            };
            if json {
                for h in &hits {
                    println!("{}", serde_json::to_string(h)?);
                }
            } else {
                if hits.is_empty() {
                    println!("no memories matched ({} stored)", m.len());
                }
                for h in &hits {
                    println!("{}:{}  [{:.3}]  {}", h.file, h.line, h.score, h.why);
                }
            }
            Ok(())
        }
        Cmd::Trace {
            target,
            depth,
            db,
            json,
        } => {
            let graph = trace::FileGraph::load(&db)
                .map(Ok::<_, anyhow::Error>)
                .unwrap_or_else(|| Ok(trace::FileGraph::build(&load_tags(&db)?)))?;
            let looks_like_file = target.contains('/') || target.contains('.');
            let impacted = if looks_like_file {
                graph.trace_file(&target, depth)
            } else {
                graph.trace_symbol(&target, depth)
            };
            if json {
                for i in &impacted {
                    println!("{}", serde_json::to_string(i)?);
                }
            } else {
                if impacted.is_empty() {
                    println!("no cross-file impact found for '{target}' (depth {depth})");
                }
                for i in &impacted {
                    println!("hop {}  {}  — {}", i.distance, i.file, i.why);
                }
                eprintln!("({} files impacted)", impacted.len());
            }
            Ok(())
        }
        Cmd::Eval {
            golden,
            db,
            k,
            engines,
        } => {
            let trigram = TrigramIndex::new(index::open(&db)?);
            let symbol = SymbolIndex::load(&db)?;
            let resolved = ResolvedIndex::new(Resolver::from_tags(&load_tags(&db)?));
            let report = eval::run(
                |q, kk| {
                    let active: Vec<&dyn MiniIndex> = engines
                        .split(',')
                        .flat_map(|t| -> Vec<&dyn MiniIndex> {
                            match t.trim() {
                                "trigram" => vec![&trigram],
                                "symbol" => vec![&symbol],
                                "resolved" => vec![&resolved],
                                "all" => vec![&trigram, &symbol, &resolved],
                                _ => vec![],
                            }
                        })
                        .collect();
                    Ok(router::route(
                        &active,
                        &Query {
                            text: q,
                            k: kk,
                            literal: false,
                            filepath: None,
                            embedding: None,
                        },
                    ))
                },
                &golden,
                k,
            )?;
            println!("engines: {engines}");
            eval::print_report(&report);
            Ok(())
        }
        Cmd::Verify {
            path,
            exclude,
            scratch,
        } => run_verify(&path, &exclude, scratch.as_deref()),
    }
}

/// Index the same corpus twice and assert the two builds are identical.
///
/// Two independent invariants, and they fail for different reasons:
///   * corpus fingerprint — content-derived over the sorted walk. Differs when
///     the walk discovered a different SET of files (the symlink class of bug).
///   * tag multiset — every (path, name, kind, line) from tree-sitter, sorted.
///     Differs when the same files produced different symbols.
///
/// The tag check is the one that earns its keep: file count can match while the
/// tags underneath differ, and no retrieval metric would show it. Both indexes
/// go to scratch dirs — the real `.beast` is never touched.
fn run_verify(corpus: &Path, exclude: &[String], scratch: Option<&Path>) -> anyhow::Result<()> {
    let base = match scratch {
        Some(p) => p.to_path_buf(),
        None => std::env::temp_dir().join(format!("beast-verify-{}", std::process::id())),
    };
    let a = base.join("a");
    let b = base.join("b");
    // Always start clean: a leftover index from an earlier run would be SKIPPED
    // by the freshness check and the whole verification would silently pass.
    for d in [&a, &b] {
        if d.exists() {
            std::fs::remove_dir_all(d)?;
        }
    }

    println!("beast verify {} — indexing twice", corpus.display());
    let sa = index::build(corpus, &a, exclude)?;
    let sb = index::build(corpus, &b, exclude)?;
    if sa.skipped_unchanged || sb.skipped_unchanged {
        anyhow::bail!("verify needs two real builds; one was skipped (stale scratch dir?)");
    }

    let mut failures: Vec<String> = Vec::new();

    // 1. corpus identity.
    let ia = index::read_identity(&a);
    let ib = index::read_identity(&b);
    match (&ia, &ib) {
        (Some((fa, ca, ba_)), Some((fb, cb, bb_))) => {
            println!("  files scanned : {} / {}", sa.scanned, sb.scanned);
            println!("  files indexed : {} / {}", sa.indexed, sb.indexed);
            if fa != fb {
                failures.push(format!("corpus fingerprint differs:\n    a={fa}\n    b={fb}"));
            }
            if ca != cb || ba_ != bb_ {
                failures.push(format!(
                    "corpus size differs: a={ca} files/{ba_} bytes, b={cb} files/{bb_} bytes"
                ));
            }
            if sa.scanned != sb.scanned {
                failures.push(format!(
                    "files scanned differs: a={} b={}",
                    sa.scanned, sb.scanned
                ));
            }
        }
        _ => failures.push("one build wrote no beast-meta.json (incomplete index)".into()),
    }

    // 2. tag multiset — sorted so walk ORDER is allowed to vary but CONTENT is not.
    let key = |t: &StoredTag| (t.path.clone(), t.name.clone(), t.line, t.is_definition);
    let mut ta: Vec<_> = load_tags(&a)?.iter().map(key).collect();
    let mut tb: Vec<_> = load_tags(&b)?.iter().map(key).collect();
    ta.sort();
    tb.sort();
    println!("  tags          : {} / {}", ta.len(), tb.len());
    if ta != tb {
        if ta.len() != tb.len() {
            failures.push(format!("tag count differs: a={} b={}", ta.len(), tb.len()));
        }
        // Name the first few actual differences — "they differ" is not debuggable.
        let sa_set: std::collections::HashSet<_> = ta.iter().collect();
        let sb_set: std::collections::HashSet<_> = tb.iter().collect();
        let only_a: Vec<_> = ta.iter().filter(|t| !sb_set.contains(t)).take(5).collect();
        let only_b: Vec<_> = tb.iter().filter(|t| !sa_set.contains(t)).take(5).collect();
        if !only_a.is_empty() || !only_b.is_empty() {
            failures.push(format!(
                "tag multiset differs — only in a: {only_a:?}\n    only in b: {only_b:?}"
            ));
        } else if ta.len() == tb.len() {
            failures.push("tag multiset differs in duplicate counts only".into());
        }
    }

    // Scratch dirs are throwaway; leave them on failure so they can be inspected.
    if failures.is_empty() {
        let _ = std::fs::remove_dir_all(&base);
        println!("\n  OK — two independent builds are identical");
        Ok(())
    } else {
        println!("\n  FAILED ({} check(s)):", failures.len());
        for f in &failures {
            println!("    - {f}");
        }
        println!("\n  scratch kept for inspection: {}", base.display());
        anyhow::bail!("index build is not deterministic")
    }
}
