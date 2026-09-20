export interface PluginPageDefinition {
  readonly id: string;
  readonly title: string;
  readonly slots: readonly string[];
  readonly panes: readonly string[];
}

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: 1;
  readonly pages: readonly PluginPageDefinition[];
}

export interface RegisteredPluginPage extends PluginPageDefinition {
  readonly contributionId: string;
  readonly pluginId: string;
  readonly canonicalPath: string;
}

export interface PageSlot {
  readonly id: string;
  readonly alias: string;
  readonly defaultContributionId: string;
}

export interface PageResolution {
  readonly contributionId: string;
  readonly slotId: string | null;
  readonly page: RegisteredPluginPage | null;
}
