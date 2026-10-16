/** HTTPS in production; localhost HTTP is reserved for local development and tests. */
export function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash && !url.search && (
      url.protocol === 'https:' ||
      (process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.hostname === 'localhost')
    )
  } catch {
    return false
  }
}
