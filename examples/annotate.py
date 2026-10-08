"""Select atoms and annotate a CIF with the same primitives used by every editor."""

from __future__ import annotations

import argparse
from pathlib import Path

from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers


def annotate(cif: str, query: str, condition: str = "sequence") -> str:
    providers = load_providers()
    document = StudioDocument.from_cif(
        cif,
        condition_provider=providers.condition_provider,
        validation_provider=providers.validation_provider,
    )
    indices = document.query_indices(query).tolist()
    if not indices:
        raise ValueError("query selected no atoms")
    document.set_condition(condition, indices)
    return document.to_cif()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--query", default="sel('*/*/*/CA')")
    parser.add_argument("--condition", default="sequence", choices=["sequence", "coordinate", "hotspot"])
    args = parser.parse_args()
    args.output.write_text(annotate(args.input.read_text(), args.query, args.condition))
