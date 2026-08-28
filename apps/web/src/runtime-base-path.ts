declare global {
  var __USHELF_BASE_PATH__: string | undefined;
}

export function resolveRuntimeBasePath(
  injected = globalThis.__USHELF_BASE_PATH__,
  buildBase = import.meta.env.BASE_URL,
): string {
  const value = injected?.trim() || buildBase || "/";
  if (value === "./") return "/";
  const absolute = value.startsWith("/") ? value : `/${value}`;
  return absolute.endsWith("/") ? absolute : `${absolute}/`;
}
