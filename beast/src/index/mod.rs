/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Index build/open. Pipeline per file (order is load-bearing — the quality
//! gate runs BEFORE any indexing so junk never costs work downstream):
//! walk -> quality-gate -> content-hash -> add document. Whole FILES are the
//! tantivy documents (bloop's model); the stage-2 confirm pass maps hits back
//! to exact lines. `meta.json` records corpus root + schema version so `search`
//! can fall back to a raw walk (the unkillable floor) and detect drift.

pub mod ranking;
pub mod schema;

use crate::{id::SourceFileId, lang, quality, tags, walk};
use anyhow::Context;
use std::path::{Path, PathBuf};
use tantivy::{doc, Index, IndexReader};

pub struct BeastIndex {
    pub index: Index,
    pub reader: IndexReader,
    pub fields: schema::Fields,
    pub corpus_root: PathBuf,
}

/// Bump ONLY if the fingerprint derivation itself changes (different inputs or
/// folding order). It is mixed into the hash, so a bump invalidates every stored
/// fingerprint and forces one rebuild — without touching `SCHEMA_VERSION`, which
/// governs the tantivy schema and is a much heavier hammer.
const FINGERPRINT_VERSION: &str = "bfp1";

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    schema_version: String,
    corpus_root: String,
    /// Order-independent blake3 over (rel_path, blake3(content)) for every
    /// post-exclude walked file. Empty = an index built before freshness-skip
    /// existed, which mismatches and forces exactly one rebuild.
    ///
    /// EVERY field added here MUST stay `#[serde(default)]`. `open()` parses
    /// this file with `?`, so a required field makes every pre-existing
    /// `beast-meta.json` on disk unparseable — `beast search` then exits
    /// non-zero and trips the editor's beast kill switch ("Beast off" until
    /// restart) for users who changed nothing.
    #[serde(default)]
    corpus_fingerprint: String,
    /// Diagnostics + a cheap pre-check; `corpus_fingerprint` is the authority.
    #[serde(default)]
    file_count: usize,
    #[serde(default)]
    total_bytes: u64,
    /// The `--exclude` prefixes this index was built with. A different exclude
    /// list means a different intended corpus, so it must force a rebuild even
    /// when no file on disk changed.
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(Debug, Default)]
pub struct BuildStats {
    pub scanned: usize,
    pub indexed: usize,
    pub skipped_quality: usize,
    pub tag_defs: usize,
    pub tag_refs: usize,
    /// True when the corpus fingerprint matched a complete existing index and
    /// the whole build was skipped. `indexed` is 0 in that case by definition —
    /// nothing was written — so callers must not read it as "index is empty".
    pub skipped_unchanged: bool,
}

fn meta_path(db: &Path) -> PathBuf {
    // NOT meta.json — tantivy owns that name inside the index dir.
    db.join("beast-meta.json")
}

/// Read-only view of a built index's corpus identity, for the determinism check
/// (`beast verify`). Returns None when no complete index exists — a partial or
/// interrupted build writes no meta, which is the completion-marker contract.
///
/// Deliberately NOT `pub` on `Meta` itself: the fields stay private so nothing
/// outside this module can construct or mutate an index identity.
pub fn read_identity(db: &Path) -> Option<(String, usize, u64)> {
    let raw = std::fs::read_to_string(meta_path(db)).ok()?;
    let m: Meta = serde_json::from_str(&raw).ok()?;
    Some((m.corpus_fingerprint, m.file_count, m.total_bytes))
}

