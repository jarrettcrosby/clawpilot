/** The BPO resolver authenticates with its own server-to-server bearer token.
 * @param {string} pathname
 * @param {string} method
 */
export function isPublicBpoShortlinkResolvePath(pathname, method) {
  return (method === 'GET' || method === 'HEAD')
    && /^\/api\/shortlinks\/bpo\/resolve\/[A-Za-z0-9_-]{3,64}$/.test(pathname)
}
