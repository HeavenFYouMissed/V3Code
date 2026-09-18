/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! MemoryIndex — the moat, served as just another MiniIndex. Notes are
//! ANCHORED to files/symbols (every memory resolves to file:line like
//! everything else), and recall has two modes:
//!   * text recall — token match over the note text (classic).
//!   * GRAPH PULL — GraphDev's ripple BFS applied to MEMORY: seed a file or
//!    symbol, walk the code graph, surface every note anchored to anything in
//!    the blast radius, scored by confidence / (1 + hop distance). "I'm
//!    touching X — hand me everything we know about X's neighborhood."
//! Confidence rises on re-confirmation (Letta's tiering, applied lean);
//! storage is append-friendly JSONL under the index dir (.beast/memory.jsonl).

use crate::trace::{suffix_match, FileGraph};
use crate::{ChangedFile, Cost, Hit, MiniIndex, Query};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryNote {
    pub id: u64,
    pub text: String,
    /// Anchor files (workspace-relative). First anchor = the note's file:line home.
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub created_unix: u64,
    /// Rises by 0.25 per re-confirmation (capped 3.0) — reinforced memory outranks one-offs.
    pub confidence: f32,
}

pub struct MemoryIndex {
    notes: Vec<MemoryNote>,
    store: PathBuf,
}

