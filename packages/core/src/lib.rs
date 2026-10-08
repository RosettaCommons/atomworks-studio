//! Lossless inspection of AtomWorks annotated CIF files.
//!
//! Patinae owns visualization. AtomWorks remains authoritative for mutation and
//! serialization; this small WASM module proves that browser-side inspection
//! can retain every unknown/custom CIF category byte-for-byte.

use std::collections::BTreeSet;

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone)]
struct Token {
    value: String,
    bare: bool,
}

#[derive(Debug, Clone)]
struct LoopTable {
    headers: Vec<String>,
    values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CifSummary {
    pub atom_count: usize,
    pub finite_atom_count: usize,
    pub chain_ids: Vec<String>,
    pub condition_categories: Vec<String>,
    pub atom_site_columns: Vec<String>,
}

fn is_line_start(bytes: &[u8], index: usize) -> bool {
    index == 0 || bytes[index - 1] == b'\n'
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }

        if bytes[index] == b'#' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }

        let start = index;
        if bytes[index] == b';' && is_line_start(bytes, index) {
            index += 1;
            let content_start = index;
            let mut closing = None;
            while index < bytes.len() {
                if bytes[index] == b';' && is_line_start(bytes, index) {
                    closing = Some(index);
                    break;
                }
                index += 1;
            }
            let closing = closing.ok_or_else(|| "unterminated semicolon text field".to_owned())?;
            tokens.push(Token {
                value: input[content_start..closing].to_owned(),
                bare: false,
            });
            index = closing + 1;
            continue;
        }

        if matches!(bytes[index], b'\'' | b'"') {
            let quote = bytes[index];
            index += 1;
            let content_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            if index == bytes.len() {
                return Err("unterminated quoted CIF value".to_owned());
            }
            tokens.push(Token {
                value: input[content_start..index].to_owned(),
                bare: false,
            });
            index += 1;
            continue;
        }

        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'#' {
            index += 1;
        }
        tokens.push(Token {
            value: input[start..index].to_owned(),
            bare: true,
        });
    }

    Ok(tokens)
}

fn starts_control(token: &Token) -> bool {
    token.bare
        && (token.value == "loop_"
            || token.value == "stop_"
            || token.value.starts_with("data_")
            || token.value.starts_with("save_")
            || token.value.starts_with('_'))
}

fn atom_site_table(tokens: &[Token]) -> Result<LoopTable, String> {
    for loop_index in 0..tokens.len() {
        if !tokens[loop_index].bare || tokens[loop_index].value != "loop_" {
            continue;
        }

        let mut cursor = loop_index + 1;
        let mut headers = Vec::new();
        while cursor < tokens.len() && tokens[cursor].bare && tokens[cursor].value.starts_with('_')
        {
            headers.push(tokens[cursor].value.clone());
            cursor += 1;
        }
        if headers.is_empty()
            || !headers
                .iter()
                .all(|header| header.starts_with("_atom_site."))
        {
            continue;
        }

        let width = headers.len();
        let mut values = Vec::new();
        while cursor < tokens.len() {
            if values.len() % width == 0 && starts_control(&tokens[cursor]) {
                break;
            }
            values.push(tokens[cursor].value.clone());
            cursor += 1;
        }
        if values.len() % width != 0 {
            return Err(format!(
                "_atom_site loop has {} values for {} columns",
                values.len(),
                width
            ));
        }
        return Ok(LoopTable { headers, values });
    }
    let mut headers = Vec::new();
    let mut values = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if token.bare && token.value.starts_with("_atom_site.") {
            let value = tokens
                .get(index + 1)
                .filter(|value| !starts_control(value))
                .ok_or_else(|| format!("missing value for {}", token.value))?;
            if headers.contains(&token.value) {
                return Err(format!("duplicate scalar field {}", token.value));
            }
            headers.push(token.value.clone());
            values.push(value.value.clone());
        }
    }
    if headers.is_empty() {
        return Err("CIF has no _atom_site category".to_owned());
    }
    Ok(LoopTable { headers, values })
}

fn annotation_category(tag: &str) -> Option<String> {
    let tag = tag.strip_prefix('_')?;
    let category = tag.split('.').next().unwrap_or(tag);
    if category.starts_with("condition_") || category.starts_with("mask_") {
        Some(category.to_owned())
    } else if let Some(field) = tag.strip_prefix("atom_site.") {
        if field.starts_with("condition_") || field.starts_with("mask_") {
            Some(field.to_owned())
        } else {
            None
        }
    } else {
        None
    }
}

