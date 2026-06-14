module.exports = {
  displayName: 'agent-worker',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Seed dummy env before specs import shared-config (validates at module-load).
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/agent-worker',
};
