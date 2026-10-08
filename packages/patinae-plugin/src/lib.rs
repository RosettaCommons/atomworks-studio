use patinae_plugin::patinae_plugin;
use patinae_plugin::prelude::*;

patinae_plugin! {
    name: "annotation-studio",
    description: "Opens the shared AtomWorks Annotation Studio from Patinae desktop",
    commands: [AnnotationStudioCommand],
}

struct AnnotationStudioCommand;

fn editor_url(base_url: &str) -> Option<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return None;
    }
    Some(format!("{base_url}/?embed=1&viewer=patinae"))
}

impl Command for AnnotationStudioCommand {
    fn name(&self) -> &str {
        "annotation_studio"
    }

    fn execute<'v, 'r>(
        &self,
        ctx: &mut CommandContext<'v, 'r, dyn ViewerLike + 'v>,
        args: &ParsedCommand,
    ) -> CmdResult {
        let configured = args
            .get_str(0)
            .map(str::to_owned)
            .or_else(|| std::env::var("ANNOTATION_STUDIO_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:8000".to_owned());
        let Some(url) = editor_url(&configured) else {
            ctx.print("Annotation Studio URL must use http:// or https://");
            return Ok(());
        };
        match webbrowser::open(&url) {
            Ok(()) => ctx.print(&format!("Opened AtomWorks Annotation Studio: {url}")),
            Err(error) => ctx.print(&format!("Could not open {url}: {error}")),
        }
        Ok(())
    }

    command_help! {
        CMD "annotation_studio"
        DESCRIPTION ["opens the shared AtomWorks editor in desktop-app mode."]
        REQUIRED []
        OPTIONAL [
            { "server_url", "string", "hosted Annotation Studio URL", "ANNOTATION_STUDIO_URL or http://127.0.0.1:8000" },
        ]
        EXAMPLES ["annotation_studio", "annotation_studio https://studio.example.com"]
    }

    fn arg_hints(&self) -> &[ArgHint] {
        &[ArgHint::None]
    }
}

#[cfg(test)]
mod tests {
    use super::editor_url;

    #[test]
    fn builds_patinae_desktop_url() {
        assert_eq!(
            editor_url("https://studio.example.com/").as_deref(),
            Some("https://studio.example.com/?embed=1&viewer=patinae"),
        );
        assert_eq!(editor_url("file:///tmp/studio"), None);
    }
}
