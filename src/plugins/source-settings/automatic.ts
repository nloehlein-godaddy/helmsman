import type { PluginPanelModule } from '@helmsman/plugin-sdk';
import { mountAdministration } from './panel.js';
const panel: PluginPanelModule = { mount(container, context) { return mountAdministration(container, context, true); } };
export default panel;
