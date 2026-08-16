import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('The Windows lock helper must be built on Windows')
}

const programFilesX86 = process.env['ProgramFiles(x86)']
if (!programFilesX86) throw new Error('ProgramFiles(x86) is unavailable')
const vswhere = path.join(
  programFilesX86,
  'Microsoft Visual Studio',
  'Installer',
  'vswhere.exe',
)
const installationPath = execFileSync(vswhere, [
  '-latest',
  '-products',
  '*',
  '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-property',
  'installationPath',
], { encoding: 'utf8' }).trim()
if (!installationPath) throw new Error('Visual Studio C++ build tools are unavailable')

const projectDirectory = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(projectDirectory, 'native', 'windows', 'clawpilot-print-lock.cpp')
const outputDirectory = path.join(projectDirectory, 'build', 'windows')
const outputPath = path.join(outputDirectory, 'clawpilot-print-lock.exe')
mkdirSync(outputDirectory, { recursive: true })
const developerCommand = path.join(
  installationPath,
  'Common7',
  'Tools',
  'VsDevCmd.bat',
)
const command = [
  `call "${developerCommand}" -arch=x64 -host_arch=x64`,
  '&&',
  'cl.exe',
  '/nologo',
  '/std:c++17',
  '/O2',
  '/MT',
  '/EHsc',
  '/DUNICODE',
  '/D_UNICODE',
  `"${sourcePath}"`,
  '/link',
  '/SUBSYSTEM:CONSOLE',
  `/OUT:"${outputPath}"`,
].join(' ')
const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
  cwd: outputDirectory,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  // The command already contains the exact quoting required by cmd.exe for
  // VsDevCmd.bat and the source/output paths. Node's default Windows argument
  // quoting escapes those embedded quotes, causing cmd to look for a literal
  // executable whose name begins with a quote on hosted runners.
  windowsVerbatimArguments: true,
})
if (result.error || result.status !== 0) {
  process.stderr.write(`${result.stdout || ''}${result.stderr || ''}`)
  throw result.error || new Error(`cl.exe failed with exit ${result.status}`)
}
process.stdout.write(`Built native Windows endpoint lock helper: ${outputPath}\n`)
