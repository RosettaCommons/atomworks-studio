"""Optional refold support for the Gradio host: validation, result shaping, and the browser bridge to Studio's panel.

A deployment that can fold a design again (AlphaFold 3 or OpenFold 3 through RFD4's oracle, on a GPU) gives the host
a `refold_fn` and a provider that names the models it offers (`refold_models`). The host then shows Studio's Refold
panel beside the editor and serves `/refold_cif` for scripts. Everything here is inert for a provider that implements
none of it. The contract is written down in docs/INTEGRATIONS.md, "Refold panel".
"""

import json
import math
from typing import Any

# What the panel offers when the provider names no limits: the browser page's reference values, and the same ones
# Studio's own panel falls back on (packages/web/src/refold/session.ts DEFAULT_LIMITS). tests/test_refold.py keeps
# the two in step.
DEFAULT_REFOLD_LIMITS: dict[str, Any] = {
    "seed": {"min": 0, "max": 2**32 - 1, "default": 0},
    "recycles": {"options": [0, 1, 2, 3, 5, 10], "default": 3},
    "steps": {"options": [25, 50, 100, 200], "default": 25},
}

# A design is a model output, not an upload, but the route is reachable by scripts: bound what it will accept.
MAX_REFOLD_CIF_BYTES = 10 * 1024 * 1024

_METRIC_KEYS = {
    "rmsd": "rmsd",
    "placed_rmsd": "placedRmsd",
    "plddt": "plddt",
    "ptm": "ptm",
    "iptm": "iptm",
    "chain_ptm": "chainPtm",
    "min_ipae": "minIpae",
    "motif_rmsd": "motifRmsd",
    "motif_backbone_rmsd": "motifBackboneRmsd",
}


def refold_models(provider: Any) -> list[dict]:
    """The provider's refold models as JSON-safe dicts, or [] when it offers none."""
    hook = getattr(provider, "refold_models", None)
    models = list(hook()) if hook is not None else []
    out = []
    for model in models:
        entry = {"id": model} if isinstance(model, str) else dict(model)
        if not entry.get("id"):
            raise ValueError("A refold model needs an id")
        out.append(json.loads(json.dumps(entry)))
    return out


def refold_limits(provider: Any) -> dict[str, Any]:
    """The choices the panel offers and validation enforces: the provider's over Studio's defaults, per setting."""
    hook = getattr(provider, "refold_limits", None)
    given = dict(hook()) if hook is not None else {}
    limits = {key: dict(value) for key, value in DEFAULT_REFOLD_LIMITS.items()}
    for key, value in given.items():
        if key == "model":
            limits["model"] = dict(value)
        elif key in limits:
            limits[key].update(value)
        else:
            raise ValueError(f"Unknown refold limit {key!r}")
    for key in ("recycles", "steps"):
        options = limits[key]["options"]
        if not options or not all(isinstance(n, int) and not isinstance(n, bool) for n in options):
            raise ValueError(f"refold limit {key!r} needs a list of integers")
        if limits[key]["default"] not in options:
            limits[key]["default"] = options[0]
    return limits


def validate_refold_options(options: dict, models: list[dict], limits: dict[str, Any]) -> dict:
    """Check `{model, seed, recycles, steps}` against what the panel offers; fill what is missing with the defaults."""
    unknown = set(options) - {"model", "seed", "recycles", "steps"}
    if unknown:
        raise ValueError(f"Unknown refold options: {sorted(unknown)}")
    ids = [model["id"] for model in models]
    default_model = limits.get("model", {}).get("default")
    model = options.get("model", default_model if default_model in ids else ids[0])
    if model not in ids:
        raise ValueError(f"Unknown refold model {model!r}; choose from {ids}")

    def whole(name: str, value: Any) -> int:
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or (isinstance(value, float) and not value.is_integer())
        ):
            raise ValueError(f"refold {name} must be a whole number")
        return int(value)

    seed = whole("seed", options.get("seed", limits["seed"]["default"]))
    if not limits["seed"]["min"] <= seed <= limits["seed"]["max"]:
        raise ValueError(f"refold seed must be between {limits['seed']['min']} and {limits['seed']['max']}")
    checked = {"model": model, "seed": seed}
    for name in ("recycles", "steps"):
        value = whole(name, options.get(name, limits[name]["default"]))
        if value not in limits[name]["options"]:
            raise ValueError(f"refold {name} must be one of {limits[name]['options']}")
        checked[name] = value
    return checked


