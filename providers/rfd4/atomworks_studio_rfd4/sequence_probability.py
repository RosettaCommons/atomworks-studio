"""Sequence-probability input validation, independent of the model runtime.

Algorithms extracted from RFD4 a12ccf17f746590b05ebe032ce744af2c7caa485;
scientific condition classes and token vocabulary remain upstream imports.
"""

from dataclasses import dataclass

import numpy as np
from atomworks.constants import STANDARD_AA, STANDARD_DNA, STANDARD_POLYMER_RESIDUES, STANDARD_RNA
from atomworks.io.utils.annotator import ensure_annotations
from atomworks.io.utils.atom_array_plus import as_atom_array_plus
from atomworks.ml.conditions import C_SEQ
from biotite.structure import AtomArray, get_residue_starts, spread_residue_wise

from atomworks_studio_rfd4.model import conditions

SEQUENCE_PROBABILITY_CONDITIONS = getattr(conditions, "SEQUENCE_PROBABILITY_CONDITIONS", ())


@dataclass
class InvariantViolation:
    """A single invariant violation detected in a pipeline batch."""

    check: str
    message: str
    count: int = 1


def check_sequence_probability_conditioning_violations(aa: AtomArray) -> list[InvariantViolation]:
    """Validate sparse canonical-polymer probability conditions residue by residue.

    A unified sequence-token probability is present wherever its value is not NaN. Present
    values must be finite and in [0, 1], positive mass may only target identities
    of the residue's polymer type, and the specified mass may not exceed one;
    unspecified identities retain the remaining probability mass. A
    ``C_SEQ``-conditioned residue must carry the complete exact distribution;
    identities outside the canonical vocabulary have zero mass in these channels.
    """

    aap = as_atom_array_plus(aa)
    residue_starts = get_residue_starts(aap)
    n_residues = len(residue_starts)
    probabilities = np.zeros((n_residues, len(SEQUENCE_PROBABILITY_CONDITIONS)), dtype=np.float32)
    specified = np.zeros_like(probabilities, dtype=bool)
    violations: list[InvariantViolation] = []

    for channel, condition in enumerate(SEQUENCE_PROBABILITY_CONDITIONS):
        if not condition.has_annotation(aap):
            continue

        atom_probabilities = condition.annotation(aap, default="raise")
        atom_mask = condition.mask(aap, default="raise")
        expected_mask = spread_residue_wise(aap, atom_mask[residue_starts])
        n_nonuniform_masks = int(
            np.add.reduceat((atom_mask != expected_mask).astype(np.int64), residue_starts).astype(bool).sum()
        )
        if n_nonuniform_masks:
            violations.append(
                InvariantViolation(
                    check="sequence_probability_nonuniform_residue_mask",
                    message=f"{condition.name} has a nonuniform mask in {n_nonuniform_masks} residue(s)",
                    count=n_nonuniform_masks,
                )
            )

        expected_values = spread_residue_wise(aap, atom_probabilities[residue_starts])
        inconsistent = atom_mask & ~np.isclose(atom_probabilities, expected_values, equal_nan=True)
        n_nonuniform_values = int(np.maximum.reduceat(inconsistent, residue_starts).sum())
        if n_nonuniform_values:
            violations.append(
                InvariantViolation(
                    check="sequence_probability_nonuniform_residue_value",
                    message=f"{condition.name} has nonuniform values in {n_nonuniform_values} residue(s)",
                    count=n_nonuniform_values,
                )
            )

        probabilities[:, channel] = atom_probabilities[residue_starts]
        specified[:, channel] = atom_mask[residue_starts]

    seq_conditioned = C_SEQ.mask(aap, default="generate")[residue_starts]
    if not specified.any() and not seq_conditioned.any():
        return violations

    finite = np.isfinite(probabilities)
    n_nonfinite = int((specified & ~finite).sum())
    if n_nonfinite:
        violations.append(
            InvariantViolation(
                check="sequence_probability_nonfinite",
                message=f"{n_nonfinite} specified sequence probability value(s) are not finite",
                count=n_nonfinite,
            )
        )

    out_of_range = specified & finite & ((probabilities < 0.0) | (probabilities > 1.0))
    n_out_of_range = int(out_of_range.sum())
    if n_out_of_range:
        violations.append(
            InvariantViolation(
                check="sequence_probability_out_of_range",
                message=f"{n_out_of_range} specified sequence probability value(s) fall outside [0, 1]",
                count=n_out_of_range,
            )
        )

    ensure_annotations(
        aap,
        "is_standard_unknown_or_masked_aa",
        "is_standard_unknown_or_masked_rna",
        "is_standard_unknown_or_masked_dna",
    )
    compatibility_by_token = {
        token: residue_mask
        for tokens, residue_mask in (
            (STANDARD_AA, aap.is_standard_unknown_or_masked_aa[residue_starts]),
            (STANDARD_RNA, aap.is_standard_unknown_or_masked_rna[residue_starts]),
            (STANDARD_DNA, aap.is_standard_unknown_or_masked_dna[residue_starts]),
        )
        for token in tokens
    }
    compatible = np.column_stack(
        [compatibility_by_token[condition.token_name] for condition in SEQUENCE_PROBABILITY_CONDITIONS]
    )
    wrong_token_type = specified & finite & (probabilities > 0.0) & ~compatible
    n_wrong_token_type = int(wrong_token_type.sum())
    if n_wrong_token_type:
        violations.append(
            InvariantViolation(
                check="sequence_probability_wrong_token_type",
                message=(
                    f"{n_wrong_token_type} positive sequence probability value(s) target identities "
                    "from a different polymer type"
                ),
                count=n_wrong_token_type,
            )
        )

    specified_mass = np.where(specified & finite, probabilities, 0.0).sum(axis=-1)
    exceeds_one = specified_mass > 1.0 + 1e-6
    n_exceeds_one = int(exceeds_one.sum())
    if n_exceeds_one:
        violations.append(
            InvariantViolation(
                check="sequence_probability_sum_exceeds_one",
                message=f"specified sequence probabilities sum above 1 on {n_exceeds_one} residue(s)",
                count=n_exceeds_one,
            )
        )

    fully_specified = compatible.any(axis=-1) & (specified | ~compatible).all(axis=-1)
    sequence_targets = C_SEQ.annotation(aap, default="generate")[residue_starts]
    noncanonical_exact = seq_conditioned & ~np.isin(sequence_targets, list(STANDARD_POLYMER_RESIDUES))
    missing_mass = fully_specified & ~noncanonical_exact & (specified_mass < 1.0 - 1e-6)
    n_missing_mass = int(missing_mass.sum())
    if n_missing_mass:
        violations.append(
            InvariantViolation(
                check="sequence_probability_sum_below_one",
                message=f"fully specified sequence probabilities sum below 1 on {n_missing_mass} residue(s)",
                count=n_missing_mass,
            )
        )

    incomplete = seq_conditioned & ~specified.all(axis=-1)
    n_incomplete = int(incomplete.sum())
    if n_incomplete:
        violations.append(
            InvariantViolation(
                check="sequence_probability_incomplete_for_c_seq",
                message=(
                    f"{n_incomplete} C_SEQ-conditioned residue(s) do not have all canonical-polymer "
                    "probabilities explicitly specified"
                ),
                count=n_incomplete,
            )
        )

    expected = np.zeros_like(probabilities)
    for channel, condition in enumerate(SEQUENCE_PROBABILITY_CONDITIONS):
        expected[:, channel] = sequence_targets == condition.token_name
    conflicts = seq_conditioned[:, None] & specified & ~np.isclose(probabilities, expected)
    conflicting_residues = conflicts.any(axis=-1)
    n_conflicting = int(conflicting_residues.sum())
    if n_conflicting:
        violations.append(
            InvariantViolation(
                check="sequence_probability_conflicts_with_c_seq",
                message=f"{n_conflicting} residue(s) have sequence probabilities that conflict with C_SEQ",
                count=n_conflicting,
            )
        )

    return violations


