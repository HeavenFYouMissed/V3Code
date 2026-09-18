//! resolve — M3b cross-file RESOLUTION spike, built on the `stack-graphs` crate
//! (MIT OR Apache-2.0; chosen for its licensing, incremental model, Rust API,
//! and file:line-native results).
//!
//! CONTRACT (tags-in, hits-out): this module takes M3a's tags as plain
//! [`SimpleTag`]s inside a [`ResolveInput`] and answers two questions, both
//! resolving to `file:line` with a mandatory `via` explanation (feeds
//! `Hit.why`):
//!
//!   * [`Resolver::resolve`]   — where does this name resolve to? (go-to-def)
//!   * [`Resolver::find_refs`] — who references this def? (find-references)
//!
//! # Binding model v0 — GLOBAL NAME BINDING (honest scope)
//!
//! Real scope rules (imports, nesting, shadowing, `A.B.C` chains) come later.
//! v0 wires the stack graph in the simplest sound shape:
//!
//!   * every DEF in a file  → a pop-symbol node (`is_definition = true`) with
//!     an edge ROOT → def (the def is reachable from the root);
//!   * every REF in a file  → a push-symbol node (`is_reference = true`) with
//!     an edge ref → ROOT (the ref looks things up through the root).
//!
//! Cross-file resolution is therefore a real stack-graphs path
//! `ref —push(name)→ ROOT —→ def —pop(name)` where the pop node acts as a
//! guard: only same-name defs complete the path. Path-finding is done by the
//! real engine — [`ForwardPartialPathStitcher::find_all_complete_partial_paths`]
//! seeded at reference nodes, over [`GraphEdgeCandidates`] for the whole
//! in-memory graph — NOT by a hand-rolled lookup, so per-file partial-path
//! databases (PORT-PACKET §B3/§B4) drop in later without changing callers.
//!
//! ## v0 limitations (documented on purpose)
//!
//!   * NO scope rules: a name defined in two files resolves to BOTH defs.
//!     Ambiguity is honest — callers get every candidate plus a `via` trail,
//!     and the agent's re-read of the file settles it (files are truth).
//!   * `resolve()` falls back to a direct root-join enumeration of same-name
//!     defs when the graph contains no reference with that name (there is no
//!     ref node to seed the stitcher from). The fallback is labelled in `via`.
//!   * Incrementality is per-file at the INPUT level: the resolver retains
//!     each file's `ResolveInput` and rebuilds the `StackGraph` from retained
//!     inputs on `remove_file` / re-`add_file` (the stack-graph arena is
//!     append-only; nodes cannot be deleted in place). Files only meet at the
//!     root, so this is correct; the rebuild is O(total tags), fine for a
//!     spike. The real per-file scheme — serialized per-file graphs plus
//!     `file_paths`/`root_paths` partial-path storage (§B4) — replaces the
//!     rebuild without changing this API.
//!
//! WASM note: we depend on `stack-graphs` with default features only — the
//! `storage` feature (native rusqlite) is deliberately NOT enabled.

/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
use std::collections::{BTreeMap, BTreeSet, HashMap};

use stack_graphs::arena::Handle;
use stack_graphs::graph::{Node, StackGraph};
use stack_graphs::partial::PartialPaths;
use stack_graphs::stitching::{ForwardPartialPathStitcher, GraphEdgeCandidates, StitcherConfig};
use stack_graphs::NoCancellation;

/// A def or ref tag for one name occurrence, as M3a's `tags.rs` produces them
/// (`StoredTag` minus path/kind — path lives on [`ResolveInput`], kind is not
/// needed for v0 name binding).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimpleTag {
    pub name: String,
    /// 1-based line of the occurrence.
    pub line: u32,
    /// Byte span within the file, half-open.
    pub span: (u32, u32),
}

/// Everything the resolver needs to know about one file. Rebuildable per file
/// — feeding the same path again replaces the previous tags for that file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResolveInput {
    pub path: String,
    pub defs: Vec<SimpleTag>,
    pub refs: Vec<SimpleTag>,
}

