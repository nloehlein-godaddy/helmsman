import type { PluginPanelModule } from '@helmsman/plugin-sdk';
import { NotificationView } from './notification-view.js';
const panel: PluginPanelModule = { mount(container, context) { if (context.services.communication?.version !== 1) throw new Error('Notifications require version 1 communication services.'); return new NotificationView(container, context, false); } };
export default panel;