def canonicalize_sequence_probabilities(data: dict) -> dict:
    aap = as_atom_array_plus(data["atom_array"])
    starts = get_residue_starts(aap)
    seq_mask = C_SEQ.mask(aap, default="generate")
    residue_seq = np.maximum.reduceat(seq_mask, starts).astype(bool)
    seq_atoms = spread_residue_wise(aap, residue_seq)
    sequence = C_SEQ.annotation(aap, default="generate")

    resolved: dict[type, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    conflicts: list[str] = []
    for condition in SEQUENCE_PROBABILITY_CONDITIONS:
        probability = condition.annotation(aap, default="generate").astype(np.float32)
        mask = condition.mask(aap, default="generate").copy()
        expected = (sequence == condition.token_name).astype(np.float32)
        conflict = seq_atoms & mask & ~np.isclose(probability, expected)
        if conflict.any():
            n_conflicting_residues = int(np.maximum.reduceat(conflict, starts).sum())
            conflicts.append(f"{condition.token_name}: {n_conflicting_residues} residue(s)")
        resolved[condition] = probability, mask, expected

    if conflicts:
        raise ValueError(
            "Sequence-probability conditioning conflicts with C_SEQ exact identities: " + ", ".join(conflicts)
        )

    for condition, (probability, mask, expected) in resolved.items():
        probability[seq_atoms] = expected[seq_atoms]
        mask[seq_atoms] = True
        probability[~mask] = np.nan
        # Remove stored columns before writing so Biotite preserves the normalized float32 dtype.
        for name in (condition.full_name, *condition.aliases):
            if name in aap.get_annotation_categories():
                aap.del_annotation(name)
        if mask.any():
            condition.set_annotation(aap, probability)

    data["atom_array"] = aap
    return data
