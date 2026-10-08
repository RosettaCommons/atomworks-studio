"""Build the Markdown guides without importing Studio or its scientific dependencies."""

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
html_sidebars = {"**": ["about.html", "navigation.html", "searchbox.html"]}
html_theme_options = {"description": "Structure editing", "show_powered_by": False}
html_show_sourcelink = False
html_show_sphinx = False
html_show_copyright = False