impl MemoryIndex {
    /// Notes live BESIDE the index dir (`<db>.memory.jsonl`), not inside it:
    /// `beast index` is rebuild-world (remove_dir_all) and notes are the one
    /// thing not re-derivable from the corpus. A sibling file survives every
    /// rebuild with no snapshot/restore dance (and no write-during-rebuild
    /// race). One-time migration pulls a legacy in-dir store out.
    fn store_path(db: &Path) -> PathBuf {
        let name = db
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "beast".into());
        db.parent()
            .unwrap_or(Path::new("."))
            .join(format!("{name}.memory.jsonl"))
    }

    pub fn load(db: &Path) -> anyhow::Result<Self> {
        let store = Self::store_path(db);
        let legacy = db.join("memory.jsonl");
        if !store.exists() && legacy.exists() {
            // Migrate the pre-sibling store; on rename failure fall back to copy.
            if std::fs::rename(&legacy, &store).is_err() {
                if let Ok(raw) = std::fs::read_to_string(&legacy) {
                    let _ = std::fs::write(&store, raw);
                }
            }
        }
        let notes = match std::fs::read_to_string(&store) {
            Ok(raw) => {
                // One corrupt line (torn write, disk hiccup) must not destroy
                // the user's ENTIRE memory: skip bad lines with a warning.
                let mut ok: Vec<MemoryNote> = Vec::new();
                let mut bad = 0usize;
                for (i, l) in raw.lines().enumerate() {
                    if l.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str(l) {
                        Ok(n) => ok.push(n),
                        Err(_) => {
                            bad += 1;
                            eprintln!("beast: skipping corrupt memory line {}", i + 1);
                        }
                    }
                }
                if bad > 0 {
                    eprintln!("beast: {} corrupt memory line(s) skipped ({} loaded)", bad, ok.len());
                }
                ok
            }
            Err(_) => Vec::new(),
        };
        Ok(Self { notes, store })
    }

    /// Crude cross-process mutex: an exclusive lock file next to the store.
    /// Concurrent remember/forget spawns previously did full-file rewrites and
    /// clobbered each other (measured: 10 parallel remembers -> 7 survivors).
    /// A stale lock (holder crashed) is broken after 10s.
    fn acquire_lock(&self) -> Option<PathBuf> {
        let lock = self.store.with_extension("lock");
        for _ in 0..100 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
                Ok(_) => return Some(lock),
                Err(_) => {
                    if let Ok(meta) = std::fs::metadata(&lock) {
                        if let Ok(age) = meta.modified().and_then(|m| {
                            std::time::SystemTime::now()
                                .duration_since(m)
                                .map_err(|e| std::io::Error::other(e))
                        }) {
                            if age.as_secs() > 10 {
                                let _ = std::fs::remove_file(&lock);
                                continue;
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
        None
    }

    /// Re-read the store from disk — under the lock, so a mutation applies to
    /// the LATEST state, not the state at process start (lost-update fix).
    fn reload(&mut self) {
        if let Ok(fresh) = Self::load_from_store(&self.store) {
            self.notes = fresh;
        }
    }

    fn load_from_store(store: &Path) -> anyhow::Result<Vec<MemoryNote>> {
        match std::fs::read_to_string(store) {
            Ok(raw) => Ok(raw
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()),
            Err(_) => Ok(Vec::new()),
        }
    }

    pub fn remember(
        &mut self,
        text: &str,
        files: Vec<String>,
        symbols: Vec<String>,
        now_unix: u64,
    ) -> anyhow::Result<&MemoryNote> {
        let lock = self.acquire_lock();
        self.reload();
        let result = self.remember_inner(text, files, symbols, now_unix);
        if let Some(l) = lock {
            let _ = std::fs::remove_file(l);
        }
        result
    }

    fn remember_inner(
        &mut self,
        text: &str,
        files: Vec<String>,
        symbols: Vec<String>,
        now_unix: u64,
    ) -> anyhow::Result<&MemoryNote> {
        // Re-confirmation: same text (case-insensitive) bumps confidence
        // instead of duplicating — memory that keeps being true gets stronger.
        if let Some(i) = self
            .notes
            .iter()
            .position(|n| n.text.eq_ignore_ascii_case(text))
        {
            self.notes[i].confidence = (self.notes[i].confidence + 0.25).min(3.0);
            for f in files {
                if !self.notes[i].files.contains(&f) {
                    self.notes[i].files.push(f);
                }
            }
            for s in symbols {
                if !self.notes[i].symbols.contains(&s) {
                    self.notes[i].symbols.push(s);
                }
            }
            self.persist()?;
            return Ok(&self.notes[i]);
        }
        let id = self.notes.iter().map(|n| n.id).max().unwrap_or(0) + 1;
        self.notes.push(MemoryNote {
            id,
            text: text.to_string(),
            files,
            symbols,
            created_unix: now_unix,
            confidence: 1.0,
        });
        self.persist()?;
        Ok(self.notes.last().unwrap())
    }

    /// Delete notes by id or exact text (case-insensitive). Returns how many
    /// were removed. The editor's forget tool calls this so 'forgotten' notes
    /// stop resurfacing through the graph pull.
    pub fn forget(&mut self, id: Option<u64>, text: Option<&str>) -> anyhow::Result<usize> {
        let lock = self.acquire_lock();
        self.reload();
        let before = self.notes.len();
        self.notes.retain(|n| {
            let by_id = id.is_some_and(|i| n.id == i);
            let by_text = text.is_some_and(|t| n.text.eq_ignore_ascii_case(t));
            !(by_id || by_text)
        });
        let removed = before - self.notes.len();
        let result = if removed > 0 { self.persist() } else { Ok(()) };
        if let Some(l) = lock {
            let _ = std::fs::remove_file(l);
        }
        result.map(|_| removed)
    }

    fn persist(&self) -> anyhow::Result<()> {
        let mut out = String::new();
        for n in &self.notes {
            out.push_str(&serde_json::to_string(n)?);
            out.push('\n');
        }
        // Atomic replace: a SIGKILL mid-write (the channel's spawn timeout)
        // must never leave a torn memory.jsonl behind.
        let tmp = self.store.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(&tmp, &self.store)?;
        Ok(())
    }

    fn note_hit(n: &MemoryNote, score: f32, why: String) -> Hit {
        Hit {
            // A memory resolves to its first anchor file — the invariant holds.
            file: n.files.first().cloned().unwrap_or_else(|| "<memory>".into()),
            line: 1,
            span: (1, 1),
            score,
            why,
            symbol: n.symbols.first().cloned(),
        }
    }

    /// Text recall: distinct-token overlap × confidence.
    pub fn recall_text(&self, query: &str, k: usize) -> Vec<Hit> {
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| t.len() >= 3)
            .map(|t| t.to_lowercase())
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(f32, &MemoryNote, usize)> = Vec::new();
        for n in &self.notes {
            let hay = format!(
                "{} {} {}",
                n.text.to_lowercase(),
                n.files.join(" ").to_lowercase(),
                n.symbols.join(" ").to_lowercase()
            );
            let matched = terms.iter().filter(|t| hay.contains(t.as_str())).count();
            if matched > 0 {
                scored.push((matched as f32 * n.confidence, n, matched));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(k)
            .map(|(s, n, m)| {
                Self::note_hit(
                    n,
                    s,
                    format!("memory[{} terms, conf {:.2}] {}", m, n.confidence, n.text),
                )
            })
            .collect()
    }

    /// GRAPH PULL: notes anchored to the seed OR anything in its blast radius,
    /// scored confidence/(1+hop). The GraphDev-on-memory unlock.
    pub fn recall_near(
        &self,
        graph: &FileGraph,
        seed: &str,
        depth: u32,
        k: usize,
    ) -> Vec<Hit> {
        // distance 0 = the seed itself (suffix match), then the ripple.
        let looks_like_file = seed.contains('/') || seed.contains('.');
        let impacted = if looks_like_file {
            graph.trace_file(seed, depth)
        } else {
            graph.trace_symbol(seed, depth)
        };
        // Boundary-checked matching ('b.rs' must not match 'lib.rs').
        let dist_of = |f: &str| -> Option<u32> {
            if suffix_match(f, seed) || suffix_match(seed, f) {
                return Some(0);
            }
            impacted
                .iter()
                .find(|i| i.file == *f || suffix_match(&i.file, f) || suffix_match(f, &i.file))
                .map(|i| i.distance)
        };
        let mut scored: Vec<(f32, &MemoryNote, String, u32)> = Vec::new();
        for n in &self.notes {
            let mut best: Option<(u32, &String)> = None;
            for f in &n.files {
                if let Some(d) = dist_of(f) {
                    if best.map_or(true, |(bd, _)| d < bd) {
                        best = Some((d, f));
                    }
                }
            }
            // symbol anchors: seed symbol match = distance 0
            if best.is_none() && !looks_like_file && n.symbols.iter().any(|s| s == seed) {
                best = n.files.first().map(|f| (0u32, f));
            }
            if let Some((d, f)) = best {
                scored.push((
                    n.confidence / (1.0 + d as f32),
                    n,
                    f.clone(),
                    d,
                ));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(k)
            .map(|(s, n, f, d)| {
                Self::note_hit(
                    n,
                    s,
                    format!(
                        "memory pulled via graph: anchored to {} (hop {} from {}), conf {:.2}: {}",
                        f, d, seed, n.confidence, n.text
                    ),
                )
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }
}

impl MiniIndex for MemoryIndex {
    fn name(&self) -> &str {
        "memory"
    }

    fn can_answer(&self, q: &Query) -> f32 {
        if self.notes.is_empty() {
            return 0.0;
        }
        // Past-work phrasing is memory's home turf.
        let t = q.text.to_lowercase();
        if ["decided", "we chose", "remember", "note", "why did", "last time"]
            .iter()
            .any(|p| t.contains(p))
        {
            0.9
        } else {
            0.35
        }
    }

    fn search(&self, q: &Query) -> Vec<Hit> {
        self.recall_text(q.text, q.k)
    }

    fn refresh(&mut self, _changed: &[ChangedFile]) -> anyhow::Result<()> {
        Ok(()) // notes don't stale with code; decay/confidence govern instead
    }

    fn cost(&self) -> Cost {
        Cost {
            est_latency_ms: 2,
            builds_index: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::{StoredTag, SymbolKind};

    fn tag(path: &str, name: &str, is_def: bool) -> StoredTag {
        StoredTag {
            path: path.into(),
            name: name.into(),
            kind: if is_def { SymbolKind::Function } else { SymbolKind::Call },
            is_definition: is_def,
            line: 1,
            span: (1, 1),
            syntax_type: "function".into(),
            docs: None,
        }
    }

    fn mem(dir: &Path) -> MemoryIndex {
        MemoryIndex::load(dir).unwrap()
    }

    #[test]
    fn remember_recall_confidence() {
        let dir = std::env::temp_dir().join(format!("beast-mem-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::remove_file(dir.join("memory.jsonl")).ok();
        let mut m = mem(&dir);
        m.remember("edge batches capped at 30 rows for the DO variable limit", vec!["src/do/workspaceDO.ts".into()], vec!["writeEdges".into()], 100).unwrap();
        m.remember("edge batches capped at 30 rows for the DO variable limit", vec![], vec![], 200).unwrap(); // re-confirm
        let hits = m.recall_text("edge batches variable limit", 5);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].why.contains("conf 1.25"), "{}", hits[0].why);
        assert_eq!(hits[0].file, "src/do/workspaceDO.ts");
    }

    #[test]
    fn graph_pull_surfaces_neighborhood_memory() {
        let dir = std::env::temp_dir().join(format!("beast-mem2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::remove_file(dir.join("memory.jsonl")).ok();
        // b.rs depends on core.rs; the note anchors to b.rs.
        let tags = vec![
            tag("core.rs", "core_fn", true),
            tag("b.rs", "core_fn", false),
        ];
        let graph = FileGraph::build(&tags);
        let mut m = mem(&dir);
        m.remember("b.rs has a subtle retry loop", vec!["b.rs".into()], vec![], 100).unwrap();
        // seed = core.rs -> ripple hits b.rs (hop 1) -> its memory surfaces
        let hits = m.recall_near(&graph, "core.rs", 2, 5);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].why.contains("hop 1"), "{}", hits[0].why);
        assert!(hits[0].why.contains("retry loop"));
    }
}
