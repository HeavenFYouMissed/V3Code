/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Repo walker — respects `.gitignore` and skips hidden files (opencode
//! `fileutil.go::SkipHidden` parity) via the `ignore` crate. Yields UTF-8 text
//! files only; binaries (invalid UTF-8) are skipped — the floor is text.
//!
//! The walk IS the read: every yielded file carries its full contents, so this
//! is where the corpus I/O actually happens (not in the indexing loop). Two
//! consequences drive the design:
//!   1. It runs `build_parallel()` — per-file `read_to_string` latency is the
//!      bottleneck, and it dominates on Windows where Defender's filter driver
//!      taxes every open. Parallelism hides latency it cannot remove.
//!   2. Excluded paths are filtered HERE, before the read, so a file the caller
//!      can never index costs zero I/O.
//! Output is sorted by path so the corpus order is deterministic despite the
//! nondeterministic traversal order of a parallel walk.

use ignore::{WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

pub struct WalkedFile {
    pub path: PathBuf,
    pub content: String,
}

/// Number of walker threads. `available_parallelism` mirrors what the `ignore`
/// crate would pick on its own; the explicit clamp keeps a 1-core box from
/// spawning a degenerate pool and a 64-core box from thrashing the filesystem
/// with more concurrent opens than it can service.
fn walk_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 12)
}

