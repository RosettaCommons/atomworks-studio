"""RFD4 controls for Studio's optional Gradio generation host; no model runtime."""

from typing import Literal

import gradio as gr
from pydantic import BaseModel, ConfigDict, Field

TASKS = {
    "unconditional": "Protein design",
    "motif_scaffolding": "Motif scaffolding",
    "enzyme_design": "Enzyme design",
    "small_molecule_binder": "Small-molecule binder",
    "antibody_design": "Antibody / VHH",
    "partial_diffusion": "Partial diffusion (40%)",
    "inverse_folding": "Inverse folding",
}


class GenerationOptions(BaseModel):
    """Bounded options shared by the UI and model adapter."""

    model_config = ConfigDict(extra="forbid", strict=True)
    task: Literal[
        "unconditional",
        "motif_scaffolding",
        "enzyme_design",
        "small_molecule_binder",
        "antibody_design",
        "partial_diffusion",
        "inverse_folding",
    ] = "unconditional"
    thinking: Literal["low", "medium", "high"] = "medium"
    samples: int = Field(default=1, ge=1, le=8)
    seed: int = Field(default=42, ge=0, lt=2**32)
    backbone_noise: float | None = Field(default=None, gt=0, le=1)
    latent_noise: float | None = Field(default=None, gt=0, le=1)


class RFD4GenerationProvider:
    """Present model options; the deployment supplies a CIF-to-CIF callback."""

    title = "RFD4-Proteina"
    warning_checks = frozenset({"missing_atoms"})

    def __init__(self, *, noise_defaults: tuple[float, float]):
        self.noise_defaults = noise_defaults

    def controls(self) -> dict[str, gr.Component]:
        with gr.Row():
            task = gr.Dropdown(
                choices=[(label, key) for key, label in TASKS.items()], value="unconditional", label="Task", scale=3
            )
            thinking = gr.Radio(["low", "medium", "high"], value="medium", label="Thinking", scale=2, min_width=260)
            samples = gr.Number(value=1, precision=0, minimum=1, maximum=8, label="Designs")
            seed = gr.Number(value=42, precision=0, minimum=0, maximum=2**32 - 1, label="Seed")
        with gr.Accordion("Sampling", open=False), gr.Row():
            backbone_noise = gr.Slider(0.01, 1, value=self.noise_defaults[0], step=0.01, label="Backbone noise")
            latent_noise = gr.Slider(
                0.01, 1, value=self.noise_defaults[1], step=0.01, label="Sequence / side-chain latent noise"
            )
        for slider in (backbone_noise, latent_noise):
            slider.change(None, slider, slider, js="value => value", queue=False)
        return dict(
            task=task,
            thinking=thinking,
            samples=samples,
            seed=seed,
            backbone_noise=backbone_noise,
            latent_noise=latent_noise,
        )

    def validate(self, options: dict) -> dict:
        return GenerationOptions.model_validate(options).model_dump()

    def example_options(self, example: dict) -> dict:
        return {"task": GenerationOptions(task=example["task"]).task}
