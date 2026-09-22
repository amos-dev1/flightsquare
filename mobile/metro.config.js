// Metro does not follow workspace symlinks on its own, and the failure looks
// like an unresolvable import rather than anything about the monorepo.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

/**
 * `.svg` becomes source rather than an opaque asset, so the approved brand
 * artwork in `assets/` can be imported as a component.
 *
 * §11 says never to recreate the logo in CSS or from an icon library, and to
 * prefer the approved SVG. Inlining its path data into a `.tsx` would render
 * correctly today and is exactly how brand artwork drifts: the file in
 * `web/public` would change and the copy in code would not.
 *
 * This does not interact with the resolveRequest below — different hook,
 * different question.
 */
config.transformer.babelTransformerPath = require.resolve(
  'react-native-svg-transformer/expo',
);
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== 'svg');
config.resolver.sourceExts = [...config.resolver.sourceExts, 'svg'];

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
