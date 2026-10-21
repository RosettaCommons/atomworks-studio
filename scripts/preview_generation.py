"""Preview the real Gradio generation UI locally without loading a model."""

import argparse
import os
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--delay", type=float, default=20, help="Seconds to show the generation animation")
    parser.add_argument("--fail", action="store_true", help="Preview generation failure instead of returning the input")
    args = parser.parse_args()
    if args.delay < 0:
        parser.error("--delay must be non-negative")

    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "false")

    import uvicorn
    from annotation_studio.gradio import create_app
    from atomworks_studio_rfd4.generation import RFD4GenerationProvider

    provider = RFD4GenerationProvider(k_defaults=(16.0, 4.0))
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

    uvicorn.run(create_app(provider=provider, generate_fn=simulate), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
