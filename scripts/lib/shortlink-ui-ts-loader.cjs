const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const appRequire = createRequire(resolve(__dirname, '../../app_src/package.json'))
const ts = appRequire('typescript')

module.exports = function transformShortlinkFixture(source) {
  return ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
}
