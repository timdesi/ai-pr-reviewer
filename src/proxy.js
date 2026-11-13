// Route outbound HTTP(S) through the corporate egress proxy when configured.
//
// Node's global fetch (undici) ignores HTTP_PROXY/HTTPS_PROXY/NO_PROXY env
// vars unless a proxy dispatcher is installed. `undici` is only available in
// the container image (installed there at build time); local dev has no
// node_modules, so this is a safe no-op unless the module can be imported.

export async function initProxy() {
  const httpProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!httpProxy) return { enabled: false, via: null };
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const { log } = await import("./log.js");
    log.info(`outbound fetch via proxy ${httpProxy}`);
    return { enabled: true, via: httpProxy };
  } catch {
    return { enabled: false, via: null };
  }
}