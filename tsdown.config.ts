import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/tool.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
  // Dependencies and peers resolve from the dsh installation and the profile;
  // only this package's source is bundled.
  external: [/^@deepseek-ai\//, /^node:/],
})
