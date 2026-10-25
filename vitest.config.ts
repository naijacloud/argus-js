import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The transport tests use a fake clock; the node tests start real loopback
    // servers. Nothing here talks to the network.
    testTimeout: 30_000,
  },
});
