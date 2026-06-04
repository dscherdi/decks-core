/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        // Compile to CommonJS for the test runner so we don't need the
        // experimental ESM VM flag. Production build still ships ESM via tsup.
        tsconfig: {
          module: "commonjs",
          verbatimModuleSyntax: false,
          isolatedModules: true,
        },
      },
    ],
  },
};
