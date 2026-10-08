---
title: AtomWorks Studio
sdk: docker
app_port: 7860
---

# AtomWorks Studio

This Docker Space runs the same editor and guide as the installed application.
It edits structures; it does not run a model.

Copy this directory to a new **private Docker Space**. Put the three wheels
`atomworks_studio`, `atomworks_studio_editing`, and
`atomworks_annotation_studio_rfd4` from a verified Studio build in `wheels/`.
The packages are not yet published on PyPI. Do not copy the PyMOL wheel here.
The Docker build installs public dependencies and runs as UID 1000 on port 7860.

To test locally from this directory:

```bash
docker build -t atomworks-studio-space .
docker run --rm -p 7860:7860 atomworks-studio-space
```

Open http://localhost:7860/ or http://localhost:7860/guide/.
Download CIFs you want to retain: the Space filesystem is ephemeral and sessions
expire. Space access controls protect the whole application; Studio does not
turn Hugging Face visitor identities into per-user session authorization.

For model inference, use the integration guide in Studio at `/guide/INTEGRATIONS.html`.
This image installs CPU Torch. A GPU model deployment must supply its own tested
CUDA environment, weights, and runner; selecting GPU hardware alone does not
turn this editor-only image into an inference server.