/// A definition site a name resolved to. `via` is mandatory and human-readable
/// — it feeds `Hit.why` directly.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResolvedDef {
    pub path: String,
    pub line: u32,
    pub span: (u32, u32),
    /// How the resolution happened (the stack-graph path, or the labelled
    /// fallback). Non-empty by contract.
    pub via: String,
}

/// A reference site that resolves to a given def name. `via` is mandatory.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResolvedRef {
    pub path: String,
    pub line: u32,
    pub span: (u32, u32),
    /// Which def(s) this ref's stack-graph path(s) terminate at. Non-empty by
    /// contract.
    pub via: String,
}

/// Where a graph node came from in the source (our side-table; the spike keeps
/// locations here rather than in `SourceInfo` to avoid the `lsp-positions`
/// span plumbing — same data, one hop closer to `Hit{file,line,span}`).
#[derive(Debug, Clone)]
struct Loc {
    path: String,
    line: u32,
    span: (u32, u32),
}

/// Cross-file name resolver. Holds one [`StackGraph`] plus the retained
/// per-file inputs that let any file be removed/replaced (see module docs for
/// the v0 incrementality story).
pub struct Resolver {
    /// Retained inputs, keyed by path — the rebuild source of truth.
    files: BTreeMap<String, ResolveInput>,
    /// The live stack graph over all retained files.
    graph: StackGraph,
    /// node → source location, for every def/ref node we created.
    locs: HashMap<Handle<Node>, Loc>,
}

impl Default for Resolver {
    fn default() -> Self {
        Self::new()
    }
}

impl Resolver {
    /// Build a resolver straight from the persisted tag stream (db/tags.json),
    /// grouping tags per file. The standard construction path for the CLI, the
    /// resolved MiniIndex channel, and trace_impact.
    pub fn from_tags(tags: &[crate::tags::StoredTag]) -> Self {
        let mut by_file: BTreeMap<String, ResolveInput> = BTreeMap::new();
        for t in tags {
            let entry = by_file.entry(t.path.clone()).or_insert_with(|| ResolveInput {
                path: t.path.clone(),
                defs: Vec::new(),
                refs: Vec::new(),
            });
            let st = SimpleTag {
                name: t.name.clone(),
                line: t.line,
                span: t.span,
            };
            if t.is_definition {
                entry.defs.push(st);
            } else {
                entry.refs.push(st);
            }
        }
        let mut r = Resolver::new();
        for input in by_file.values() {
            r.add_file(input);
        }
        r
    }

    pub fn new() -> Self {
        Resolver {
            files: BTreeMap::new(),
            graph: StackGraph::new(),
            locs: HashMap::new(),
        }
    }

    /// Add (or replace) one file's tags. Adding a NEW file appends to the live
    /// graph; REPLACING an existing file rebuilds the graph from retained
    /// inputs (arena nodes cannot be deleted — see module docs).
    pub fn add_file(&mut self, input: &ResolveInput) {
        let replaced = self
            .files
            .insert(input.path.clone(), input.clone())
            .is_some();
        if replaced {
            self.rebuild();
        } else {
            Self::append_file(&mut self.graph, &mut self.locs, input);
        }
    }

    /// Drop one file and rebuild the graph from the remaining inputs. No-op if
    /// the path was never added.
    pub fn remove_file(&mut self, path: &str) {
        if self.files.remove(path).is_some() {
            self.rebuild();
        }
    }

