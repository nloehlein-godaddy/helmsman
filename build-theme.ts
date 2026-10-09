import type { Plugin } from 'vite';
import {
  DEFAULT_THEME_BACKGROUND,
  applyThemeToDocument,
  customThemeBootstrapSource,
  REQUIRED_VAR_KEYS,
} from './src/data/themes';

export function themeBootstrapScript(): string {
  const serialize = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
  return `(() => {
    ${customThemeBootstrapSource()}
    (${applyThemeToDocument.toString()})(customTheme, ${serialize(REQUIRED_VAR_KEYS)}, ${serialize(DEFAULT_THEME_BACKGROUND)});
  })();`;
}

export function themeBootstrapPlugin(): Plugin {
  return {
    name: 'helmsman-theme-bootstrap',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', children: themeBootstrapScript(), injectTo: 'head' }],
    },
  };
}
