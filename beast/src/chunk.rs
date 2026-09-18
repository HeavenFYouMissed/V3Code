/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Chunking. M1 = fixed line windows. M3 replaces the body with tree-sitter
//! structural chunks (tabby `intelligence.rs:135-208`, CHUNK_SIZE=512 chars w/
//! per-language override). The byte->line map is O(n) via a resume cursor
//! (tabby / bloop `chunk.rs::point()`), so M3 can locate tag spans cheaply.

pub const CHUNK_LINES: usize = 40;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Chunk {
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

pub fn chunk_file(content: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = content.lines().collect();
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let end = (i + CHUNK_LINES).min(lines.len());
        chunks.push(Chunk {
            start_line: (i as u32) + 1,
            end_line: end as u32,
            text: lines[i..end].join("\n"),
        });
        i = end;
    }
    chunks
}

/// Byte-offset -> 1-based line via a resume cursor: pass the previous
/// `(last_off, last_line)` so a forward scan over ascending offsets stays O(n)
/// total instead of O(n) per lookup.
pub fn line_from_byte_offset(
    s: &str,
    last_off: usize,
    last_line: u32,
    byte_off: usize,
) -> (u32, usize) {
    let bytes = s.as_bytes();
    let mut line = last_line;
    let mut i = last_off;
    while i < byte_off && i < bytes.len() {
        if bytes[i] == b'\n' {
            line += 1;
        }
        i += 1;
    }
    (line, byte_off)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cover_all_lines() {
        let src = (0..100).map(|i| format!("line {i}\n")).collect::<String>();
        let chunks = chunk_file(&src);
        assert_eq!(chunks.first().unwrap().start_line, 1);
        assert_eq!(chunks.last().unwrap().end_line, 100);
    }

    #[test]
    fn byte_to_line_resumes() {
        let s = "a\nbb\nccc\n";
        let (l1, off1) = line_from_byte_offset(s, 0, 1, 2); // start of "bb"
        assert_eq!(l1, 2);
        let (l2, _) = line_from_byte_offset(s, off1, l1, 5); // into "ccc"
        assert_eq!(l2, 3);
    }
}