    /// Where does `name` resolve to? Seeds the stitcher at every reference
    /// node carrying `name` and collects the definition each complete
    /// stack-graph path terminates at. Ambiguity is returned, not guessed
    /// away. If no ref with that name exists in the graph, falls back to the
    /// root-join def enumeration (labelled in `via`).
    pub fn resolve(&self, name: &str) -> Vec<ResolvedDef> {
        let seeds = self.nodes_named(name, /* want_ref */ true);

        if seeds.is_empty() {
            // No reference node to seed a path from. Root-join fallback:
            // every v0 def is root-connected by construction, so enumerate
            // same-name defs directly. Honest label in `via`.
            let mut out: Vec<ResolvedDef> = self
                .nodes_named(name, /* want_ref */ false)
                .into_iter()
                .filter_map(|n| self.locs.get(&n))
                .map(|loc| ResolvedDef {
                    path: loc.path.clone(),
                    line: loc.line,
                    span: loc.span,
                    via: format!(
                        "def '{}' at {}:{} reachable from root (root-join lookup; \
                         no in-graph ref to seed a stack-graph path)",
                        name, loc.path, loc.line
                    ),
                })
                .collect();
            out.sort_by(|a, b| (&a.path, a.line, a.span).cmp(&(&b.path, b.line, b.span)));
            return out;
        }

        // (ref loc, def loc, path edge count) per complete stack-graph path.
        let raw = self.complete_paths_from(seeds);

        let mut seen: BTreeSet<(String, u32, (u32, u32))> = BTreeSet::new();
        let mut out: Vec<ResolvedDef> = Vec::new();
        for (ref_loc, def_loc, edges) in raw {
            if seen.insert((def_loc.path.clone(), def_loc.line, def_loc.span)) {
                out.push(ResolvedDef {
                    path: def_loc.path.clone(),
                    line: def_loc.line,
                    span: def_loc.span,
                    via: format!(
                        "stack-graph path ({} edges): ref '{}' {}:{} \u{2192} root \u{2192} def {}:{}",
                        edges, name, ref_loc.path, ref_loc.line, def_loc.path, def_loc.line
                    ),
                });
            }
        }
        out.sort_by(|a, b| (&a.path, a.line, a.span).cmp(&(&b.path, b.line, b.span)));
        out
    }

    /// Who references `def_name`? Seeds the stitcher at every same-name
    /// reference node; a ref is returned iff at least one complete path from
    /// it terminates at a definition of `def_name`. One entry per ref site;
    /// all defs it reaches are folded into `via`.
    pub fn find_refs(&self, def_name: &str) -> Vec<ResolvedRef> {
        let seeds = self.nodes_named(def_name, /* want_ref */ true);
        if seeds.is_empty() {
            return Vec::new();
        }

        let raw = self.complete_paths_from(seeds);

        // ref site → sorted set of "path:line" def targets.
        let mut by_ref: BTreeMap<(String, u32, (u32, u32)), BTreeSet<String>> = BTreeMap::new();
        for (ref_loc, def_loc, _edges) in raw {
            by_ref
                .entry((ref_loc.path.clone(), ref_loc.line, ref_loc.span))
                .or_default()
                .insert(format!("{}:{}", def_loc.path, def_loc.line));
        }

        by_ref
            .into_iter()
            .map(|((path, line, span), defs)| {
                let targets: Vec<String> = defs.into_iter().collect();
                ResolvedRef {
                    via: format!(
                        "ref '{}' at {}:{} resolves via root to {} def(s): {}",
                        def_name,
                        path,
                        line,
                        targets.len(),
                        targets.join(", ")
                    ),
                    path,
                    line,
                    span,
                }
            })
            .collect()
    }

    // ---------------------------------------------------------------- internal

    /// Rebuild the whole graph from retained inputs (used on replace/remove).
    fn rebuild(&mut self) {
        self.graph = StackGraph::new();
        self.locs.clear();
        for input in self.files.values() {
            Self::append_file(&mut self.graph, &mut self.locs, input);
        }
    }

    /// Append one file's subgraph: defs as root-connected pop-symbol nodes,
    /// refs as push-symbol nodes with an edge to root (binding model v0).
    fn append_file(
        graph: &mut StackGraph,
        locs: &mut HashMap<Handle<Node>, Loc>,
        input: &ResolveInput,
    ) {
        let file = graph.get_or_create_file(&input.path);
        let root = StackGraph::root_node();
        for def in &input.defs {
            let symbol = graph.add_symbol(&def.name);
            let id = graph.new_node_id(file);
            let node = graph
                .add_pop_symbol_node(id, symbol, /* is_definition */ true)
                .expect("fresh node id cannot collide");
            graph.add_edge(root, node, 0);
            locs.insert(
                node,
                Loc {
                    path: input.path.clone(),
                    line: def.line,
                    span: def.span,
                },
            );
        }
        for r in &input.refs {
            let symbol = graph.add_symbol(&r.name);
            let id = graph.new_node_id(file);
            let node = graph
                .add_push_symbol_node(id, symbol, /* is_reference */ true)
                .expect("fresh node id cannot collide");
            graph.add_edge(node, root, 0);
            locs.insert(
                node,
                Loc {
                    path: input.path.clone(),
                    line: r.line,
                    span: r.span,
                },
            );
        }
    }

