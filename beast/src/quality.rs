/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Quality junk filter — skip minified/generated files before they pollute the
//! index. Thresholds verified live against tabby `crates/tabby-index`
//! (index.rs:22-26,212-218 + intelligence.rs:221-250), Apache-2.0.
//!
//! Subtlety kept faithful to tabby: `avg_line_length` divides total content
//! length by the LINE COUNT; the two fractions divide by total BYTE length.

// 2000, not tabby's 300: tabby filters TRAINING data; we index the user's own
// source. On VSElite the 300-char cap junked prompts.ts, toolsService.ts, the
// chat agent — the exact files agents ask about — because legit code carries
// long template/prompt strings. True minified files still fail (their lines
// run 10k+ chars and avg_line_length trips too).
const MAX_LINE_LENGTH: usize = 2000;
const AVG_LINE_LENGTH: f64 = 150.0;
const MIN_ALPHA_NUM_FRACTION: f64 = 0.25;
const MAX_NUMBER_FRACTION: f64 = 0.5;
const MAX_LINES: usize = 100_000;

#[derive(Debug, Clone, Copy)]
pub struct FileMetrics {
    pub max_line_length: usize,
    pub avg_line_length: f64,
    pub alpha_num_fraction: f64,
    pub number_fraction: f64,
    pub num_lines: usize,
}

pub fn compute_metrics(content: &str) -> FileMetrics {
    let num_lines = content.lines().count();
    let max_line_length = content.lines().map(|l| l.chars().count()).max().unwrap_or(0);
    let total = content.len().max(1); // avoid div-by-0 on empty files
    let avg_line_length = content.len() as f64 / num_lines.max(1) as f64;
    let alpha_num = content.chars().filter(|c| c.is_alphanumeric()).count();
    let numbers = content.chars().filter(|c| c.is_numeric()).count();
    FileMetrics {
        max_line_length,
        avg_line_length,
        alpha_num_fraction: alpha_num as f64 / total as f64,
        number_fraction: numbers as f64 / total as f64,
        num_lines,
    }
}

/// 5-clause AND — a file is worth indexing iff it passes all. Down-stream code
/// never sees minified blobs, generated data tables, or giant machine files.
pub fn is_valid_file(m: &FileMetrics) -> bool {
    m.max_line_length <= MAX_LINE_LENGTH
        && m.avg_line_length <= AVG_LINE_LENGTH
        && m.alpha_num_fraction >= MIN_ALPHA_NUM_FRACTION
        && m.number_fraction <= MAX_NUMBER_FRACTION
        && m.num_lines <= MAX_LINES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_code() {
        let m = compute_metrics("fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n");
        assert!(is_valid_file(&m));
    }

    #[test]
    fn rejects_minified_one_liner() {
        let blob = "x".repeat(5000); // one 5000-char line -> max_line_length huge
        let m = compute_metrics(&blob);
        assert!(!is_valid_file(&m));
    }

    #[test]
    fn rejects_number_heavy_data() {
        let data = (0..500).map(|i| format!("{i},")).collect::<String>();
        let m = compute_metrics(&data);
        assert!(!is_valid_file(&m)); // number_fraction > 0.5
    }
}
