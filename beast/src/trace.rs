/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! trace_impact — "what does changing X break", the tracing tool. GraphDev's
//! ripple analysis (MIT: impact.py:227-252, enrichment hub score :99-125),
//! ported onto OUR resolved edges: an edge A -> B means file A references a
//! definition living in file B (name-bound, same v0 semantics as the
//! stack-graphs root join — swap in per-file partial paths when scope rules
//! land). Impact = reverse-BFS over DEPENDENTS of the seed, depth-capped,
//! HUB-SKIPPING: a file depended on by >15% of the repo (a util everyone
//! imports) is reported when directly hit but never traversed THROUGH —
//! GraphDev's guard against "everything is impacted" false positives.
//! Every impacted file carries a `why` naming the symbol + hop that reached it.

use crate::tags::StoredTag;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

/// Path suffix match with a '/' boundary: seed 'b.rs' must NOT match 'lib.rs'.
/// Accepts equal paths, or a match starting at a path-segment boundary.
pub fn suffix_match(path: &str, seed: &str) -> bool {
    path == seed || path.ends_with(&format!("/{seed}"))
}

pub struct FileGraph {
    /// Sorted path table; all edges are indices into this.
    files: Vec<String>,
    /// Symbol-name table (edge labels, capped at 3 per edge — all `why` shows).
    syms: Vec<String>,
    /// edges[def_idx] = [(ref_file_idx, [sym_idx; <=3])] — who references a
    /// definition living in files[def_idx].
    edges: Vec<Vec<(u32, Vec<u32>)>>,
    /// def name -> file indices defining it (trace_symbol / recall seeds).
    defs_by_name: HashMap<String, Vec<u32>>,
    max_in_degree: usize,
}

/// On-disk form: same index-native tables, so load is ONE serde parse plus a
/// single map build over def names — no per-edge string reconstruction. (A
/// naive string-keyed serde weighed 672MB / 3.6s load on a real workspace;
/// this is what makes spawn-per-recall viable under the editor's timeout.)
#[derive(serde::Serialize, serde::Deserialize)]
struct GraphOnDisk {
    files: Vec<String>,
    syms: Vec<String>,
    edges: Vec<Vec<(u32, Vec<u32>)>>,
    defs_by_name: Vec<(u32, Vec<u32>)>,
    max_in_degree: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Impacted {
    pub file: String,
    pub distance: u32,
    pub why: String,
    pub is_hub: bool,
}

impl FileGraph {
    /// Name-bind refs to defs directly (HashMap join — O(tags), the same
    /// binding the resolver's root join produces, built for whole-graph scale).
    pub fn build(tags: &[StoredTag]) -> Self {
        let mut files: Vec<String> = tags.iter().map(|t| t.path.clone()).collect();
        files.sort();
        files.dedup();
        let file_idx: HashMap<&str, u32> = files
            .iter()
            .enumerate()
            .map(|(i, f)| (f.as_str(), i as u32))
            .collect();
        let mut syms: Vec<String> = Vec::new();
        let mut sym_idx: HashMap<&str, u32> = HashMap::new();
        let mut defs_by_name: HashMap<String, Vec<u32>> = HashMap::new();
        let mut def_idx_by_name: HashMap<&str, Vec<u32>> = HashMap::new();
        for t in tags.iter().filter(|t| t.is_definition) {
            def_idx_by_name
                .entry(t.name.as_str())
                .or_default()
                .push(file_idx[t.path.as_str()]);
        }
        for (name, idxs) in &mut def_idx_by_name {
            idxs.sort();
            idxs.dedup();
            defs_by_name.insert((*name).to_string(), idxs.clone());
        }
        // edge map: (def_idx, ref_idx) -> capped symbol list
        let mut edge_syms: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
        for t in tags.iter().filter(|t| !t.is_definition) {
            let Some(defs) = def_idx_by_name.get(t.name.as_str()) else {
                continue;
            };
            let r = file_idx[t.path.as_str()];
            for d in defs {
                if *d == r {
                    continue; // in-file use is not cross-file impact
                }
                let list = edge_syms.entry((*d, r)).or_default();
                if list.len() >= 3 {
                    continue; // `why` shows at most 3 symbols
                }
                let si = *sym_idx.entry(t.name.as_str()).or_insert_with(|| {
                    syms.push(t.name.clone());
                    (syms.len() - 1) as u32
                });
                if !list.contains(&si) {
                    list.push(si);
                }
            }
        }
        let mut edges: Vec<Vec<(u32, Vec<u32>)>> = vec![Vec::new(); files.len()];
        for ((d, r), ss) in edge_syms {
            edges[d as usize].push((r, ss));
        }
        for row in &mut edges {
            row.sort_by_key(|(r, _)| *r);
        }
        let max_in_degree = edges.iter().map(|d| d.len()).max().unwrap_or(1);
        FileGraph {
            files,
            syms,
            edges,
            defs_by_name,
            max_in_degree,
        }
    }

    /// Persist the graph next to the index so recall/trace never reparse
    /// tags.json (221MB / ~20s on a real workspace — over the editor's spawn
    /// timeout, which made every graph pull fail).
    pub fn save(&self, db: &Path) -> anyhow::Result<()> {
        let mut sym_lookup: HashMap<&str, u32> = HashMap::new();
        for (i, s) in self.syms.iter().enumerate() {
            sym_lookup.insert(s.as_str(), i as u32);
        }
        // defs_by_name keys may not be in syms (defs never referenced) — extend.
        let mut syms = self.syms.clone();
        let mut defs: Vec<(u32, Vec<u32>)> = Vec::with_capacity(self.defs_by_name.len());
        for (name, idxs) in &self.defs_by_name {
            let si = match sym_lookup.get(name.as_str()) {
                Some(i) => *i,
                None => {
                    syms.push(name.clone());
                    (syms.len() - 1) as u32
                }
            };
            defs.push((si, idxs.clone()));
        }
        let disk = GraphOnDisk {
            files: self.files.clone(),
            syms,
            edges: self.edges.clone(),
            defs_by_name: defs,
            max_in_degree: self.max_in_degree,
        };
        let tmp = db.join("graph.json.tmp");
        std::fs::write(&tmp, serde_json::to_string(&disk)?)?;
        std::fs::rename(&tmp, db.join("graph.json"))?;
        Ok(())
    }

