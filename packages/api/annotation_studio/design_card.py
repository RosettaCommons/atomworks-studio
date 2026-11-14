"""Optional design-card mode for the Gradio host: the same card the browser page has, in Studio's own sidebar.

A provider that implements `design_card()` opts in. The host then shows only Studio's editor (the card is inside it,
as on the RFD4-Proteina page) and no Gradio controls; the card's Generate and Refold requests travel from the editor
frame to this page and through the hidden bus component to Python, so Gradio's queue (and ZeroGPU's quota and token)
see them as any other click. A provider without `design_card` is untouched. The contract is written down in
docs/INTEGRATIONS.md, "Design card".
"""

import base64
import json
from typing import Any

# What the card offers when the provider says nothing: the reference page's controls and defaults, the same ones
# Studio's own card falls back on (packages/web/src/design-card). A provider overrides a setting key by key, or sets a
# key to None when its engine does not take it: the card then hides that control.
DEFAULT_CARD_SETTINGS: dict[str, Any] = {
    "samples": {"min": 1, "max": 8, "default": 1},
    "thinking": {"options": ["none", "low", "medium", "high"], "default": "none"},
    "seed": {"min": 0, "max": 2**32 - 1},
    "partialDiffusion": {"percent": {"min": 1, "max": 100, "default": 40}},
    "backboneK": {"min": 1, "max": 20, "step": 0.1, "default": 16},
    "latentK": {"min": 1, "max": 6, "step": 0.1, "default": 4},
    "earlyStop": {"default": True},
}

# The card's setting names, and the option names a provider written for the Gradio controls already validates.
_OPTION_NAMES = {
    "samples": "samples",
    "thinking": "thinking",
    "seed": "seed",
    "partialDiffusion": "partial_diffusion",
    "partialPercent": "partial_diffusion_percent",
    "backboneK": "backbone_k",
    "latentK": "latent_k",
    "earlyStop": "early_stop",
}


def card_config(provider: Any) -> dict[str, Any] | None:
    """The provider's card as JSON-safe data, or None when it does not opt in.

    `design_card()` returns `{"engine": {"badge": "ZeroGPU", "title": "..."}, "settings": {...}}`; `settings` overrides
    `DEFAULT_CARD_SETTINGS` per key (None drops a control).
    """
    hook = getattr(provider, "design_card", None)
    given = hook() if hook is not None else None
    if given is None:
        return None
    engine = dict(given.get("engine") or {})
    if not engine.get("badge"):
        raise ValueError("design_card() needs engine.badge, the label the card shows beside its title")
    settings = {key: (dict(value) if value is not None else None) for key, value in DEFAULT_CARD_SETTINGS.items()}
    for key, value in (given.get("settings") or {}).items():
        if key not in settings:
            raise ValueError(f"Unknown design-card setting {key!r}; choose from {sorted(settings)}")
        settings[key] = dict(value) if value is not None else None
    thinking = settings["thinking"]
    if thinking is not None and thinking.get("default") not in thinking["options"]:
        thinking["default"] = thinking["options"][0]
    return json.loads(json.dumps({"engine": engine, "settings": settings}))


def card_options(provider: Any, settings: dict) -> dict:
    """The card's run settings as the options `provider.validate` takes.

    A provider with `card_options(settings)` maps them itself; otherwise each card setting becomes the option of the
    same name in snake_case, and a setting the card does not send is left out (the provider's own default applies).
    """
    hook = getattr(provider, "card_options", None)
    if hook is not None:
        return hook(dict(settings))
    return {_OPTION_NAMES[key]: value for key, value in settings.items() if key in _OPTION_NAMES}


def frame_config(config: dict[str, Any]) -> str:
    """The card's configuration as the editor frame's `card` query value (URL-safe base64 of compact JSON)."""
    raw = json.dumps(config, separators=(",", ":"), sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# The browser half, in the page that holds the editor frame. The card inside the frame posts `generate` and `refold`
# requests here; they go to Python through the bus (the hidden component of the Refold bridge) and the answers come back
# the same way. Only the editor's own frame, from this origin, is believed.
BRIDGE_JS = """
const frame = () => document.querySelector('iframe[title="AtomWorks Studio"]');
(async () => {
  const until = async (test, ms = 60000) => {
    const start = Date.now();
    for (;;) {
      const value = test();
      if (value) return value;
      if (Date.now() - start > ms) throw new Error('timed out waiting for the bus');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const bus = await until(() => window.__studioRefoldBus);
  const SOURCE = 'atomworks-design-card';
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.origin !== location.origin || event.source !== frame()?.contentWindow) return;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'generate') {
      bus.emit('card_generate', { request: data.request, session_id: data.sessionId, settings: data.settings });
    } else if (data.type === 'refold') {
      bus.emit('refold', { request: data.request, cif: data.cif, options: data.options });
    }
  });
  bus.listeners.add((message) => {
    if (message.type !== 'result' && message.type !== 'generated') return;
    frame()?.contentWindow?.postMessage({ source: SOURCE + '-host', ...message }, location.origin);
  });
})();
"""