/// Corpus-relative, forward-slashed path. Shared by the fingerprint pass and the
/// index pass on purpose: if the two normalized paths differently, the stored
/// fingerprint would never match the recomputed one (permanent rebuild) or —
/// worse — match when the indexed set actually differs (silent false skip).
fn rel_path(path: &Path, corpus_abs: &Path) -> String {
    path.strip_prefix(corpus_abs)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Order-independent fingerprint of `(rel_path, content_hash)` pairs.
///
/// `ignore::WalkBuilder` gives no traversal-order guarantee, so the pairs are
/// sorted before folding — without that the same unchanged corpus fingerprints
/// differently run to run and the skip never fires.
fn fold_fingerprint(prints: &mut Vec<(String, String)>) -> String {
    prints.sort_unstable();
    let mut h = blake3::Hasher::new();
    h.update(FINGERPRINT_VERSION.as_bytes());
    for (rel, hash) in prints.iter() {
        h.update(rel.as_bytes());
        h.update(b"\0");
        h.update(hash.as_bytes());
        h.update(b"\n");
    }
    h.finalize().to_hex().to_string()
}

/// Build (or wipe-and-rebuild on schema drift) the index at `db` over `corpus`.
/// `exclude` = corpus-relative path prefixes to skip (e.g. the indexer's own
/// source when evaluating on its host repo — self-reference confound).
pub fn build(corpus: &Path, db: &Path, exclude: &[String]) -> anyhow::Result<BuildStats> {
    // NOTE on memory: notes live in a SIBLING file (<db>.memory.jsonl, see
    // MemoryIndex::store_path) precisely so rebuild-world below cannot touch
    // them. MemoryIndex::load migrates any legacy in-dir store on first read.

    // ---- Freshness gate -------------------------------------------------
    // The walk is hoisted ABOVE every remove_dir_all/create_dir_all below, so a
    // skip leaves the existing index byte-for-byte untouched. walk_repo already
    // holds each file's bytes in RAM, so hashing them here costs no extra I/O —
    // and the same blake3 is reused as the document's content_hash further down.
    //
    // `exclude` is passed INTO the walker: excluded files are filtered before
    // `read_to_string`, so they cost no I/O at all. Everything reaching `files`
    // is therefore already post-exclude, and the redundant prefix tests that
    // used to guard the two loops below are gone with it.
    let corpus_abs = corpus.canonicalize().context("corpus path")?;
    let files = walk::walk_repo_excluding(&corpus_abs, exclude);

    let mut prints: Vec<(String, String)> = Vec::with_capacity(files.len());
    let mut total_bytes: u64 = 0;
    for f in &files {
        // Fingerprint the POST-exclude set: a file that can never reach the
        // index must not be able to force a rebuild. Quality-gated files stay
        // in — including them can only cause an extra (safe) rebuild, while
        // excluding them would mean running compute_metrics before the gate.
        let rel = rel_path(&f.path, &corpus_abs);
        total_bytes += f.content.len() as u64;
        prints.push((rel, blake3::hash(f.content.as_bytes()).to_hex().to_string()));
    }
    let file_count = prints.len();
    let fingerprint = fold_fingerprint(&mut prints);

    if let Ok(raw) = std::fs::read_to_string(meta_path(db)) {
        if let Ok(m) = serde_json::from_str::<Meta>(&raw) {
            // Every clause fails toward rebuild — an unparseable, absent, or
            // partially-written meta can only ever cost work, never correctness.
            let fresh = m.schema_version == schema::SCHEMA_VERSION
                && m.corpus_root == corpus_abs.to_string_lossy()
                && m.exclude == exclude
                && !m.corpus_fingerprint.is_empty() // legacy meta => rebuild once
                && m.corpus_fingerprint == fingerprint
                && m.file_count == file_count
                // beast-meta.json is written last, so it marks a COMPLETE build.
                // These two are the rest of that artifact set: tags.json is hard-
                // required (main.rs load_tags uses `?`, so `beast search` exits
                // non-zero without it — the kill-switch trip), and graph.json
                // merely degrades (trace.rs falls back to rebuilding from tags at
                // ~20s per spawn). Skipping past either would be worse than a
                // rebuild.
                && db.join("tags.json").exists()
                && db.join("graph.json").exists();
            if fresh {
                return Ok(BuildStats {
                    scanned: files.len(),
                    skipped_unchanged: true,
                    ..Default::default()
                });
            }
        }
    }
    // ---- end freshness gate ---------------------------------------------

    // Schema-version gate: drift => clean rebuild (tantivy hard-errors otherwise).
    if let Ok(raw) = std::fs::read_to_string(meta_path(db)) {
        let stale = serde_json::from_str::<Meta>(&raw)
            .map(|m| m.schema_version != schema::SCHEMA_VERSION)
            .unwrap_or(true);
        if stale {
            std::fs::remove_dir_all(db).ok();
        }
    } else if db.exists() {
        std::fs::remove_dir_all(db).ok(); // dir without meta = unknown provenance
    }
    std::fs::create_dir_all(db)?;

    let (schema_def, fields) = schema::build_schema();
    let index = Index::create_in_dir(db, schema_def).or_else(|_| {
        // Existing same-schema dir: wipe for a full rebuild (M2 = rebuild-world;
        // incremental refresh() lands with the MiniIndex impl).
        std::fs::remove_dir_all(db)?;
        std::fs::create_dir_all(db)?;
        Index::create_in_dir(db, schema::build_schema().0)
    })?;
    index
        .tokenizers()
        .register(schema::TRIGRAM_TOKENIZER, schema::trigram_analyzer()?);

    // SINGLE-THREADED ON PURPOSE — this is a determinism gate, not a perf knob.
    //
    // `Index::writer()` is multithreaded (tantivy caps it at 8). Documents land
    // in different segments run to run, BM25 reads per-segment statistics, and
    // the segment ordinal breaks near-ties. The effect is not a different score
    // multiset — the SAME scores get assigned to DIFFERENT documents, so two
    // clean rebuilds of an unchanged corpus can rank near-identical files in a
    // different order. Two users with the same repo get different results for
    // no reason, and every differential test is unclean by construction.
    //
    // Verified: with `writer()`, two clean rebuilds disagreed on tied documents;
    // with one thread they are byte-identical. Measured cost is on the build
    // path only, which is backgrounded and usually skipped outright by the
    // freshness gate above.
    let mut writer = index.writer_with_num_threads(1, 64_000_000)?;
    let mut stats = BuildStats::default();
    let mut all_tags: Vec<tags::StoredTag> = Vec::new();

    for f in files {
        stats.scanned += 1;
        let metrics = quality::compute_metrics(&f.content);
        if !quality::is_valid_file(&metrics) {
            stats.skipped_quality += 1;
            continue;
        }
        // Already post-exclude — the walker dropped those without reading them.
        let rel = rel_path(&f.path, &corpus_abs);
        let sid = SourceFileId::compute(&f.path, f.content.as_bytes());
        let language = lang::language_for_path(&f.path).unwrap_or("");
        // M3: tree-sitter tags (defs+refs) — the shared substrate for symbol
        // search, repomap, and trace_impact. Quality gate already passed.
        if tags::supported_language(language) {
            let file_tags = tags::find_tags(language, &rel, &f.content);
            for t in &file_tags {
                if t.is_definition {
                    stats.tag_defs += 1;
                } else {
                    stats.tag_refs += 1;
                }
            }
            all_tags.extend(file_tags);
        }
        let mtime = std::fs::metadata(&f.path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        writer.add_document(doc!(
            fields.path => rel,
            fields.content => f.content.clone(),
            fields.content_trigram => f.content,
            fields.lang => language,
            fields.content_hash => sid.content_hash,
            fields.avg_line_length => metrics.avg_line_length,
            fields.mtime => mtime,
        ))?;
        stats.indexed += 1;
    }
    writer.commit()?;
    std::fs::write(db.join("tags.json"), serde_json::to_string(&all_tags)?)?;
    // Prebuilt FileGraph: recall/trace load this instead of reparsing the
    // (huge) tags.json per spawn — the difference between ~20s and ~100ms.
    crate::trace::FileGraph::build(&all_tags).save(db)?;

    std::fs::write(
        meta_path(db),
        serde_json::to_string_pretty(&Meta {
            schema_version: schema::SCHEMA_VERSION.into(),
            corpus_root: corpus_abs.to_string_lossy().into_owned(),
            corpus_fingerprint: fingerprint,
            file_count,
            total_bytes,
            exclude: exclude.to_vec(),
        })?,
    )?;
    Ok(stats)
}

pub fn open(db: &Path) -> anyhow::Result<BeastIndex> {
    let raw = std::fs::read_to_string(meta_path(db))
        .with_context(|| format!("no index at {} (run `beast index` first)", db.display()))?;
    let meta: Meta = serde_json::from_str(&raw)?;
    anyhow::ensure!(
        meta.schema_version == schema::SCHEMA_VERSION,
        "index schema v{} != binary v{} — re-run `beast index`",
        meta.schema_version,
        schema::SCHEMA_VERSION
    );
    let index = Index::open_in_dir(db)?;
    index
        .tokenizers()
        .register(schema::TRIGRAM_TOKENIZER, schema::trigram_analyzer()?);
    let reader = index.reader()?;
    let (_, fields) = schema::build_schema();
    Ok(BeastIndex {
        index,
        reader,
        fields,
        corpus_root: PathBuf::from(meta.corpus_root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the (rel, hash) pairs the way `build()` does, so these tests
    /// exercise the real derivation rather than a parallel reimplementation.
    fn prints_of(files: &[(&str, &str)], exclude: &[String]) -> Vec<(String, String)> {
        files
            .iter()
            .filter(|(rel, _)| !exclude.iter().any(|e| rel.starts_with(e.as_str())))
            .map(|(rel, content)| {
                (
                    rel.to_string(),
                    blake3::hash(content.as_bytes()).to_hex().to_string(),
                )
            })
            .collect()
    }

    fn fp(files: &[(&str, &str)], exclude: &[String]) -> String {
        fold_fingerprint(&mut prints_of(files, exclude))
    }

    /// THE upgrade guard. Every `beast-meta.json` already on disk has exactly
    /// two fields. `open()` parses with `?`, so if the new fields were required
    /// this parse would fail, `beast search` would exit non-zero, and the
    /// editor's beast kill switch would show "Beast off" until restart — for
    /// users who changed nothing. It must parse, with an empty fingerprint.
    #[test]
    fn legacy_meta_without_fingerprint_parses() {
        let legacy = r#"{"schema_version":"1","corpus_root":"/tmp/x"}"#;
        let m: Meta = serde_json::from_str(legacy).expect("legacy meta must still parse");
        assert_eq!(m.corpus_root, "/tmp/x");
        assert_eq!(m.corpus_fingerprint, "");
        assert_eq!(m.file_count, 0);
        assert_eq!(m.total_bytes, 0);
        assert!(m.exclude.is_empty());
        // Empty fingerprint must never be treated as fresh — that is what
        // forces exactly one rebuild on upgrade.
        assert!(m.corpus_fingerprint.is_empty());
    }

    /// `ignore::WalkBuilder` gives no ordering guarantee. Without the sort, an
    /// unchanged corpus would fingerprint differently run to run and the skip
    /// would never fire.
    #[test]
    fn fingerprint_is_order_independent() {
        let a = [("src/a.rs", "fn a() {}"), ("src/b.rs", "fn b() {}")];
        let b = [("src/b.rs", "fn b() {}"), ("src/a.rs", "fn a() {}")];
        assert_eq!(fp(&a, &[]), fp(&b, &[]));
    }

    #[test]
    fn fingerprint_changes_on_content_change() {
        let before = [("src/a.rs", "fn a() {}")];
        let after = [("src/a.rs", "fn a() { changed }")];
        assert_ne!(fp(&before, &[]), fp(&after, &[]));
    }

    /// The whole reason for content hashing over mtime: `touch` bumps the
    /// timestamp without changing a byte, and must NOT force a rebuild.
    #[test]
    fn fingerprint_stable_across_mtime_touch() {
        let files = [("src/a.rs", "fn a() {}")];
        // Same bytes, hashed at two different moments — content hashing is
        // clock-independent, so these are equal by construction.
        assert_eq!(fp(&files, &[]), fp(&files, &[]));
    }

    #[test]
    fn fingerprint_changes_on_exclude_change() {
        let files = [("src/a.rs", "fn a() {}"), ("vendor/b.rs", "fn b() {}")];
        let none: Vec<String> = vec![];
        let vendored = vec!["vendor/".to_string()];
        assert_ne!(fp(&files, &none), fp(&files, &vendored));
    }

    /// Pairs are (path, hash), not a hash of hashes — so two files trading
    /// contents changes the fingerprint even though the multiset of hashes,
    /// the file count, and the total bytes are all identical.
    #[test]
    fn fingerprint_distinguishes_swapped_contents() {
        let before = [("src/a.rs", "AAA"), ("src/b.rs", "BBB")];
        let after = [("src/a.rs", "BBB"), ("src/b.rs", "AAA")];
        assert_ne!(fp(&before, &[]), fp(&after, &[]));
    }

    /// A file only inside the excluded region can never reach the index, so
    /// changing it must not force a rebuild.
    #[test]
    fn fingerprint_ignores_changes_inside_excluded_paths() {
        let ex = vec!["vendor/".to_string()];
        let before = [("src/a.rs", "fn a() {}"), ("vendor/b.rs", "old")];
        let after = [("src/a.rs", "fn a() {}"), ("vendor/b.rs", "new")];
        assert_eq!(fp(&before, &ex), fp(&after, &ex));
    }

    /// The version tag is mixed into the hash so the derivation can evolve
    /// without touching SCHEMA_VERSION (which would force a tantivy rebuild).
    #[test]
    fn fingerprint_version_is_mixed_in() {
        let mut prints = prints_of(&[("src/a.rs", "fn a() {}")], &[]);
        let with_version = fold_fingerprint(&mut prints);
        let mut bare = blake3::Hasher::new();
        bare.update(b"src/a.rs");
        bare.update(b"\0");
        bare.update(
            blake3::hash(b"fn a() {}")
                .to_hex()
                .to_string()
                .as_bytes(),
        );
        bare.update(b"\n");
        assert_ne!(with_version, bare.finalize().to_hex().to_string());
    }

    /// Path normalization must be shared between the fingerprint pass and the
    /// index pass; drift there is a silent false skip.
    #[test]
    fn rel_path_is_forward_slashed_and_relative() {
        let root = Path::new("/repo");
        assert_eq!(rel_path(Path::new("/repo/src/a.rs"), root), "src/a.rs");
        // A path outside the corpus falls back to the full path rather than
        // panicking — build() would never see one, but the helper is total.
        assert_eq!(rel_path(Path::new("/other/x.rs"), root), "/other/x.rs");
    }

    /// The writer-determinism gate, end to end.
    ///
    /// A corpus of near-identical files puts documents into a BM25 near-tie,
    /// which is exactly where a multithreaded writer leaks segment assignment
    /// into the final ranking. With `index.writer()` this asserts differently
    /// run to run — not a different score multiset, but the SAME scores landing
    /// on DIFFERENT documents, so top-k membership itself moves. With one
    /// writer thread the scored order is stable.
    ///
    /// This is deliberately an end-to-end build rather than a unit test of the
    /// writer call: the failure only exists once real segments are committed.
    #[test]
    fn two_clean_builds_rank_tied_documents_identically() {
        use std::fs;

        let base = std::env::temp_dir().join(format!(
            "beast-writer-det-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let corpus = base.join("corpus");
        fs::create_dir_all(&corpus).expect("corpus dir");

        // NEAR-identical, not identical: bodies share every query term but
        // differ in one token. Byte-identical files collapse to one content
        // hash and never expose the ordering; distinct-but-tied ones do.
        // 60 rather than a dozen — more tied documents means more chances for
        // segment assignment to reorder them.
        for i in 1..=60 {
            fs::write(
                corpus.join(format!("mod{i}.ts")),
                format!(
                    "export function handleRequest{i}(payload) {{\n  \
                     const parsed = parsePayload(payload);\n  \
                     return dispatch(parsed);\n}}\n"
                ),
            )
            .expect("write corpus file");
        }

        // The assertion has to be the RANKED result, not the doc store. Which
        // documents exist is invariant either way; what moves under a
        // multithreaded writer is which document lands at which rank, and
        // therefore which ones make top-k at all.
        let ranked = |db: &Path| -> Vec<(String, u32)> {
            build(&corpus, db, &[]).expect("build");
            let idx = open(db).expect("open");
            crate::search::search(&idx, "parsePayload dispatch", 10, false)
                .expect("search")
                .into_iter()
                .map(|h| (h.file, h.line))
                .collect()
        };

        // Several rebuilds, not two. A multithreaded writer reorders tied docs
        // only on some runs, so a single pair is a coin flip; N independent
        // builds turn a probabilistic failure into a reliable one. All must
        // agree with the first.
        let first = ranked(&base.join("db-0"));
        assert!(
            !first.is_empty(),
            "search must return hits, else this asserts nothing"
        );

        for n in 1..8 {
            let next = ranked(&base.join(format!("db-{n}")));
            assert_eq!(
                first, next,
                "clean rebuild #{n} of an unchanged corpus ranked tied documents differently"
            );
        }

        let _ = fs::remove_dir_all(&base);
    }

    // -----------------------------------------------------------------------
    // Determinism — the automated form of the check that `beast verify` runs.
    //
    // These exist because of a REAL bug: an `entry.file_type().is_file()`
    // optimization in the parallel walk silently dropped every symlinked file.
    // MRR was unchanged with the file missing, so no retrieval metric could see
    // it — it was caught only by eyeballing a scanned-file count. A corpus that
    // quietly loses files is the failure mode retrieval evals are blind to.
    // -----------------------------------------------------------------------

    fn scratch_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "beast-det-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("scratch dir");
        p
    }

    /// Two independent builds of the SAME corpus must produce the same corpus
    /// fingerprint and the same tag multiset.
    #[test]
    fn two_builds_of_the_same_corpus_are_identical() {
        let corpus = scratch_dir("corpus");
        std::fs::create_dir_all(corpus.join("sub")).unwrap();
        std::fs::write(corpus.join("a.rs"), "pub fn alpha() {}\n").unwrap();
        std::fs::write(corpus.join("sub/b.rs"), "pub fn beta() {}\n").unwrap();

        let a = scratch_dir("a");
        let b = scratch_dir("b");
        // build() is rebuild-world; the dirs must not already hold an index or
        // the freshness skip makes the comparison vacuous.
        std::fs::remove_dir_all(&a).unwrap();
        std::fs::remove_dir_all(&b).unwrap();

        let sa = build(&corpus, &a, &[]).expect("build a");
        let sb = build(&corpus, &b, &[]).expect("build b");
        assert!(!sa.skipped_unchanged && !sb.skipped_unchanged, "both must be real builds");
        assert_eq!(sa.scanned, sb.scanned, "files scanned must match");
        assert_eq!(sa.indexed, sb.indexed, "files indexed must match");

        let ia = read_identity(&a).expect("meta a");
        let ib = read_identity(&b).expect("meta b");
        assert_eq!(ia.0, ib.0, "corpus fingerprint must match");
        assert_eq!(ia.1, ib.1, "file count must match");
        assert_eq!(ia.2, ib.2, "total bytes must match");

        let _ = std::fs::remove_dir_all(&corpus);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    /// A SYMLINKED regular file must be walked. This is the exact regression
    /// that shipped-and-was-caught in the parallel walk: `DirEntry::file_type`
    /// describes the entry, so a symlink types as a symlink and gets dropped,
    /// while `path.is_file()` follows the link and keeps it.
    #[test]
    fn symlinked_file_is_part_of_the_corpus() {
        let corpus = scratch_dir("symlink");
        std::fs::create_dir_all(corpus.join("sub")).unwrap();
        std::fs::write(corpus.join("real.rs"), "pub fn real() {}\n").unwrap();

        let db_without = scratch_dir("nolink");
        std::fs::remove_dir_all(&db_without).unwrap();
        let without = build(&corpus, &db_without, &[]).expect("build without link");

        #[cfg(unix)]
        std::os::unix::fs::symlink("../real.rs", corpus.join("sub/link.rs")).unwrap();
        #[cfg(not(unix))]
        std::fs::write(corpus.join("sub/link.rs"), "pub fn real() {}\n").unwrap();

        let db_with = scratch_dir("withlink");
        std::fs::remove_dir_all(&db_with).unwrap();
        let with = build(&corpus, &db_with, &[]).expect("build with link");

        assert_eq!(
            with.scanned,
            without.scanned + 1,
            "a symlinked regular file must be scanned (file_type() drops it, is_file() keeps it)"
        );

        let _ = std::fs::remove_dir_all(&corpus);
        let _ = std::fs::remove_dir_all(&db_without);
        let _ = std::fs::remove_dir_all(&db_with);
    }

    /// read_identity must report None for an incomplete index rather than
    /// inventing an identity — the completion-marker contract.
    #[test]
    fn read_identity_is_none_without_a_complete_index() {
        let empty = scratch_dir("empty");
        assert!(read_identity(&empty).is_none());
        let _ = std::fs::remove_dir_all(&empty);
    }
}
