"""RFD4 controls for Studio's optional Gradio generation host; no model runtime."""

from typing import Literal

import gradio as gr
from pydantic import BaseModel, ConfigDict, Field

BACKBONE_K_MAX = 20.0
LATENT_K_MAX = 6.0


class GenerationOptions(BaseModel):
    """Bounded options shared by the UI and model adapter."""

    model_config = ConfigDict(extra="forbid", strict=True)
    partial_diffusion: bool = False
    thinking: Literal["low", "medium", "high"] = "medium"
    samples: int = Field(default=1, ge=1, le=8)
    seed: int = Field(default=42, ge=0, lt=2**32)
    partial_diffusion_percent: float = Field(default=70, ge=1, le=100, allow_inf_nan=False)
    backbone_k: float | None = Field(default=None, ge=1, le=BACKBONE_K_MAX, allow_inf_nan=False)
    latent_k: float | None = Field(default=None, ge=1, le=LATENT_K_MAX, allow_inf_nan=False)


class RFD4GenerationProvider:
    """Present model options; the deployment supplies a CIF-to-CIF callback."""

    title = "RFD4-Proteina"
    warning_checks = frozenset({"missing_atoms"})

    def __init__(self, *, k_defaults: tuple[float, float]):
        self.k_defaults = k_defaults

    def controls(self) -> dict[str, gr.Component]:
        with gr.Row():
            thinking = gr.Radio(["low", "medium", "high"], value="medium", label="Thinking", scale=2, min_width=260)
            samples = gr.Number(value=1, precision=0, minimum=1, maximum=8, label="Designs")
            seed = gr.Number(value=42, precision=0, minimum=0, maximum=2**32 - 1, label="Seed")
        with gr.Accordion("Sampling", open=False):
            gr.Markdown(
                "Lower K = higher temperature and more variation. Defaults give stronger low-temperature sampling."
            )
            with gr.Row():
                backbone_k = gr.Slider(
                    1, BACKBONE_K_MAX, value=self.k_defaults[0], step=0.1, label="Backbone K"
                )
                latent_k = gr.Slider(
                    1, LATENT_K_MAX, value=self.k_defaults[1], step=0.1, label="Latents (sequence) K"
                )
            partial_diffusion = gr.Checkbox(value=False, label="Partial diffusion")
            partial_diffusion_percent = gr.Slider(
                1, 100, value=70, step=1, label="Partial diffusion (% of trajectory)", interactive=False,
                elem_id="partial-diffusion-percent",
                info="About 70% is a good starting point. Higher values change the input more. "
                "Requires defined residues: generate an input first or use the partial diffusion example.",
            )
        partial_diffusion.change(
            lambda enabled: gr.update(interactive=enabled),
            partial_diffusion, partial_diffusion_percent, queue=False, api_name=False,
        )
        for slider in (backbone_k, latent_k, partial_diffusion_percent):
            slider.change(None, slider, slider, js="value => value", queue=False)
        return dict(
            thinking=thinking,
            samples=samples,
            seed=seed,
            backbone_k=backbone_k,
            latent_k=latent_k,
            partial_diffusion_percent=partial_diffusion_percent,
            partial_diffusion=partial_diffusion,
        )

    def validate(self, options: dict) -> dict:
        return GenerationOptions.model_validate(options).model_dump()

    def validate_input(self, snapshot: dict, options: dict) -> None:
        if options["partial_diffusion"] and snapshot["has_expandable_segments"]:
            raise gr.Error(
                "Partial diffusion requires defined residues. This input contains expandable segments "
                "with undefined residues. Generate an input first, or use the partial diffusion example."
            )

    def example_options(self, example: dict) -> dict:
        return {"partial_diffusion": False}
