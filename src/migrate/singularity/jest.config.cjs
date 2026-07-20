/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest/presets/default",
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: false,
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/src/**/*.test.ts"],
  collectCoverageFrom: [
    "src/shared/**/*.ts",
    "src/engine/messageHandlers.ts",
    "!src/**/*.d.ts",
    "!src/**/*.test.ts",
  ],
  coverageThreshold: {
    global: {
      lines: 70,
    },
  },
  coverageReporters: ["text", "lcov"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
