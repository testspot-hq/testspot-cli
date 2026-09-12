import { build } from 'esbuild'

for (const name of ['testpilot', 'testspot']) {
  await build({
    entryPoints: [name === 'testspot' ? 'src/testspot.ts' : 'src/index.ts'],
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: `${name}.mjs`,
    banner: { js: "import{createRequire as ___cr}from'node:module';const require=___cr(import.meta.url);" },
  })
}
