/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! SegmentScorer — bloop `ranking.rs:19-39` (Apache-2.0), post-hoc adjustments
//! multiplied onto the trigram BM25 doc score:
//!   * x1000 for a recognized language (kills configs/data/vendored noise),
//!   * / clamp(avg_line_length, 20, 1000) (minified & long-line files sink),
//!   * / clamp(age_secs, 1, 5_000_000) (recency; ~58-day cap).
//! PORT FIX kept from the packet: clamp age at >=1 — bloop divides by
//! (now - last_commit) raw, which is a divide-by-zero -> +inf for a
//! just-committed file. We use file mtime as the recency signal (git-free).
//!
//! MEASURED FIX (M4 eval, V3Index golden set): bloop's raw `/age` divisor spans
//! 1..5e6 — it let minutes-old files outrank the true target by 10^4 and drove
//! MRR to 0.11 (every top hit was a just-written file). Dampened to `/ln(age)`
//! (range ~1..15.4): recency is now a gentle tiebreak, BM25 term evidence
//! dominates. This is exactly what the eval harness exists to catch.

pub fn segment_score(bm25: f32, known_lang: bool, avg_line_length: f64, age_secs: u64) -> f32 {
    let mut score = bm25;
    if known_lang {
        score *= 1000.0;
    }
    score /= (avg_line_length.clamp(20.0, 1000.0)) as f32;
    let age = age_secs.clamp(1, 5_000_000) as f32;
    score /= age.ln().max(1.0);
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_lang_outranks_unknown() {
        let code = segment_score(1.0, true, 40.0, 1000);
        let data = segment_score(1.0, false, 40.0, 1000);
        assert!(code > data * 100.0);
    }

    #[test]
    fn fresh_file_no_divide_by_zero() {
        let s = segment_score(1.0, true, 40.0, 0); // age 0 -> clamp 1, finite
        assert!(s.is_finite() && s > 0.0);
    }

    #[test]
    fn minified_long_lines_sink() {
        let normal = segment_score(1.0, true, 40.0, 1000);
        let minified = segment_score(1.0, true, 5000.0, 1000);
        assert!(normal > minified);
    }
}