    /// All of our def or ref nodes carrying `name`, in deterministic order.
    fn nodes_named(&self, name: &str, want_ref: bool) -> Vec<Handle<Node>> {
        let mut nodes: Vec<Handle<Node>> = self
            .locs
            .keys()
            .copied()
            .filter(|&n| {
                let node = &self.graph[n];
                let kind_ok = if want_ref {
                    node.is_reference()
                } else {
                    node.is_definition()
                };
                kind_ok && node.symbol().map_or(false, |s| &self.graph[s] == name)
            })
            .collect();
        nodes.sort_by(|a, b| {
            let (la, lb) = (&self.locs[a], &self.locs[b]);
            (&la.path, la.line, la.span).cmp(&(&lb.path, lb.line, lb.span))
        });
        nodes
    }

    /// Run the REAL path engine: `find_all_complete_partial_paths` seeded at
    /// `seeds` (reference nodes), over the whole in-memory graph's edges.
    /// Returns one `(ref loc, def loc, edge count)` per complete path whose
    /// endpoints we know about, in deterministic order.
    fn complete_paths_from(&self, seeds: Vec<Handle<Node>>) -> Vec<(Loc, Loc, usize)> {
        let mut partials = PartialPaths::new();
        let mut candidates = GraphEdgeCandidates::new(&self.graph, &mut partials, None);
        let locs = &self.locs;
        let mut raw: Vec<(Loc, Loc, usize)> = Vec::new();
        ForwardPartialPathStitcher::find_all_complete_partial_paths(
            &mut candidates,
            seeds,
            StitcherConfig::default(),
            &NoCancellation,
            |_graph, _partials, path| {
                // The stitcher only visits COMPLETE paths here (ref start,
                // def end, empty stacks) — the pop-symbol guard already
                // enforced the name match.
                if let (Some(ref_loc), Some(def_loc)) =
                    (locs.get(&path.start_node), locs.get(&path.end_node))
                {
                    raw.push((ref_loc.clone(), def_loc.clone(), path.edges.len()));
                }
            },
        )
        .expect("NoCancellation never cancels");
        raw.sort_by(|a, b| {
            (&a.0.path, a.0.line, &a.1.path, a.1.line).cmp(&(&b.0.path, b.0.line, &b.1.path, b.1.line))
        });
        raw
    }
}

