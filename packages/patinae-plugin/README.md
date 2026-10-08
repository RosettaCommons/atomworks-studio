# AtomWorks Studio for Patinae

This native Patinae plugin opens the shared AtomWorks Studio service in
desktop-app mode with the Patinae renderer selected. It is intentionally a thin
launcher: CIF documents and sessions remain in the Studio
service.

## Prerequisites

Start Studio locally:

```bash
make run
```

The default service URL is `http://127.0.0.1:8000`. Set
`ANNOTATION_STUDIO_URL` when using a different local port or an HTTPS
deployment.

## Build and install

From the Studio repository root:

```bash
cargo build --release --locked -p patinae-annotation-studio
mkdir -p ~/.patinae/plugins
cp target/release/libpatinae_annotation_studio.* ~/.patinae/plugins/
```

Restart Patinae after installing the library.

## Open Studio

Run the Patinae command:

```text
annotation_studio
```

Pass a service URL directly when needed:

```text
annotation_studio https://studio.example.com
```

The launcher opens `?embed=1&viewer=patinae` for that service. If the URL is
invalid or cannot be opened, Patinae reports the error without changing the
active molecular session.

For browser workflows, see the [website guide](../../docs/WEB.md). For plugin
development and acceptance tests, see the
[development guide](../../docs/DEVELOPMENT.md#patinae-desktop).
