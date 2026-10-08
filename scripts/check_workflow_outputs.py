"""Compare native/browser/VS Code workflow exports as scientific data, not CIF timestamps."""

import argparse
import json
from pathlib import Path

import numpy as np
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers


def document(path, providers):
    return StudioDocument.from_cif(
        path.read_text(),
        condition_provider=providers.condition_provider,
        validation_provider=providers.validation_provider,
    )


def compare(left, right):
    a, b = left.array, right.array
    assert len(a) == len(b), (len(a), len(b))
    for field in ("chain_id", "res_id", "ins_code", "res_name", "atom_name", "element", "hetero", "charge"):
        np.testing.assert_equal(a.get_annotation(field), b.get_annotation(field), err_msg=field)
    np.testing.assert_allclose(a.coord, b.coord, atol=0.001, rtol=0, equal_nan=True)
    for field in ("annotation_expsegmin_1_residue", "annotation_expsegmax_1_residue"):
        present = field in a.get_annotation_categories()
        assert present == (field in b.get_annotation_categories()), field
        if present:
            np.testing.assert_equal(a.get_annotation(field), b.get_annotation(field), err_msg=field)
    bonds_a = sorted(tuple(row) for row in a.bonds.as_array()) if a.bonds is not None else []
    bonds_b = sorted(tuple(row) for row in b.bonds.as_array()) if b.bonds is not None else []
    assert bonds_a == bonds_b, "stored bonds differ"
    for definition in left.condition_provider.definitions:
        cls = definition.condition
        x, y = cls.annotation(a, default="generate"), cls.annotation(b, default="generate")
        if definition.kind == "pair":
            np.testing.assert_equal(x.pairs, y.pairs, err_msg=definition.key)
            np.testing.assert_allclose(x.values, y.values, atol=0.001, rtol=0, equal_nan=True)
        elif np.asarray(x).dtype.kind in "fc":
            np.testing.assert_allclose(x, y, atol=0.001, rtol=0, equal_nan=True, err_msg=definition.key)
        else:
            np.testing.assert_equal(x, y, err_msg=definition.key)
        mx, my = cls.mask(a, default="generate"), cls.mask(b, default="generate")
        if definition.kind == "pair":
            np.testing.assert_equal(mx.pairs, my.pairs, err_msg=definition.key)
            np.testing.assert_equal(mx.values, my.values, err_msg=definition.key)
        else:
            np.testing.assert_equal(mx, my, err_msg=definition.key)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--hosts", nargs="+", default=["molstar", "patinae", "vscode-molstar", "vscode-patinae"])
    parser.add_argument("--reference", default="pymol")
    parser.add_argument("--strict-renderers", action="store_true")
    args = parser.parse_args()
    cases = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/workflow_cases.json").read_text())
    cases += json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/nim_workflow_cases.json").read_text())
    if args.strict_renderers:
        for host in args.hosts:
            receipt = json.loads((args.directory / f"{host}-renderers.json").read_text())
            expected = "patinae" if host.endswith("patinae") else "molstar"
            assert receipt["strict"] and receipt["requested"] == expected, f"{host}: not a strict run"
            assert receipt["observed"] and set(receipt["observed"]) == {expected}, f"{host}: renderer fallback"
    providers = load_providers()
    host_actions = (
        {host: json.loads((args.directory / f"{host}-actions.json").read_text()) for host in args.hosts}
        if args.reference == "pymol"
        else {}
    )
    checks = 0
    for case in cases:
        if args.reference == "pymol":
            actions = json.loads((args.directory / f"pymol-{case['name']}-actions.json").read_text())
            assert len(actions) == len(case["actions"])
            for host in args.hosts:
                actual = [item for item in host_actions[host] if item["scenario"] == case["name"]]
                assert len(actual) == len(actions), f"{host}: missing workflow actions"
                for expected, observed in zip(actions, actual, strict=True):
                    for key in ("step", "action", "indices"):
                        assert expected[key] == observed[key], f"{host}/{case['name']}: {key} differs"
                    if expected["action"] != "realize":
                        assert expected["atoms"] == observed["atoms"]
        stages = [
            "00",
            "saved",
            "reopened",
            *(f"{i:02d}" for i, action in enumerate(case["actions"], 1) if action["kind"] != "realize"),
        ]
        documents = {
            (host, stage): document(args.directory / f"{host}-{case['name']}-{stage}.cif", providers)
            for host in [args.reference, *args.hosts]
            for stage in stages
        }
        for stage in stages:
            native = documents[args.reference, stage]
            for host in args.hosts:
                actual = documents[host, stage]
                try:
                    compare(native, actual)
                except AssertionError as error:
                    raise AssertionError(f"{host} / {case['name']} / {stage}: {error}") from error
                checks += 1
        for host in [args.reference, *args.hosts]:
            compare(documents[host, "saved"], documents[host, "reopened"])
        print(f"{case['name']}: {args.reference} and {', '.join(args.hosts)} outputs agree")
    print(
        f"{checks} cross-interface comparisons: atom identity, coordinates, bonds, charges, "
        "segment bounds, all condition values/masks"
    )


if __name__ == "__main__":
    main()
