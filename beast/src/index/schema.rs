/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
//! Tantivy schema — ported shape from bloop `schema.rs:70-134` (Apache-2.0):
//! a trigram-tokenized content field for stage-1 recall (NgramTokenizer(1,3) +
//! lowercase), plus stored raw content for the stage-2 confirm pass, plus the
//! fast fields SegmentScorer needs (lang / avg_line_length / mtime).
//!
//! SCHEMA_VERSION gates the index dir: tantivy hard-errors on schema drift, so
//! a version bump forces a clean rebuild (packet risk: "version the schema dir
//! from day one").

use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, TextFieldIndexing, TextOptions, FAST, STORED,
    STRING,
};
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};

pub const SCHEMA_VERSION: &str = "1";
pub const TRIGRAM_TOKENIZER: &str = "trigram";

#[derive(Clone, Copy)]
pub struct Fields {
    pub path: Field,
    pub content: Field,
    pub content_trigram: Field,
    pub lang: Field,
    pub content_hash: Field,
    pub avg_line_length: Field,
    pub mtime: Field,
}

pub fn build_schema() -> (Schema, Fields) {
    let mut b: SchemaBuilder = Schema::builder();
    let path = b.add_text_field("path", STRING | STORED);
    let content = b.add_text_field("content", STORED);
    let content_trigram = b.add_text_field(
        "content_trigram",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TRIGRAM_TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqs),
        ),
    );
    let lang = b.add_text_field("lang", STRING | STORED);
    let content_hash = b.add_text_field("content_hash", STRING | STORED);
    let avg_line_length = b.add_f64_field("avg_line_length", FAST | STORED);
    let mtime = b.add_u64_field("mtime", FAST | STORED);
    (
        b.build(),
        Fields {
            path,
            content,
            content_trigram,
            lang,
            content_hash,
            avg_line_length,
            mtime,
        },
    )
}

/// bloop: `NgramTokenizer::new(1, 3, false)` + lowercase. min_gram=1 keeps 1-2
/// char query tokens matchable; BM25 over trigram terms is the recall stage.
pub fn trigram_analyzer() -> tantivy::Result<TextAnalyzer> {
    Ok(TextAnalyzer::builder(NgramTokenizer::new(1, 3, false)?)
        .filter(LowerCaser)
        .build())
}
