/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Code tokenizer. Baseline = tabby `tokenizer.rs:4-26` (`\w+` regex + drop
//! tokens > 64 chars), Apache-2.0. EXTENDED with camelCase/snake/digit splitting
//! to match OUR TS index (V3Index commit 27d9428) so the head-to-head MRR compare
//! is apples-to-apples (tokenizer parity is the only variable in the lexical test).

use regex::Regex;
use std::sync::OnceLock;

const MAX_TOKEN_LEN: usize = 64;

fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\w+").unwrap())
}

/// Emit the whole token AND its lowercased camelCase/snake/digit sub-tokens
/// (length >= 2). `parseHTTPServer2` -> parsehttpserver2, parse, http, server, 2.
pub fn tokenize_code(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for m in word_re().find_iter(text) {
        let w = m.as_str();
        if w.len() > MAX_TOKEN_LEN {
            continue; // RemoveLongFilter(64) — drop minified blobs
        }
        let lower = w.to_ascii_lowercase();
        if lower.len() >= 2 {
            out.push(lower);
        }
        for sub in split_identifier(w) {
            if sub.len() >= 2 && !out.last().is_some_and(|l| *l == sub) {
                out.push(sub);
            }
        }
    }
    out
}

/// Split an identifier on camelCase / PascalCase / snake_case / kebab / digit
/// boundaries, lowercasing each part.
fn split_identifier(id: &str) -> Vec<String> {
    let chars: Vec<char> = id.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    for i in 0..chars.len() {
        let c = chars[i];
        if c == '_' || c == '-' {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let boundary = if i == 0 {
            false
        } else {
            let p = chars[i - 1];
            (p.is_lowercase() && c.is_uppercase())        // camelCase -> camel|Case
                || (p.is_alphabetic() && c.is_numeric())  // foo2 -> foo|2
                || (p.is_numeric() && c.is_alphabetic())  // 2foo -> 2|foo
                // HTTPServer -> HTTP|Server (upper run followed by a lower)
                || (p.is_uppercase()
                    && c.is_uppercase()
                    && i + 1 < chars.len()
                    && chars[i + 1].is_lowercase())
        };
        if boundary && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts.into_iter().map(|p| p.to_ascii_lowercase()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_camel_snake_digits() {
        // 1-char sub-tokens ("2") are correctly dropped by the >=2-char floor,
        // matching our TS tokenizer.
        let t = tokenize_code("parseHTTPServer2 my_var");
        for want in ["parse", "http", "server", "my", "var"] {
            assert!(t.contains(&want.to_string()), "missing {want} in {t:?}");
        }
    }

    #[test]
    fn drops_overlong_minified_token() {
        let blob = "a".repeat(200);
        assert!(tokenize_code(&blob).is_empty());
    }
}
