import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    //  `npx tsc` leaves compiled copies of the tests in dist/, which vitest would then collect
    //  and fail on (they `require('vitest')` outside a vitest-transformed module). Those six
    //  failures have been reported as "pre-existing" in several sessions; the sources are the
    //  only tests there are.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
})
