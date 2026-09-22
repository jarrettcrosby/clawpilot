import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(root, 'app_src/package.json'))
const ts = require('typescript')

// Execute the actual route and authorization/helper sources; only the durable
// session/user lookup is faked. No database, provider request, or login bypass.
export function architectureHarness() {
  const state = {
    session: { authenticatedUser: 'owner@example.test', effectiveUser: 'owner@example.test', impersonating: false },
    actor: { email: 'owner@example.test', role: 'owner', status: 'active' },
    reads: 0, corrupt: false, missing: false,
  }
  let library
  function load(relative) {
    const module = { exports: {} }
    const code = ts.transpileModule(readFileSync(join(root, relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, Buffer, Headers, Response, Error, console,
      process: { cwd: () => join(root, 'app_src') },
      require(name) {
        if (name === 'server-only') return {}
        if (name === 'node:fs/promises') return { readFile: async (...args) => {
          state.reads++
          if (state.missing) throw new Error('Sensitive internal server path must not escape')
          const text = await readFile(...args)
          return state.corrupt && String(args[0]).endsWith('viewer.html') ? `${text}tampered` : text
        } }
        if (name.startsWith('node:')) return require(name)
        if (name === '@/lib/requestUser') return { requireRequestSession: async (request) => {
          if (!state.session || request?.headers?.get('x-test-deny') === '1') throw new Error('Unauthorized')
          return state.session
        } }
        if (name === '@/lib/users') return {
          requireActiveAppUser: async () => {
            if (!state.actor || state.actor.status !== 'active') throw new Error('Inactive')
            return state.actor
          },
          isRootAppOwner: (actor) => actor.role === 'owner' && actor.email === 'owner@example.test',
        }
        if (name === '@/lib/architectureViewer') return library
        throw new Error(`Unexpected architecture import: ${name}`)
      },
    }, { filename: relative })
    return module.exports
  }
  library = load('app_src/lib/architectureViewer.ts')
  return { state, library, metadata: load('app_src/app/api/settings/architecture/route.ts'), viewer: load('app_src/app/api/settings/architecture/viewer/route.ts') }
}
