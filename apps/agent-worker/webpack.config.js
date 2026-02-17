const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  entry: {
    main: join(__dirname, './src/main.ts'),
    // Увага: переконайтеся, що файл лежить саме в src/agent.logic.ts
    'agent.logic': join(__dirname, './src/agent.logic.ts'),
  },
  output: {
    path: join(__dirname, '../../dist/apps/agent-worker'),
    filename: '[name].js', // Повертаємо .js
    libraryTarget: 'commonjs', // Це дозволить LiveKit коректно імпортувати бандл
    clean: true,
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMap: true,
    }),
  ],
};
