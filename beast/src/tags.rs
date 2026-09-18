/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! M3a — tree-sitter TAGS extraction. Ported from tabby `intelligence.rs:24-56`
//! + `languages.rs` (Apache-2.0); the tag ENGINE is the `tree-sitter-tags`
//! crate (same as tabby) — we never run raw queries ourselves.
//!
//! Load-bearing rules:
//!  * the registry is FALLIBLE per language (no `.unwrap()`): one broken query
//!    disables that language, never panics the indexer.
//!  * tabby's `has_error => ZERO tags` rule was MEASURED AND DROPPED
//!    (2026-07-07): on VSElite, tree-sitter reports an error somewhere in 31
//!    of 283 workbench files — and they are exactly the largest, most-central
//!    ones (prompts.ts 153KB, toolsService.ts 133KB, the index impl, the chat
//!    agent), because big modern-TS files are where the grammar chokes. Zero
//!    tags for the heart of the codebase blinds symbol_lookup, impact_trace,
//!    and the memory graph-pull where they matter most. Partial tags with an
//!    occasional mis-spanned entry are strictly better for every consumer
//!    here (anchors/defs/refs/ripple) than none; each tag's name is still
//!    validated against the source range before storing.
//!
//! `tags.rs` is the shared substrate for FOUR consumers: SymbolIndex (M3a),
//! the stack-graphs resolver (M3b), repomap, and trace_impact. Parse once.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use tree_sitter_tags::{TagsConfiguration, TagsContext};

/// Normalized symbol kind — the clean-room "unify the capture tag" idea:
/// every language's `@definition.<suffix>` collapses into one schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    Type,
    Module,
    Constant,
    Variable,
    Call,
    Other,
}

impl SymbolKind {
    pub fn normalize(syntax_type: &str, is_definition: bool) -> Self {
        match syntax_type {
            "function" | "macro" | "constructor" => SymbolKind::Function,
            "method" => SymbolKind::Method,
            "class" | "struct" | "enum" | "union" | "object" => SymbolKind::Class,
            "interface" | "trait" => SymbolKind::Interface,
            "type" | "alias" => SymbolKind::Type,
            "module" | "namespace" | "implementation" => SymbolKind::Module,
            "constant" | "val" => SymbolKind::Constant,
            "variable" | "var" | "parameter" | "property" => SymbolKind::Variable,
            "call" => SymbolKind::Call,
            _ if !is_definition => SymbolKind::Call,
            _ => SymbolKind::Other,
        }
    }
}

/// A tag resolved to file coordinates — the persisted form (db/tags.json),
/// consumed by symbol search now, repomap + trace_impact next.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredTag {
    pub path: String,
    pub name: String,
    pub kind: SymbolKind,
    pub is_definition: bool,
    /// 1-based line of the tag's own span start.
    pub line: u32,
    pub span: (u32, u32),
    pub syntax_type: String,
    pub docs: Option<String>,
}

/// tree_sitter_tags::TagsConfiguration holds raw pointers; it is used strictly
/// read-only after construction (tabby wraps it the same way for its indexer).
pub struct TagsConfigurationSync(pub TagsConfiguration);
unsafe impl Send for TagsConfigurationSync {}
unsafe impl Sync for TagsConfigurationSync {}

fn cfg(lang: tree_sitter::Language, q: &str) -> Option<TagsConfigurationSync> {
    // Fallible, NOT unwrap: a query referencing a capture the grammar can't
    // produce fails HERE and only disables this one language.
    TagsConfiguration::new(lang, q, "").ok().map(TagsConfigurationSync)
}

