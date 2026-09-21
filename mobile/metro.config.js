// Metro does not follow workspace symlinks on its own, and the failure looks
// like an unresolvable import rather than anything about the monorepo.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// packages/shared is consumed as source, so Metro has to watch it.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// npm hoists to the root; without this Metro can resolve two copies of React.
config.resolver.disableHierarchicalLookup = true;

/**
 * packages/shared is written for NodeNext, where a relative import carries a
 * `.js` suffix that means "the compiled form of the sibling .ts". The `api`
 * workspace requires that and Turbopack follows it; Metro is the only
 * resolver here that cannot, and it fails with "none of these files exist"
 * pointing at a .js that was never meant to exist on disk.
 *
 * Rather than force a build step on every consumer to satisfy one bundler,
 * the mapping lives here. Scoped deliberately: only relative imports, only
 * from our own source (never node_modules, where a .js really is a .js), and
 * only when the extensionless form actually resolves — so a genuine missing
 * module still fails loudly instead of being swallowed.
 */
const workspaceSource = path.resolve(workspaceRoot, 'packages');

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  const from = context.originModulePath ?? '';

  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    from.startsWith(workspaceSource) &&
    !from.includes('node_modules')
  ) {
    try {
      return resolve(context, moduleName.slice(0, -'.js'.length), platform);
    } catch {
      // Fall through, so the original error is the one reported.
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;
