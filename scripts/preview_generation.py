"""Preview the real Gradio generation UI locally without loading a model."""

import argparse
import os
import time
from pathlib import Path


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
        create_app(provider=provider, generate_fn=simulate, refold_fn=refold_fn), host="127.0.0.1", port=args.port
    )


if __name__ == "__main__":
    main()
