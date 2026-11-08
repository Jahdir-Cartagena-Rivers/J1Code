/** Foreign conversation ids are namespaced; links always return to the owning environment. */
export function routeEndpointUrl(endpoint: { environmentId: string; threadId: string }): string {
  const native = /^mausbot:([\w-]{1,120}):([\w-]{1,120})$/.exec(endpoint.threadId);
  return native
    ? `/assistants?environmentId=${encodeURIComponent(endpoint.environmentId)}&botId=${encodeURIComponent(native[1]!)}&conversation=${encodeURIComponent(native[2]!)}`
    : `/${encodeURIComponent(endpoint.environmentId)}/${encodeURIComponent(endpoint.threadId)}`;
}