static REGISTRY: Lazy<HashMap<&'static str, TagsConfigurationSync>> = Lazy::new(|| {
    let mut m = HashMap::new();
    let mut put = |k: &'static str, c: Option<TagsConfigurationSync>| {
        if let Some(c) = c {
            m.insert(k, c);
        }
    };
    put("rust", cfg(tree_sitter_rust::language(), include_str!("../queries/rust.scm")));
    put("go", cfg(tree_sitter_go::language(), include_str!("../queries/go.scm")));
    put("python", cfg(tree_sitter_python::language(), tree_sitter_python::TAGS_QUERY));
    put("java", cfg(tree_sitter_java::language(), tree_sitter_java::TAGS_QUERY));
    // js/jsx/ts/tsx/mjs/mts ALL route here (lang.rs) — one TSX-grammar config,
    // combined JS+TS query (tabby's own tsx.scm missed methods + call refs).
    put(
        "javascript-typescript",
        cfg(
            tree_sitter_typescript::language_tsx(),
            include_str!("../queries/tags-typescript-combined.scm"),
        ),
    );
    m
});

pub fn supported_language(lang: &str) -> bool {
    REGISTRY.contains_key(lang)
}

/// Extract tags for one file. Returns an empty Vec on: unregistered language
/// or total parse failure. Files with recoverable syntax errors still emit
/// their parseable tags (see module docs — the zero-on-error rule blanked the
/// 31 biggest files on a real workspace).
pub fn find_tags(language: &str, path: &str, content: &str) -> Vec<StoredTag> {
    let Some(config) = REGISTRY.get(language) else {
        return Vec::new();
    };
    let mut ctx = TagsContext::new();
    let Ok((tags, _has_error)) = ctx.generate_tags(&config.0, content.as_bytes(), None) else {
        return Vec::new();
    };
    tags.filter_map(|t| t.ok())
        .filter_map(|t| {
            let name = content.get(t.name_range.clone())?.to_string();
            if name.is_empty() {
                return None;
            }
            let raw = config.0.syntax_type_name(t.syntax_type_id).to_string();
            Some(StoredTag {
                path: path.to_string(),
                name,
                kind: SymbolKind::normalize(&raw, t.is_definition),
                is_definition: t.is_definition,
                line: (t.span.start.row + 1) as u32,
                span: ((t.span.start.row + 1) as u32, (t.span.end.row + 1) as u32),
                syntax_type: raw,
                docs: t.docs,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_defs_and_names() {
        let src = "pub fn alpha_beta() {}\npub struct Gamma;\n";
        let tags = find_tags("rust", "x.rs", src);
        assert!(tags.iter().any(|t| t.name == "alpha_beta"
            && t.is_definition
            && t.kind == SymbolKind::Function
            && t.line == 1));
        assert!(tags
            .iter()
            .any(|t| t.name == "Gamma" && t.kind == SymbolKind::Class));
    }

    #[test]
    fn typescript_methods_and_calls() {
        let src = "class Foo {\n  bar() { baz(); }\n}\nfunction baz() {}\n";
        let tags = find_tags("javascript-typescript", "x.ts", src);
        assert!(
            tags.iter()
                .any(|t| t.name == "bar" && t.is_definition && t.kind == SymbolKind::Method),
            "method_definition must be captured: {tags:?}"
        );
        assert!(
            tags.iter().any(|t| t.name == "baz" && !t.is_definition),
            "call reference must be captured: {tags:?}"
        );
    }

    #[test]
    fn syntax_error_still_emits_recoverable_tags() {
        // One broken construct must not blank the file: the valid fn after the
        // error is still tagged (rule change 2026-07-07 — see module docs).
        let src = "pub fn broken( {{{\npub fn works() { helper(); }\n";
        let tags = find_tags("rust", "x.rs", src);
        assert!(tags.iter().any(|t| t.name == "works" && t.is_definition));
    }

    #[test]
    fn python_via_grammar_const() {
        let src = "def hello():\n    world()\n";
        let tags = find_tags("python", "x.py", src);
        assert!(tags.iter().any(|t| t.name == "hello" && t.is_definition));
        assert!(tags.iter().any(|t| t.name == "world" && !t.is_definition));
    }
}
