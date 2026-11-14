"""Preview the real Gradio generation UI locally without loading a model."""

import argparse
import math
import os
import random
import time
from pathlib import Path


def helix_cif(residues: int, settle: float, models: int = 1, offset: float = 0.0) -> str:
    """A helix-like backbone (N, CA, C) of one chain; `settle` 0 is a noisy blob, 1 a clean helix. Models 1..models."""
    rows = [
        "data_stream_frame",
        "loop_",
        *(
            f"_atom_site.{field}"
            for field in (
                "group_PDB id type_symbol label_atom_id label_alt_id label_comp_id label_asym_id label_entity_id "
                "label_seq_id pdbx_PDB_ins_code Cartn_x Cartn_y Cartn_z occupancy B_iso_or_equiv auth_seq_id "
                "auth_comp_id auth_asym_id auth_atom_id pdbx_PDB_model_num"
            ).split()
        ),
    ]
    atom = 0
    for model in range(1, models + 1):
        rng = random.Random(model * 7919 + int(offset))
        for residue in range(residues):
            angle = residue * 100 * math.pi / 180
            for name, element, shift in (("N", "N", -0.5), ("CA", "C", 0.0), ("C", "C", 0.5)):
                spread = (1 - settle) * 6
                x = 2.3 * math.cos(angle) + shift + rng.uniform(-spread, spread)
                y = 2.3 * math.sin(angle) + rng.uniform(-spread, spread)
                z = 1.5 * residue + shift + rng.uniform(-spread, spread)
                atom += 1
                rows.append(
                    f"ATOM {atom} {element} {name} . ALA A 1 {residue + 1} ? {x:.3f} {y:.3f} {z:.3f} 1.00 80.00 "
                    f"{residue + 1} ALA A {name} {model}"
                )
    return "\n".join(rows) + "\n#\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--delay", type=float, default=20, help="Seconds to show the generation animation")
    parser.add_argument("--fail", action="store_true", help="Preview generation failure instead of returning the input")
    parser.add_argument(
        "--refold",
        action="store_true",
        help="Also offer Studio's Refold panel, with a simulated refold (no model runs)",
    )
    parser.add_argument(
        "--card",
        action="store_true",
        help="Show the design card (the RFD4-Proteina page's interface) in Studio's sidebar, with simulated generation",
    )
    parser.add_argument("--no-guide", action="store_true", help="With --card: a card with no Guide button")
    parser.add_argument(
        "--stream",
        action="store_true",
        help="With --card: simulate a streaming model (live frames, then designs with a trajectory each)",
    )
    parser.add_argument(
        "--replay",
        metavar="DIR",
        help="With --stream: replay frames captured from a real run instead of simulated helices: DIR holds "
        "frame_*.cif (live frames, in name order), design.cif and trajectory.cif",
    )
    parser.add_argument("--frame-delay", type=float, default=0.15, help="Seconds between simulated live frames")
    parser.add_argument("--steps", type=int, default=12, help="Simulated sampling steps")
    parser.add_argument("--residues", type=int, default=40, help="Residues of the simulated design")
    parser.add_argument("--refold-delay", type=float, default=1.5, help="Seconds each simulated refold takes")
    args = parser.parse_args()
    if args.delay < 0:
        parser.error("--delay must be non-negative")

    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "false")

    import uvicorn
    from annotation_studio.gradio import create_app
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0), card=args.card)
    provider.title = (
        "RFD4-Proteina · local UI preview\n\n"
        f"Simulated generation: waits {args.delay:g} seconds, then "
        + ("reports a test error." if args.fail else "returns the unchanged input. No model runs.")
    )

    def simulate(cif, options):
        time.sleep(args.delay)
        if args.fail:
            raise RuntimeError("Simulated generation failure")
        return [cif] * options["samples"]

    def simulate_stream(cif, options):
        """The streaming convention: frames of design 0 as the run goes, then the designs and their trajectories."""
        samples, steps, residues = options["samples"], args.steps, args.residues
        if args.replay:
            folder = Path(args.replay)
            frames = sorted(folder.glob("frame_*.cif"), key=lambda f: int(f.stem.rsplit("_", 1)[-1]))
            for step, file in enumerate(frames):
                time.sleep(args.frame_delay)
                yield {
                    "frame": file.read_text(),
                    "step": step,
                    "steps": len(frames) + 1,
                    "design": 0,
                    "designs": samples,
                }
            design, trajectory = (folder / "design.cif").read_text(), (folder / "trajectory.cif").read_text()
            yield {
                "done": True,
                "designs": [design] * samples,
                "trajectories": [trajectory] * samples,
                "steps_run": [len(frames) + 1] * samples,
                "nsteps": len(frames) + 1,
            }
            return
        for step in range(steps):
            time.sleep(args.frame_delay)
            yield {
                "frame": helix_cif(residues, (step + 1) / steps),
                "step": step,
                "steps": steps,
                "design": 0,
                "designs": samples,
                "name": f"step_{step + 1}.cif",
                "keep_camera": step > 0,
            }
        if args.fail:
            raise RuntimeError("Simulated generation failure")
        yield {
            "done": True,
            "designs": [helix_cif(residues, 1.0, offset=k) for k in range(samples)],
            "trajectories": [helix_cif(residues, 1.0, models=steps, offset=k) for k in range(samples)],
            "steps_run": [steps] * samples,
            "nsteps": steps,
        }

    refold_fn = None
    if args.card:
        if not args.no_guide:
            # The Guide button shows this directory's index.html, served by the app itself at /help/ (create_app reads
            # the provider's guide_dir), as a deployment with its own guide does.
            provider.guide_dir = str(Path(__file__).resolve().parents[1] / "packages/web/tests/fixtures/guide")
    if args.refold or args.card:
        provider.refold_models = lambda: [{"id": "af3"}, {"id": "openbind0"}]

        def refold_fn(cif, options):
            """Hand the design back as its own refold, with numbers that depend on the seed so each run differs."""
            time.sleep(args.refold_delay)
            return {
                "cif": cif,
                "metrics": {"rmsd": 0.8 + (options["seed"] % 7) / 2, "plddt": 90.0 - options["recycles"]},
                "text": f"{options['model']} refold (simulated)",
            }

    uvicorn.run(
        create_app(
            provider=provider,
            generate_fn=simulate,
            generate_stream_fn=simulate_stream if args.card and args.stream else None,
            refold_fn=refold_fn,
        ),
        host="127.0.0.1",
        port=args.port,
    )


if __name__ == "__main__":
    main()
