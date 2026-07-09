// Test stub for the `server-only` marker package. In the Next build it throws
// if a server module is pulled into a client bundle; in the Vitest node
// environment there is no such boundary, so it resolves to a harmless no-op.
export {};