// ---------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(name: &str, line: u32, span: (u32, u32)) -> SimpleTag {
        SimpleTag {
            name: name.to_string(),
            line,
            span,
        }
    }

    /// The 3-file fixture from the M3b spec: A defines `parseConfig`, B
    /// references it, C defines an unrelated `parseConfig` shadow.
    fn fixture() -> Resolver {
        let mut r = Resolver::new();
        r.add_file(&ResolveInput {
            path: "src/a.ts".into(),
            defs: vec![tag("parseConfig", 2, (10, 21))],
            refs: vec![],
        });
        r.add_file(&ResolveInput {
            path: "src/b.ts".into(),
            defs: vec![],
            refs: vec![tag("parseConfig", 3, (40, 51))],
        });
        r.add_file(&ResolveInput {
            path: "src/c.ts".into(),
            defs: vec![tag("parseConfig", 7, (100, 111))],
            refs: vec![],
        });
        r
    }

    #[test]
    fn resolve_returns_both_defs_ambiguity_is_honest() {
        let r = fixture();
        let defs = r.resolve("parseConfig");
        assert_eq!(defs.len(), 2, "v0 global binding must surface BOTH defs");
        assert_eq!(defs[0].path, "src/a.ts");
        assert_eq!(defs[0].line, 2);
        assert_eq!(defs[0].span, (10, 21));
        assert_eq!(defs[1].path, "src/c.ts");
        assert_eq!(defs[1].line, 7);
        assert_eq!(defs[1].span, (100, 111));
        for d in &defs {
            assert!(!d.via.is_empty(), "via feeds Hit.why — mandatory");
            assert!(
                d.via.contains("stack-graph path"),
                "resolution with an in-graph ref must go through the real \
                 path engine, got: {}",
                d.via
            );
            assert!(d.via.contains("src/b.ts:3"), "via must name the ref site");
        }
    }

    #[test]
    fn find_refs_returns_bs_ref() {
        let r = fixture();
        let refs = r.find_refs("parseConfig");
        assert_eq!(refs.len(), 1, "exactly one ref site (B), deduped");
        assert_eq!(refs[0].path, "src/b.ts");
        assert_eq!(refs[0].line, 3);
        assert_eq!(refs[0].span, (40, 51));
        assert!(!refs[0].via.is_empty());
        // B's single ref reaches both defs — via says so honestly.
        assert!(refs[0].via.contains("2 def(s)"), "via: {}", refs[0].via);
        assert!(refs[0].via.contains("src/a.ts:2"));
        assert!(refs[0].via.contains("src/c.ts:7"));
    }

    #[test]
    fn remove_file_is_incremental() {
        let mut r = fixture();
        r.remove_file("src/a.ts");

        let defs = r.resolve("parseConfig");
        assert_eq!(defs.len(), 1, "after removing A only C's def remains");
        assert_eq!(defs[0].path, "src/c.ts");
        assert_eq!(defs[0].line, 7);

        // B's ref still resolves — now unambiguously to C.
        let refs = r.find_refs("parseConfig");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path, "src/b.ts");
        assert!(refs[0].via.contains("1 def(s)"), "via: {}", refs[0].via);
        assert!(refs[0].via.contains("src/c.ts:7"));
    }

    #[test]
    fn re_add_file_restores_resolution() {
        let mut r = fixture();
        r.remove_file("src/a.ts");
        assert_eq!(r.resolve("parseConfig").len(), 1);
        r.add_file(&ResolveInput {
            path: "src/a.ts".into(),
            defs: vec![tag("parseConfig", 2, (10, 21))],
            refs: vec![],
        });
        assert_eq!(r.resolve("parseConfig").len(), 2, "A's def is back");
    }

    #[test]
    fn replacing_a_file_updates_its_tags() {
        let mut r = fixture();
        // A moves its def to line 20.
        r.add_file(&ResolveInput {
            path: "src/a.ts".into(),
            defs: vec![tag("parseConfig", 20, (300, 311))],
            refs: vec![],
        });
        let defs = r.resolve("parseConfig");
        assert_eq!(defs.len(), 2, "still two defs, no stale duplicate");
        let a = defs.iter().find(|d| d.path == "src/a.ts").unwrap();
        assert_eq!(a.line, 20, "replaced tag, not the stale line 2");
        assert_eq!(a.span, (300, 311));
    }

    #[test]
    fn resolve_without_refs_uses_labelled_root_join_fallback() {
        let mut r = fixture();
        r.remove_file("src/b.ts"); // no refs left anywhere
        let defs = r.resolve("parseConfig");
        assert_eq!(defs.len(), 2, "defs still discoverable without a ref seed");
        for d in &defs {
            assert!(
                d.via.contains("root-join lookup"),
                "fallback must be labelled honestly in via: {}",
                d.via
            );
        }
    }

    #[test]
    fn unknown_name_resolves_to_nothing() {
        let r = fixture();
        assert!(r.resolve("noSuchName").is_empty());
        assert!(r.find_refs("noSuchName").is_empty());
    }

    #[test]
    fn refs_only_bind_to_matching_names() {
        let mut r = fixture();
        // D defines an unrelated name; B's parseConfig ref must not reach it.
        r.add_file(&ResolveInput {
            path: "src/d.ts".into(),
            defs: vec![tag("loadConfig", 1, (0, 10))],
            refs: vec![tag("loadConfig", 9, (200, 210))],
        });
        let defs = r.resolve("parseConfig");
        assert_eq!(defs.len(), 2);
        assert!(defs.iter().all(|d| d.path != "src/d.ts"));

        let refs = r.find_refs("loadConfig");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path, "src/d.ts");
        assert_eq!(refs[0].line, 9);
    }
}