    /// Load the prebuilt graph; None when this db predates graph.json (caller
    /// falls back to tags.json + build).
    pub fn load(db: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(db.join("graph.json")).ok()?;
        let disk: GraphOnDisk = serde_json::from_str(&raw).ok()?;
        let mut defs_by_name: HashMap<String, Vec<u32>> = HashMap::with_capacity(disk.defs_by_name.len());
        for (si, idxs) in disk.defs_by_name {
            defs_by_name.insert(disk.syms.get(si as usize)?.clone(), idxs);
        }
        Some(FileGraph {
            files: disk.files,
            syms: disk.syms,
            edges: disk.edges,
            defs_by_name,
            max_in_degree: disk.max_in_degree,
        })
    }

    fn hub_threshold(&self) -> usize {
        // GraphDev: skip nodes with in_degree/max_in_degree > 0.15, floored so
        // tiny repos don't mark everything a hub.
        ((self.max_in_degree as f32 * 0.15) as usize).max(3)
    }

    /// Reverse-BFS from the seed file: who breaks if this file changes.
    pub fn trace_file(&self, seed: &str, max_depth: u32) -> Vec<Impacted> {
        // Boundary-checked, and on basename collisions prefer the shortest
        // path instead of arbitrary iteration order.
        let seed_idx = match self
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| suffix_match(f, seed))
            .min_by_key(|(_, f)| f.len())
            .map(|(i, _)| i as u32)
        {
            Some(i) => i,
            None => return Vec::new(),
        };
        self.trace_from(&[seed_idx], max_depth)
    }

    /// Trace from a SYMBOL: seed = every file defining it, fused + deduped.
    /// Def locations come from the graph itself — no tags needed.
    pub fn trace_symbol(&self, symbol: &str, max_depth: u32) -> Vec<Impacted> {
        let Some(seeds) = self.defs_by_name.get(symbol) else {
            return Vec::new();
        };
        self.trace_from(seeds, max_depth)
    }

    fn trace_from(&self, seeds: &[u32], max_depth: u32) -> Vec<Impacted> {
        let hub_at = self.hub_threshold();
        let mut out: Vec<Impacted> = Vec::new();
        let mut seen = vec![false; self.files.len()];
        let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
        for s in seeds {
            if !seen[*s as usize] {
                seen[*s as usize] = true;
                queue.push_back((*s, 0));
            }
        }
        while let Some((idx, dist)) = queue.pop_front() {
            if dist >= max_depth {
                continue;
            }
            for (dep_idx, sym_idxs) in &self.edges[idx as usize] {
                if seen[*dep_idx as usize] {
                    continue;
                }
                seen[*dep_idx as usize] = true;
                let dep_fanout = self.edges[*dep_idx as usize].len();
                let is_hub = dep_fanout >= hub_at;
                let shown: Vec<&str> = sym_idxs
                    .iter()
                    .filter_map(|si| self.syms.get(*si as usize).map(|s| s.as_str()))
                    .collect();
                out.push(Impacted {
                    file: self.files[*dep_idx as usize].clone(),
                    distance: dist + 1,
                    why: format!(
                        "references [{}] from {} (hop {}{})",
                        shown.join("+"),
                        self.files[idx as usize],
                        dist + 1,
                        if is_hub { ", hub: not traversed through" } else { "" }
                    ),
                    is_hub,
                });
                if !is_hub {
                    queue.push_back((*dep_idx, dist + 1));
                }
            }
        }
        out.sort_by(|a, b| a.distance.cmp(&b.distance).then(a.file.cmp(&b.file)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::SymbolKind;

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

    #[test]
    fn two_hop_ripple() {
        // c.rs defines core; b.rs uses core and defines mid; a.rs uses mid.
        let tags = vec![
            tag("c.rs", "core", true),
            tag("b.rs", "core", false),
            tag("b.rs", "mid", true),
            tag("a.rs", "mid", false),
        ];
        let g = FileGraph::build(&tags);
        let impacted = g.trace_file("c.rs", 2);
        assert_eq!(impacted.len(), 2);
        assert_eq!(impacted[0].file, "b.rs");
        assert_eq!(impacted[0].distance, 1);
        assert_eq!(impacted[1].file, "a.rs");
        assert_eq!(impacted[1].distance, 2);
        assert!(impacted[0].why.contains("core"));
    }

    #[test]
    fn depth_cap_stops_ripple() {
        let tags = vec![
            tag("c.rs", "core", true),
            tag("b.rs", "core", false),
            tag("b.rs", "mid", true),
            tag("a.rs", "mid", false),
        ];
        let g = FileGraph::build(&tags);
        assert_eq!(g.trace_file("c.rs", 1).len(), 1); // only the 1-hop dependent
    }

    #[test]
    fn symbol_seeding() {
        let tags = vec![
            tag("c.rs", "core", true),
            tag("b.rs", "core", false),
        ];
        let g = FileGraph::build(&tags);
        let impacted = g.trace_symbol("core", 2);
        assert_eq!(impacted.len(), 1);
        assert_eq!(impacted[0].file, "b.rs");
    }
}
