export function registerLifecycleHook(api, name, handler, opts = {}) {
  if (typeof api?.on === "function") {
    api.on(name, handler, opts);
    return true;
  }
  if (typeof api?.registerHook === "function") {
    api.registerHook(name, handler, opts);
    return true;
  }
  return false;
}
