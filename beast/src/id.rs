/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Content-hash-as-identity + staleness. The identity of a file IS its content
//! hash, so a stale id can never point at wrong text — the load-bearing invariant
//! behind "a wrong index costs a re-read." Ported from tabby intelligence/id.rs
//! (Apache-2.0); tabby keys on the git blob sha1 — blake3-of-bytes is the
//! git-independent equivalent and is fine for non-git corpora.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceFileId {
    pub path: String,
    pub content_hash: String,
}

impl SourceFileId {
    pub fn compute(path: &Path, content: &[u8]) -> Self {
        SourceFileId {
            path: path.to_string_lossy().into_owned(),
            content_hash: blake3::hash(content).to_hex().to_string(),
        }
    }

    /// A stored id still matches iff the file's current bytes hash the same.
    /// Used to SKIP re-indexing unchanged files (tabby content-hash staleness).
    pub fn matches(&self, current_content: &[u8]) -> bool {
        self.content_hash == blake3::hash(current_content).to_hex().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn identity_is_content() {
        let a = SourceFileId::compute(Path::new("x.rs"), b"fn a() {}");
        assert!(a.matches(b"fn a() {}"));
        assert!(!a.matches(b"fn a() { changed }"));
    }
}
