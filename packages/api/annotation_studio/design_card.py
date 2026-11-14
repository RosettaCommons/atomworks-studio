"""Optional design-card mode for the Gradio host: the same card the browser page has, in Studio's own sidebar.

A provider that implements `design_card()` opts in. The host then shows only Studio's editor (the card is inside it,
as on the RFD4-Proteina page) and no Gradio controls; the card's Generate and Refold requests travel from the editor
frame to this page and through the hidden bus component to Python, so Gradio's queue (and ZeroGPU's quota and token)
see them as any other click. A provider without `design_card` is untouched. The contract is written down in
docs/INTEGRATIONS.md, "Design card".
"""

import json
from typing import Any

# What the card offers when the provider says nothing: the reference page's controls and defaults, the same ones
# Studio's own card falls back on (packages/web/src/design-card). A provider overrides a setting key by key, or sets a
# key to None when its engine does not take it: the card then hides that control.
DEFAULT_CARD_SETTINGS: dict[str, Any] = {
    "samples": {"min": 1, "max": 8, "default": 1},
    "thinking": {"options": ["none", "low", "medium", "high"], "default": "none"},
    "seed": True,
    "partialDiffusion": {"percent": 40},
    "backboneK": {"min": 1, "max": 20, "step": 0.1, "default": 16},
    "latentK": {"min": 1, "max": 6, "step": 0.1, "default": 4},
    "earlyStop": {"default": True},
}

# The card's setting names, and the option names a provider written for the Gradio controls already validates.
_OPTION_NAMES = {
    "samples": "samples",
    "thinking": "thinking",
    "seed": "seed",
    "backboneK": "backbone_k",
    "latentK": "latent_k",
    "earlyStop": "early_stop",
}


def card_config(provider: Any) -> dict[str, Any] | None:
    """The provider's card as JSON-safe data, or None when it does not opt in.

    `design_card()` returns `{"engine": {"badge": "ZeroGPU"}, "settings": {...}, "guide": {"url": "..."}}`; `settings`
    overrides `DEFAULT_CARD_SETTINGS` per key (None drops a control), `guide` makes the card show its Guide button:
    `{"url": "/help/index.html"}` (or the bare string) is a guide page the card fetches and shows as a popup over the
    designer, by itself, in the editor frame (so the address is relative to this host's origin, where `create_app`'s
    `guide_dir` serves it); `True` is a button the host's own page answers (the frame sends `guide` to it).
    """
    hook = getattr(provider, "design_card", None)
    given = hook() if hook is not None else None
    if given is None:
        return None
    engine = dict(given.get("engine") or {})
    if not engine.get("badge"):
        raise ValueError("design_card() needs engine.badge, the label the card shows beside its title")
    settings: dict[str, Any] = {
        key: (dict(value) if isinstance(value, dict) else value) for key, value in DEFAULT_CARD_SETTINGS.items()
    }
    for key, value in (given.get("settings") or {}).items():
        if key not in settings:
            raise ValueError(f"Unknown design-card setting {key!r}; choose from {sorted(settings)}")
        settings[key] = dict(value) if isinstance(value, dict) else value
    thinking = settings["thinking"]
    if isinstance(thinking, dict) and thinking.get("default") not in thinking["options"]:
        thinking["default"] = thinking["options"][0]
    # The card reads `false` as "this engine does not take it": the control is hidden and left out of the request.
    settings = {key: (False if value is None else value) for key, value in settings.items()}
    config: dict[str, Any] = {"engine": engine, "settings": settings}
    guide = given.get("guide")
    if guide:
        config["guide"] = True
        url = guide.get("url") if isinstance(guide, dict) else (guide if isinstance(guide, str) else None)
        if url:
            config["guideUrl"] = str(url)
    return json.loads(json.dumps(config))


def card_options(provider: Any, settings: dict) -> dict:
    """The card's run settings as the options `provider.validate` takes.

    A provider with `card_options(settings)` maps them itself; otherwise each card setting becomes the option of the
    same name in snake_case, and a setting the card does not send is left out (the provider's own default applies).
    `partialDiffusion` arrives as the percent, or null when partial diffusion is off.
    """
    hook = getattr(provider, "card_options", None)
    if hook is not None:
        return hook(dict(settings))
    options = {_OPTION_NAMES[key]: value for key, value in settings.items() if key in _OPTION_NAMES}
    if "partialDiffusion" in settings:
        percent = settings["partialDiffusion"]
        options["partial_diffusion"] = percent is not None
        if percent is not None:
            options["partial_diffusion_percent"] = percent
    return options


