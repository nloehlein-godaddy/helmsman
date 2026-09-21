import type { PluginPageModule } from '@helmsman/plugin-sdk';
import { NotificationView } from './notification-view.js';
const page: PluginPageModule = { mount(container, context) { if (context.services?.communication?.version !== 1) throw new Error('Notifications require version 1 communication services.'); return new NotificationView(container, context, true); } };
export default page;
