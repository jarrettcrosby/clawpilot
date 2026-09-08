const POSTGRES_IMAGE = /^(?:pgvector\/pgvector:pg|postgres:)(16|18)(?:-|$)/u
const TMPFS_SIZE = /^[1-9]\d*[bkmg]?$/iu

export const DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV = 'CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE'

const configuredTmpfsSize = process.env[DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV]?.trim()
if (configuredTmpfsSize && !TMPFS_SIZE.test(configuredTmpfsSize)) {
  throw new Error(
    `${DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV} must be a positive byte count with an optional b, k, m, or g suffix`,
  )
}

export const DISPOSABLE_POSTGRES_TMPFS_SIZE = configuredTmpfsSize || '4g'

const DOCKER_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u

export function disposablePostgresDockerArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('Disposable PostgreSQL Docker arguments must be an array')
  }

  const action = args[0]
  if (action !== 'run' && action !== 'create') {
    throw new Error('Disposable PostgreSQL Docker action must be run or create')
  }

  const imageIndex = args.findIndex((argument) => (
    typeof argument === 'string' && POSTGRES_IMAGE.test(argument)
  ))
  if (imageIndex < 0) {
    throw new Error('Disposable PostgreSQL Docker image must be PostgreSQL 16 or 18')
  }

  const image = args[imageIndex]
  const major = image.match(POSTGRES_IMAGE)?.[1]
  const dataPath = major === '18'
    ? '/var/lib/postgresql'
    : '/var/lib/postgresql/data'
  const tmpfs = `${dataPath}:rw,size=${DISPOSABLE_POSTGRES_TMPFS_SIZE},mode=1777`
  const guarded = [...args]

  if (guarded.slice(1, imageIndex).includes('--tmpfs')) {
    throw new Error('Disposable PostgreSQL tmpfs storage is owned by the Docker argument guard')
  }

  if (!guarded.slice(1, imageIndex).includes('--rm')) {
    guarded.splice(1, 0, '--rm')
  }

  const guardedImageIndex = guarded.indexOf(image)
  guarded.splice(guardedImageIndex, 0, '--tmpfs', tmpfs)
  return guarded
}

export function disposablePostgresDockerCleanupArgs(containerName) {
  if (
    typeof containerName !== 'string'
    || !DOCKER_CONTAINER_NAME.test(containerName)
  ) {
    throw new Error('Disposable PostgreSQL cleanup requires one exact Docker container name')
  }

  return ['rm', '--force', '--volumes', containerName]
}