# What judges a design in the Refold panel, from the task the card read (the page's `criteriaKind`, without the
# chain details only the browser engine has): binders and antibodies by their own criteria, a design of new protein only
# by the monomer's, and jobs with ligands or motifs by numbers alone.
_KIND_BY_TASK = {"binder": "binder", "antibody": "antibody"}
_MONOMER_TASKS = ("unconditional", "empty", "fold", "redesign_all", "inverse", "partial")


def design_kind(task: str | None) -> str | None:
    return _KIND_BY_TASK.get(task or "") or ("monomer" if task in _MONOMER_TASKS else None)


# The browser half, in the page that holds the editor frame (opened with `?embed=1&card=1&parent_origin=`): the card
# inside speaks Studio's design-card frame protocol (docs/INTEGRATIONS.md, "Design card in a frame"). Its `generate` and
# `refold` requests go to Python through the bus (the hidden component of the Refold bridge) and the answers come back
# the same way, as the `design`, `done`, `error` and `refold-*` messages the card expects. Only the editor's own
# frame, from this origin, is believed.
BRIDGE_JS = """
const config = __CONFIG__;
const kinds = __KINDS__;
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
  const FRAME = 'atomworks-studio';
  const HOST = 'atomworks-design-host';
  const pending = new Map();
  let counter = 0;
  const reply = (type, body = {}) =>
    frame()?.contentWindow?.postMessage({ source: HOST, type, ...body }, location.origin);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.origin !== location.origin || event.source !== frame()?.contentWindow) return;
    if (!data || data.source !== FRAME || data.channel !== 'design-card') return;
    if (data.type === 'hello') {
      reply('config', config);
    } else if (data.type === 'generate') {
      const request = 'g' + (++counter);
      const { sessionId, settings = {}, task } = data.request || {};
      pending.set(request, { kind: 'generate', id: data.id, seed: settings.seed, task });
      reply('status', { id: data.id, text: 'Waiting for the GPU…' });
      bus.emit('card_generate', { request, session_id: sessionId, settings });
    } else if (data.type === 'refold') {
      const request = 'r' + (++counter);
      pending.set(request, { kind: 'refold', id: data.id });
      bus.emit('refold', { request, cif: data.design?.cif, options: data.settings });
    } else if (data.type === 'guide') {
      // Only a card configured with `guide: true` and no address asks the page; one with an address shows the guide
      // itself, in the frame. A deployment that wants its own Guide listens for this event.
      window.dispatchEvent(new CustomEvent('atomworks-design-guide'));
    } else if (data.type === 'abort') {
      // Stop abandons the wait; the server finishes the call it has started.
      for (const [request, entry] of pending) if (entry.id === data.id) pending.delete(request);
    }
  });
  bus.listeners.add((message) => {
    const entry = pending.get(message.request);
    if (!entry) return;
    pending.delete(message.request);
    if (message.type === 'generated') {
      if (message.error) {
        reply('error', { id: entry.id, message: message.error, userMessage: message.error });
        return;
      }
      for (const [index, design] of message.designs.entries()) {
        // The first design takes the typed or drawn seed, later ones the next integers, as the page names them.
        const seed = entry.seed != null ? entry.seed + index : null;
        const name = seed != null ? String(seed) : design.name;
        reply('design', { id: entry.id, design: {
          name, cif: design.cif, seed, kind: kinds[entry.task] ?? null,
          filenameStem: 'design-' + name,
        } });
      }
      reply('done', { id: entry.id, result: { message: (message.warnings || []).join('; ') || undefined } });
    } else if (message.type === 'result') {
      if (message.error) reply('refold-error', { id: entry.id, message: message.error });
      else reply('refold-result', { id: entry.id, result: message.result });
    }
  });
})();
"""


def bridge_js(config: dict[str, Any]) -> str:
    """`BRIDGE_JS` with the card's configuration (the `config` message the frame asks for) filled in."""
    kinds = {task: design_kind(task) for task in ("binder", "antibody", *_MONOMER_TASKS)}
    return BRIDGE_JS.replace("__CONFIG__", json.dumps(config)).replace("__KINDS__", json.dumps(kinds))
