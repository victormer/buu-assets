import terser from '@rollup/plugin-terser';

const banner = '/* buu-assets v1.0.0 | MIT License */';

export default [
  // UMD build (unminified)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/buu-assets.js',
      format: 'iife',
      name: 'BUU',
      banner,
      footer: '/* Loaded via: window.BUU */',
    },
  },
  // UMD build (minified)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/buu-assets.min.js',
      format: 'iife',
      name: 'BUU',
      banner,
    },
    plugins: [terser()],
  },
];