pub fn inspect(input: &str) -> Result<CifSummary, String> {
    let tokens = tokenize(input)?;
    let table = atom_site_table(&tokens)?;
    let width = table.headers.len();
    let atom_count = table.values.len() / width;
    let coordinate_columns: Option<Vec<usize>> = ["Cartn_x", "Cartn_y", "Cartn_z"]
        .iter()
        .map(|axis| {
            table
                .headers
                .iter()
                .position(|header| header == &format!("_atom_site.{axis}"))
        })
        .collect();
    let finite_atom_count = coordinate_columns.map_or(0, |columns| {
        table
            .values
            .chunks_exact(width)
            .filter(|row| {
                columns
                    .iter()
                    .all(|&column| row[column].parse::<f64>().is_ok_and(f64::is_finite))
            })
            .count()
    });

    let chain_column = table
        .headers
        .iter()
        .position(|header| header == "_atom_site.label_asym_id")
        .or_else(|| {
            table
                .headers
                .iter()
                .position(|header| header == "_atom_site.auth_asym_id")
        });
    let chain_ids = chain_column
        .map(|column| {
            table
                .values
                .chunks_exact(width)
                .map(|row| row[column].clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default();

    let condition_categories = tokens
        .iter()
        .filter(|token| token.bare && token.value.starts_with('_'))
        .filter_map(|token| annotation_category(&token.value))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    Ok(CifSummary {
        atom_count,
        finite_atom_count,
        chain_ids,
        condition_categories,
        atom_site_columns: table.headers,
    })
}

/// Validate a CIF and return it without reformatting or dropping custom fields.
pub fn roundtrip(input: &str) -> Result<String, String> {
    inspect(input)?;
    Ok(input.to_owned())
}

#[wasm_bindgen]
pub fn inspect_cif(input: &str) -> Result<JsValue, JsValue> {
    let summary = inspect(input).map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&summary).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn roundtrip_cif(input: &str) -> Result<String, JsValue> {
    roundtrip(input).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANNOTATED_FIXTURE: &str =
        include_str!("../../../tests/fixtures/heme_b_single_chain_annotated.cif");

    #[test]
    fn annotated_cif_roundtrip_is_byte_exact() {
        assert_eq!(roundtrip(ANNOTATED_FIXTURE).unwrap(), ANNOTATED_FIXTURE);
    }

    #[test]
    fn finds_atom_site_and_vector_condition_categories() {
        let summary = inspect(ANNOTATED_FIXTURE).unwrap();
        assert_eq!(summary.atom_count, 44);
        assert_eq!(summary.chain_ids, ["A", "B"]);
        assert!(
            summary
                .condition_categories
                .contains(&"condition_ChainCentroid_1_atom".to_owned())
        );
        assert!(
            summary
                .condition_categories
                .contains(&"mask_ChainCentroid_1_atom".to_owned())
        );
    }

    #[test]
    fn quoted_control_words_do_not_terminate_a_loop() {
        let input = "data_x\nloop_\n_atom_site.id\n_atom_site.label_asym_id\n1 'loop_'\n#\n";
        let summary = inspect(input).unwrap();
        assert_eq!(summary.atom_count, 1);
        assert_eq!(summary.chain_ids, ["loop_"]);
    }

    #[test]
    fn rejects_ragged_atom_site_loop() {
        let input = "data_x\nloop_\n_atom_site.id\n_atom_site.label_asym_id\n1\n#\n";
        assert!(inspect(input).unwrap_err().contains("values"));
    }

    #[test]
    fn scalar_placeholder_keeps_annotations_and_roundtrips() {
        let input = "data_x\n_atom_site.id 1\n_atom_site.label_asym_id A\n_atom_site.Cartn_x nan\n_atom_site.condition_index_1_residue True\n";
        let summary = inspect(input).unwrap();
        assert_eq!(summary.atom_count, 1);
        assert_eq!(summary.chain_ids, ["A"]);
        assert_eq!(summary.finite_atom_count, 0);
        assert_eq!(summary.condition_categories, ["condition_index_1_residue"]);
        assert_eq!(roundtrip(input).unwrap(), input);
        assert!(inspect("data_x\n_atom_site.id\n").is_err());
    }
}
