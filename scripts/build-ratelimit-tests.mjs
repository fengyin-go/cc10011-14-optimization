/**
 * 测试打包器：把限速域的 TS 源码和测试用 esbuild 打成可在 Node 直接运行的 ESM。
 * 测试脚本与被测源码分离：源码在 frontend/src，测试在 workspace/scripts，产物在 .tmp-ratelimit-test。
 */
import { fileURLToPath, URL } from 'node:url'

// ESM 不走 NODE_PATH，按仓库相对位置直接定位前端依赖里的 esbuild
const esbuildEntry = fileURLToPath(new URL('../frontend/node_modules/esbuild/lib/main.js', import.meta.url))
const { build } = await import(esbuildEntry)

const root = fileURLToPath(new URL('..', import.meta.url))
const src = `${root}/frontend/src`
const outdir = `${root}/.tmp-ratelimit-test/build`

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir,
  alias: { '@': src },
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: {
    'engine.test': `${root}/scripts/test-ratelimit-engine.mjs`,
    'service.test': `${root}/scripts/test-ratelimit-service.mjs`,
    'smoke.test': `${root}/scripts/smoke-ratelimit-flow.mjs`,
  },
})
