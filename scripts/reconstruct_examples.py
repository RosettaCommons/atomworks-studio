"""Prepare annotation-free inputs and verify GUI reconstruction against the shipped examples."""

import argparse
import io
import json
import re
from pathlib import Path

import numpy as np
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers
from biotite.structure.io.pdbx import CIFFile

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "packages/api/annotation_studio/examples"
PROVIDERS = load_providers()


def document(text):
    return StudioDocument.from_cif(
        text, condition_provider=PROVIDERS.condition_provider, validation_provider=PROVIDERS.validation_provider
    )


def strip_annotations(text):
    cif = CIFFile.read(io.StringIO(text))
    prefixes = ("condition_", "mask_", "annotation_")
    for block in cif.values():
        for key in list(block):
            if key.startswith(prefixes):
                del block[key]
        for key in list(block["atom_site"]):
            if key.startswith(prefixes):
                del block["atom_site"][key]
    stream = io.StringIO()
    cif.write(stream)
    return stream.getvalue()


def query(array, mask):
    clauses = []
    for chain in np.unique(array.chain_iid[mask]):
        chain_mask = array.chain_iid == chain
        selected = mask & chain_mask
        excluded = np.count_nonzero(selected) > np.count_nonzero(chain_mask) / 2
        ids = array.atom_id[(~mask if excluded else mask) & chain_mask].tolist()
        clause = f"chain_iid == {str(chain)!r}"
        if ids:
            clause += f" and atom_id {'not in' if excluded else 'in'} {ids}"
        clauses.append(f"({clause})")
    return " or ".join(clauses)


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    cases = []
    for example in json.loads((EXAMPLES / "examples.json").read_text()):
        expected = document((EXAMPLES / example["file"]).read_text())
        plain = document(strip_annotations(expected.to_cif()))
        source = directory / f"{example['id']}-plain.cif"
        # Missing-design placeholders are authored with the same segment control as PyMOL.
        placeholder = np.array([bool(re.fullmatch(r"[0-9]+-[0-9]+", name)) for name in plain.array.res_name])
        if example["id"] == "unconditional":
            # Studio cannot open an empty CIF. Use the unannotated placeholder as
            # a temporary seed, then replace it through the segment/delete GUI.
            plain.array.chain_id[:] = "Z"
        else:
            plain.array = plain.array[~placeholder]
        source.write_text(strip_annotations(plain.to_cif()))
        plain = document(source.read_text())
        target = expected.array[~placeholder] if example["id"] != "unconditional" else expected.array
        actions = []
        for definition in PROVIDERS.condition_provider.definitions:
            key, condition = definition.key, definition.condition
            if definition.kind != "mask":
                continue
            wanted = np.asarray(condition.mask(target, default="generate"))
            current = np.asarray(condition.mask(plain.array, default="generate"))
            for enabled in (False, True):
                mask = (wanted == enabled) & (current != wanted)
                if mask.any():
                    whole_chains = np.zeros(len(mask), dtype=bool)
                    for chain in np.unique(plain.array.chain_iid):
                        chain_mask = plain.array.chain_iid == chain
                        if np.all(mask[chain_mask]):
                            whole_chains |= chain_mask
                    selections = [whole_chains] if whole_chains.any() else []
                    indices = np.flatnonzero(mask & ~whole_chains)
                    # Keep each GUI query below the API's 4096-character input bound.
                    for chunk in np.array_split(indices, max(1, (len(indices) + 399) // 400)):
                        if not len(chunk):
                            continue
                        selected = np.zeros(len(plain.array), dtype=bool)
                        selected[chunk] = True
                        selections.append(selected)
                    for selected in selections:
                        expression = query(plain.array, selected)
                        np.testing.assert_equal(plain.query_indices(expression), np.flatnonzero(selected))
                        actions.append(
                            dict(
                                kind="condition",
                                key=key,
                                query=expression,
                                enabled=not enabled if definition.invert_mask else enabled,
                            )
                        )
        for key in ("index_group", "coordinate_group"):
            condition = PROVIDERS.condition_provider.definitions_by_name[key].condition
            wanted = condition.annotation(target, default="generate")
            current = condition.annotation(plain.array, default="generate")
            for group in np.unique(wanted):
                selected = wanted == group
                if key == "coordinate_group":
                    if group > 0:
                        actions.append(
                            dict(
                                kind="internal",
                                key="internal_coordinate",
                                query=query(plain.array, selected),
                                enabled=True,
                            )
                        )
                elif not any(np.array_equal(selected, current == value) for value in np.unique(current)):
                    actions.append(dict(kind="group", key=key, query=query(plain.array, selected)))
        if example["id"] == "unconditional":
            minimum, maximum = map(int, str(expected.array.res_name[0]).split("-"))
            actions.extend(
                (
                    dict(kind="segment", minimum=minimum, maximum=maximum, chain="A"),
                    dict(kind="delete", query="chain_id == 'Z'"),
                )
            )
        else:
            original = expected.array
            # Insert from the end so residue IDs of earlier anchors remain stable.
            for index in reversed(np.flatnonzero(placeholder)):
                minimum, maximum = map(int, str(original.res_name[index]).split("-"))
                chain = str(original.chain_id[index])
                same_chain = np.flatnonzero(original.chain_id == chain)
                real = same_chain[~placeholder[same_chain]]
                if len(real) == 0:
                    actions.append(dict(kind="segment", minimum=minimum, maximum=maximum, chain=chain))
                else:
                    following = real[real > index]
                    anchor = int(following[0] if len(following) else real[-1])
                    anchor_residue = int(original.res_id[anchor])
                    anchor_atom = str(original.atom_name[anchor])
                    actions.append(
                        dict(
                            kind="segment",
                            minimum=minimum,
                            maximum=maximum,
                            before=bool(len(following)),
                            query=f"chain_id == {chain!r} and res_id == {anchor_residue} "
                            f"and atom_name == {anchor_atom!r}",
                        )
                    )
        cases.append(dict(name=example["id"], source=str(source.resolve()), atoms=len(plain.array), actions=actions))
    (directory / "cases.json").write_text(json.dumps(cases, indent=2) + "\n")
    print(f"Prepared {len(cases)} annotation-free inputs and GUI recipes in {directory}")


def partition(values, reserved=()):
    """Group numbers are labels; preserve membership and reserved coordinate meanings."""
    mapping = {}
    result = []
    for value in values:
        if value in reserved:
            result.append(int(value))
        else:
            mapping.setdefault(int(value), len(mapping) + 1)
            result.append(mapping[int(value)])
    return result


def check(directory, host):
    for example in json.loads((EXAMPLES / "examples.json").read_text()):
        expected = document((EXAMPLES / example["file"]).read_text())
        for stage in ("saved", "reopened"):
            actual = document((directory / f"{host}-{example['id']}-{stage}.cif").read_text())
            a, b = expected.array, actual.array
            assert len(a) == len(b), example["id"]

            # Adding a missing chain places it after the uploaded chain. Atom
            # order is immaterial to the CIF semantics, so compare by identity.
            def identity(array):
                return np.lexsort((array.atom_name, array.res_name, array.res_id, array.chain_id))

            a, b = a[identity(a)], b[identity(b)]
            for field in ("chain_id", "res_id", "res_name", "atom_name", "element", "charge"):
                np.testing.assert_array_equal(a.get_annotation(field), b.get_annotation(field), err_msg=field)
            np.testing.assert_allclose(a.coord, b.coord, atol=0.001, equal_nan=True)
            np.testing.assert_array_equal(
                sorted(map(tuple, a.bonds.as_array())), sorted(map(tuple, b.bonds.as_array()))
            )
            for definition in PROVIDERS.condition_provider.definitions:
                key, condition = definition.key, definition.condition
                x = condition.annotation(a, default="generate")
                y = condition.annotation(b, default="generate")
                if key in {"index_group", "coordinate_group"}:
                    reserved = (-1, 0) if key == "coordinate_group" else (-1,)
                    np.testing.assert_equal(partition(x, reserved), partition(y, reserved), err_msg=key)
                elif key == "internal_coordinate":
                    # The UI authors group membership; native featurization derives missing targets.
                    group = PROVIDERS.condition_provider.definitions_by_name["coordinate_group"].condition
                    groups = group.annotation(a, default="generate")
                    for value in np.unique(groups[groups > 0]):
                        mask = groups == value
                        left = np.where(np.isfinite(x[mask]), x[mask], a.coord[mask])
                        right = np.where(np.isfinite(y[mask]), y[mask], b.coord[mask])
                        np.testing.assert_allclose(
                            np.linalg.norm(left[:, None] - left[None, :], axis=-1),
                            np.linalg.norm(right[:, None] - right[None, :], axis=-1),
                            atol=0.003,
                        )
                elif definition.kind == "pair":
                    np.testing.assert_equal(x.pairs, y.pairs, err_msg=key)
                    np.testing.assert_allclose(x.values, y.values, atol=0.001, equal_nan=True, err_msg=key)
                else:
                    np.testing.assert_equal(
                        condition.mask(a, default="generate"), condition.mask(b, default="generate"), err_msg=key
                    )
                    if np.asarray(x).dtype.kind in "fc":
                        np.testing.assert_allclose(x, y, atol=0.001, equal_nan=True, err_msg=key)
                    else:
                        np.testing.assert_equal(x, y, err_msg=key)
            for field in ("annotation_expsegmin_1_residue", "annotation_expsegmax_1_residue"):
                if field in a.get_annotation_categories():
                    np.testing.assert_equal(a.get_annotation(field), b.get_annotation(field), err_msg=field)
        print(f"{host}: {example['id']} reconstructed conditions and save/reopen match")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--check", metavar="HOST")
    args = parser.parse_args()
    check(args.directory, args.check) if args.check else prepare(args.directory)
