/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Extension -> language routing (tabby `intelligence.rs:76-133` + languages.toml,
//! Apache-2.0). All of js/jsx/ts/tsx/mjs/mts route to ONE `javascript-typescript`
//! config (the tsx grammar parses all of them). `known_language` drives the
//! bloop SegmentScorer x1000 recognized-language boost.

pub fn language_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "rust",
        "py" | "pyi" => "python",
        "java" => "java",
        "go" => "go",
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => "javascript-typescript",
        "cs" => "csharp",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "sol" => "solidity",
        "gd" => "gdscript",
        "ml" | "mli" => "ocaml",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        _ => return None,
    })
}

pub fn language_for_path(path: &std::path::Path) -> Option<&'static str> {
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(language_for_ext)
}
