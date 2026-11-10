// An empty stand-in for the "server-only" package, used only by the tests
// (see the alias in vitest.config.mts). The real package throws an error
// outside Next.js's server build, and the tests run server code directly.
export {};