/// Corpus-relative, forward-slashed path — the form `--exclude` prefixes are
/// expressed in. Must stay byte-identical to `index::rel_path`, which computes
/// the same string for the fingerprint and the indexed document; drift between
/// the two means either a permanent rebuild or a silent false skip.
fn rel_for_exclude(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn walk_repo(root: &Path) -> Vec<WalkedFile> {
    walk_repo_excluding(root, &[])
}

/// Walk `root`, skipping any file whose corpus-relative path starts with one of
/// `exclude`. The prefix test happens before `read_to_string`, so excluded trees
/// (vendored deps, generated output) cost a `strip_prefix` instead of a file
/// read — on a repo where the excluded region is large that is most of the walk.
///
/// Directory pruning is deliberately NOT done here: an exclude is a path-prefix
/// string, not a directory, so `--exclude src/gen` must skip `src/generated.rs`
/// too. Pruning at the directory level would silently index it.
pub fn walk_repo_excluding(root: &Path, exclude: &[String]) -> Vec<WalkedFile> {
    let (tx, rx) = mpsc::channel::<WalkedFile>();
    WalkBuilder::new(root)
        .hidden(true) // skip dotfiles/dirs
        .git_ignore(true) // respect .gitignore
        .git_global(false)
        .parents(true)
        .threads(walk_threads())
        .build_parallel()
        .run(|| {
            // One closure instance per worker thread; each gets its own Sender
            // clone, and the walk ends when the last one drops.
            let tx = tx.clone();
            let root = root.to_path_buf();
            let exclude = exclude.to_vec();
            Box::new(move |result| {
                let Ok(entry) = result else {
                    return WalkState::Continue;
                };
                let path = entry.path();
                // MUST be `is_file()`, not `entry.file_type().is_file()`.
                // `DirEntry::file_type` reports the entry itself, so a symlink
                // TO a regular file types as a symlink and would be dropped —
                // silently shrinking the corpus versus the serial walk, which
                // used `Path::is_file()` (follows links). Caught by a 1-file /
                // 35-byte delta on a real repo; the cost is one stat per entry.
                if !path.is_file() {
                    return WalkState::Continue;
                }
                if !exclude.is_empty() {
                    let rel = rel_for_exclude(path, &root);
                    if exclude.iter().any(|e| rel.starts_with(e.as_str())) {
                        return WalkState::Continue; // never read it
                    }
                }
                if let Ok(content) = std::fs::read_to_string(path) {
                    // Send failure only happens if the receiver is gone, which
                    // cannot occur while this call is on the stack.
                    let _ = tx.send(WalkedFile {
                        path: path.to_path_buf(),
                        content,
                    });
                }
                WalkState::Continue
            })
        });
    drop(tx); // release the parent handle so the channel closes

    let mut out: Vec<WalkedFile> = rx.into_iter().collect();
    // Parallel traversal order is nondeterministic. Sorting restores a stable
    // corpus order so tags.json (built by appending in walk order) is
    // byte-identical run to run and matches the serial walk exactly.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "beast-walk-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// The parallel walk must produce a stable order, or `tags.json` differs
    /// run to run and the "identical results" contract breaks.
    #[test]
    fn output_is_sorted_by_path() {
        let d = tmpdir("sorted");
        for rel in ["z.rs", "a.rs", "m/n.rs", "b.rs"] {
            write(&d, rel, "fn x() {}");
        }
        let got: Vec<String> = walk_repo(&d)
            .iter()
            .map(|f| rel_for_exclude(&f.path, &d))
            .collect();
        let mut want = got.clone();
        want.sort();
        assert_eq!(got, want, "walk output must be path-sorted");
        assert_eq!(got.len(), 4);
        fs::remove_dir_all(&d).ok();
    }

    /// Repeated walks of the same tree must agree — this is what makes a
    /// parallel walk safe to substitute for the serial one.
    #[test]
    fn repeated_walks_are_identical() {
        let d = tmpdir("stable");
        for i in 0..40 {
            write(&d, &format!("src/f{i}.rs"), &format!("fn f{i}() {{}}"));
        }
        let a: Vec<_> = walk_repo(&d).into_iter().map(|f| f.path).collect();
        let b: Vec<_> = walk_repo(&d).into_iter().map(|f| f.path).collect();
        assert_eq!(a, b);
        fs::remove_dir_all(&d).ok();
    }

    /// The point of pushing excludes into the walker: excluded files are never
    /// read. Observable here as their absence from the output.
    #[test]
    fn exclude_prefix_filters_before_read() {
        let d = tmpdir("exclude");
        write(&d, "src/keep.rs", "fn keep() {}");
        write(&d, "vendor/drop.rs", "fn drop_me() {}");
        write(&d, "vendor/deep/also.rs", "fn also() {}");
        let got: Vec<String> = walk_repo_excluding(&d, &["vendor/".to_string()])
            .iter()
            .map(|f| rel_for_exclude(&f.path, &d))
            .collect();
        assert_eq!(got, vec!["src/keep.rs".to_string()]);
        fs::remove_dir_all(&d).ok();
    }

    /// An exclude is a path-PREFIX, not a directory: `src/gen` must also drop
    /// the sibling FILE `src/generated.rs`. Pruning whole directories instead
    /// would silently index it — the failure would look like a stale index.
    #[test]
    fn exclude_is_a_path_prefix_not_a_directory() {
        let d = tmpdir("prefix");
        write(&d, "src/gen/a.rs", "fn a() {}");
        write(&d, "src/generated.rs", "fn g() {}");
        write(&d, "src/genuine.rs", "fn u() {}");
        write(&d, "src/other.rs", "fn o() {}");
        let got: Vec<String> = walk_repo_excluding(&d, &["src/gen".to_string()])
            .iter()
            .map(|f| rel_for_exclude(&f.path, &d))
            .collect();
        assert_eq!(got, vec!["src/other.rs".to_string()]);
        fs::remove_dir_all(&d).ok();
    }

    /// An empty exclude list must behave exactly like the old unfiltered walk.
    #[test]
    fn empty_exclude_matches_plain_walk() {
        let d = tmpdir("empty");
        write(&d, "a.rs", "fn a() {}");
        write(&d, "b/c.rs", "fn c() {}");
        let plain: Vec<_> = walk_repo(&d).into_iter().map(|f| f.path).collect();
        let excl: Vec<_> = walk_repo_excluding(&d, &[])
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(plain, excl);
        fs::remove_dir_all(&d).ok();
    }

    /// Contents must survive the channel intact — a parallel walk that mangled
    /// or mismatched bodies would corrupt both the fingerprint and the index.
    #[test]
    fn contents_are_paired_with_the_right_path() {
        let d = tmpdir("content");
        write(&d, "a.rs", "AAA");
        write(&d, "b.rs", "BBB");
        let files = walk_repo(&d);
        for f in &files {
            let rel = rel_for_exclude(&f.path, &d);
            match rel.as_str() {
                "a.rs" => assert_eq!(f.content, "AAA"),
                "b.rs" => assert_eq!(f.content, "BBB"),
                other => panic!("unexpected file {other}"),
            }
        }
        assert_eq!(files.len(), 2);
        fs::remove_dir_all(&d).ok();
    }

    /// REGRESSION. The parallel walk originally used
    /// `entry.file_type().is_file()` — cheaper, but it describes the entry
    /// itself, so a symlink to a regular file types as a symlink and was
    /// silently dropped. On the real repo that shrank the corpus by exactly one
    /// file (35 bytes) versus the serial walk, which used `Path::is_file()`.
    /// A corpus that quietly loses files is worse than a slow walk.
    #[cfg(unix)]
    #[test]
    fn symlinked_files_are_walked_like_the_serial_walk_did() {
        let d = tmpdir("symlink");
        write(&d, "real.sh", "echo hi");
        std::os::unix::fs::symlink(d.join("real.sh"), d.join("link.sh")).unwrap();
        let got: Vec<String> = walk_repo(&d)
            .iter()
            .map(|f| rel_for_exclude(&f.path, &d))
            .collect();
        assert_eq!(got, vec!["link.sh".to_string(), "real.sh".to_string()]);
        fs::remove_dir_all(&d).ok();
    }

    /// A symlink pointing nowhere must not abort the walk or appear in output.
    #[cfg(unix)]
    #[test]
    fn broken_symlinks_are_skipped() {
        let d = tmpdir("broken");
        write(&d, "real.rs", "fn r() {}");
        std::os::unix::fs::symlink(d.join("does-not-exist"), d.join("dangling.rs")).unwrap();
        let got: Vec<String> = walk_repo(&d)
            .iter()
            .map(|f| rel_for_exclude(&f.path, &d))
            .collect();
        assert_eq!(got, vec!["real.rs".to_string()]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn thread_count_is_clamped() {
        let n = walk_threads();
        assert!((1..=12).contains(&n), "thread count {n} out of range");
    }
}
