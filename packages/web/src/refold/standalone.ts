/**
 * The Refold panel as a module of its own (`/refold-panel.js` beside Studio's bundle), for a host page that is not
 * Studio: the Gradio host mounts it above an iframe of the editor, and drives that frame's `setOverlay` through
 * `options.overlay`. Inside Studio's own page, use `window.atomworksStudio.mountRefoldPanel` instead; both run this code.
 */
export * from "./index.ts";
