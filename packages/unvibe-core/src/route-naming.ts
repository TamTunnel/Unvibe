/**
 * Canonical route → file/component mapping.
 *
 * Single source of truth for the contract between the scaffold's App.tsx,
 * the regenerate prompt (which states the exact export name), and the
 * verify gate (which checks it). Lives in core so prompts, regenerate,
 * templates, and verify all agree.
 */
function routeSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
}

/** Repo-relative path of the generated page component for a route. */
export function routeToPageFile(path: string): string {
  return `src/pages/${routeSlug(path)}.tsx`;
}

/**
 * Exact default-export component name for a route's page.
 * src/App.tsx imports it as: `import HomePage from "./pages/home"`.
 */
export function routeToComponentName(path: string): string {
  const pascal = routeSlug(path)
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return `${pascal}Page`;
}

/**
 * Import specifier used by src/App.tsx for a route's page
 * (relative to src/, extensionless — resolvable by both Vite and tsc).
 */
export function routeToImportSpecifier(path: string): string {
  return './' + routeToPageFile(path).replace(/^src\//, '').replace(/\.tsx$/, '');
}