def _number(value: Any) -> float | None:
    """A JSON-safe number: NaN and infinity (a metric that does not apply) become None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def check_design_cif(cif: Any) -> str:
    if not isinstance(cif, str) or not cif.strip():
        raise ValueError("Give the design as a CIF string")
    if len(cif.encode()) > MAX_REFOLD_CIF_BYTES:
        raise ValueError("The design CIF is too large to refold")
    return cif


def shape_refold_result(raw: Any) -> dict:
    """The deployment's result as the route returns it.

    `refold_fn` returns a dict: `cif` (the refold's polymer chains in the design's frame, required), optionally
    `ligand_cif`, `metrics` (`rmsd`, `placed_rmsd`, `plddt`, `ptm`, `iptm`, `chain_ptm`, `min_ipae`, ...; a number
    that does not apply is None or NaN), `text` (one line describing it) and `passed` (a verdict, when the
    deployment judges the design itself).
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("cif"), str) or not raw["cif"].strip():
        raise ValueError("The refold returned no structure")
    metrics = raw.get("metrics") or {}
    result: dict[str, Any] = {
        "cif": raw["cif"],
        "ligand_cif": raw.get("ligand_cif") or None,
        "metrics": {key: _number(value) for key, value in metrics.items()},
        "text": str(raw["text"]) if raw.get("text") else None,
        "passed": raw["passed"] if isinstance(raw.get("passed"), bool) else None,
    }
    return result


def panel_result(result: dict) -> dict:
    """`shape_refold_result`'s output as the panel's `RefoldResult` (camelCase, `pass` for `passed`)."""
    return {
        "cif": result["cif"],
        "ligandCif": result["ligand_cif"],
        "metrics": {_METRIC_KEYS.get(key, _camel(key)): value for key, value in result["metrics"].items()},
        "text": result["text"],
        "pass": result["passed"],
    }


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def panel_message(kind: str, **fields: Any) -> str:
    """A message for the bridge component: JSON, which changes on every call so the browser hears each one."""
    return json.dumps({"type": kind, **fields}, separators=(",", ":"))


# The browser half. `bus` is a hidden component the browser and Python talk through (Gradio carries each event over
# its queue, so ZeroGPU and progress behave as for any other click); `host` mounts Studio's own panel beside the editor.
BUS_JS = """
// Events the page raises: 'refold' (fold one design) and 'open_design' (a row of the panel was chosen).
const bus = window.__studioRefoldBus = {listeners: new Set(), emit: (name, data) => trigger(name, data)};
watch('value', () => {
  let message;
  try { message = JSON.parse(props.value); } catch { return; }
  for (const listener of bus.listeners) listener(message);
});
"""

HOST_JS = """
const config = __CONFIG__;
const until = async (test, ms = 60000) => {
  const start = Date.now();
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error('timed out waiting for the editor');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const frame = () => document.querySelector('iframe[title="AtomWorks Studio"]');
// The editor shows a session once the frame has said so and drawn it.
const editorShows = async (id) => {
  if (!id) return;
  await until(() => frame()?.dataset.sessionId === id);
  await until(() => Number(frame()?.contentDocument?.querySelector('#viewer')?.dataset.renderedAtoms) > 0);
};
(async () => {
  const [{ mountRefoldPanel }, bus] = await Promise.all([import(config.module), until(() => window.__studioRefoldBus)]);
  const requests = new Map();
  let counter = 0;
  const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const provider = {
    models: config.models,
    limits: config.limits,
    refold: (design, settings, { signal, onStatus }) => new Promise((resolve, reject) => {
      const request = 'r' + (++counter);
      onStatus({ text: 'waiting for the GPU' });
      requests.set(request, (message) => {
        requests.delete(request);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      });
      // Stop abandons the wait; the server finishes the fold it has started.
      signal.addEventListener('abort', () => { requests.delete(request); reject(new Error('aborted')); });
      bus.emit('refold', { request, cif: design.cif, options: { ...settings } });
    }),
  };
  // In a shadow root, so Gradio's own styles for buttons, tables and inputs do not reach the panel.
  const mount = document.createElement('div');
  element.attachShadow({ mode: 'open' }).append(mount);
  const panel = mountRefoldPanel(mount, provider, {
    nameHeader: config.nameHeader,
    theme: document.body.classList.contains('dark') ? 'dark' : 'light',
    overlay: async (key, cif, options) => {
      await until(() => frame()?.contentWindow?.atomworksStudio);
      await frame().contentWindow.atomworksStudio.setOverlay(key, cif, options);
    },
    onSelect: async (id) => { bus.emit('open_design', { id }); await editorShows(id); },
  });
  bus.listeners.add(async (message) => {
    if (message.type === 'result') requests.get(message.request)?.(message);
    else if (message.type === 'designs') {
      panel.setDesigns(message.designs);
      await editorShows(message.selected);
      await panel.setSelected(message.selected);
    } else if (message.type === 'selected') {
      await editorShows(message.id);
      await panel.setSelected(message.id);
    }
  });
  // The editor's frame is replaced when another design is opened: draw the refold over the new one.
  window.addEventListener('message', async (event) => {
    if (event.data?.source === 'atomworks-annotation-studio' && event.data.type === 'ready') {
      await editorShows(event.data.session_id);
      await panel.reapplyOverlays();
    }
  });
})();
"""
