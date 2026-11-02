import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Deployment keeps timestamped `.backup-*` copies of this directory beside
    // the live one. They contain their own `tests/`, which vitest would
    // otherwise discover and run against the stale `src/` next to them — the
    // suite then reports more tests than this package has.
    exclude: ['**/node_modules/**', '**/.backup-*/**'],
  },
})
