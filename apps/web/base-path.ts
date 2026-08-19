export function resolveWebBasePath(value: string | undefined): string {
  const basePath = value?.trim() || "/";
  if (!basePath.startsWith("/")) {
    throw new Error("USHELF_WEB_BASE_PATH must start with /");
  }
  if (basePath.startsWith("//") || basePath.includes("?") || basePath.includes("#")) {
    throw new Error("USHELF_WEB_BASE_PATH must be a URL path");
  }
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}
