"""Build the Markdown guides without importing Studio or its scientific dependencies."""
import os

project = "AtomWorks Studio"
root_doc = "index"
extensions = ["myst_parser"]
exclude_patterns = ["_build", "requirements.txt"]
myst_heading_anchors = 3
html_theme = "alabaster"
html_title = project
templates_path = ["_templates"]
html_static_path = ["_static"]
html_css_files = ["studio.css"]
html_js_files = ["studio.js"]
# Usage analytics for the HOSTED documentation only. This build is also the guide bundled in the wheel and the
# documentation archive attached to a release, which people open on their own machines (often with proprietary
# structures loaded in the editor beside it), so a third-party script must not be in it. The hosted-docs job in
# release.yaml sets this variable for its own build; nothing else does.
if os.environ.get("STUDIO_DOCS_ANALYTICS") == "1":
    html_js_files.append(("https://scripts.simpleanalyticscdn.com/latest.js", {"async": "async", "defer": "defer"}))
html_sidebars = {"**": ["about.html", "navigation.html", "searchbox.html"]}
html_theme_options = {"description": "Structure editing", "show_powered_by": False}
html_show_sourcelink = False
html_show_sphinx = False
html_show_copyright = False
