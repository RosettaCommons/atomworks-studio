/**
 * The Design card as a module of its own (`/design-card.js` beside Studio's bundle), for a host page that mounts the
 * card without Studio's own page around it (a page with Studio in a frame, or one that drives Studio through its REST
 * API). Inside Studio's own page, use `window.atomworksStudio.mountDesignCard`; both run this code.
 */
export * from "./index.ts";
