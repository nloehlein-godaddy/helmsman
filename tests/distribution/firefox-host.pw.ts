import { expect, test } from '@playwright/test';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('copied Firefox author package preserves independent browser selection through disablement and restart', async ({ request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  const pluginId = 'example.firefox';
  const providerId = `${pluginId}/firefox`;
  try {
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    const descriptor = await host.installAuthorPackage('plugin-sources/native-firefox', pluginId, { buildScript: true });
    expect(descriptor.backend.nativeTerminals.firefox.access).toEqual(['native-session']);
    const backend = pathToFileURL(join(host.root, 'author-plugin-sources-native-firefox/dist/backend.js')).href;
    expect(await host.script('firefox-author-proof.mjs', `
import assert from 'node:assert/strict';
const {default:backend}=await import(${JSON.stringify(backend)});
const cleanups=[];let provider;
await backend.activate({pluginId:${JSON.stringify(pluginId)},settings:{bidiEndpoint:'ws://127.0.0.1:1/session/11111111-1111-4111-8111-111111111111'},signal:new AbortController().signal,
registerNativeTerminal(id,value){assert.equal(id,'firefox');provider=value;},onDispose(work){cleanups.push(work);}});
assert.equal(provider?.metadata.browser,true);assert.ok(provider.browser);assert.ok(provider.sessionIdentity());
assert.equal((await provider.readScreen('unused',10)).ok,false);
assert.equal((await provider.send('unused','fixture',true)).ok,false);
assert.equal((await provider.sendKey('unused','Enter')).ok,false);
for(const cleanup of cleanups)await cleanup();console.log('FIREFOX_AUTHOR_ACCEPTED');`)).toContain('FIREFOX_AUTHOR_ACCEPTED');
    await host.cli('select-native-terminal', 'helmsman.terminal-wezterm/wezterm');
    await host.cli('select-browser-host', providerId);
    const dataModule = pathToFileURL(join(host.app, 'server/helmsman/plugins/data.js')).href;
    const selections = async () => JSON.parse(await host.script('firefox-selection.mjs', `
import {readNativeTerminalProviderSelection as read} from ${JSON.stringify(dataModule)};
console.log(JSON.stringify({terminal:read(process.env.HELMSMAN_PLUGINS_DIR,'terminal'),browser:read(process.env.HELMSMAN_PLUGINS_DIR,'browser')}));`));
    const original = await selections();
    expect(original).toMatchObject({ terminal: { providerId: 'helmsman.terminal-wezterm/wezterm' }, browser: { providerId } });
    const moduleUrl = (name: string) => pathToFileURL(join(host.app, 'server/helmsman', name)).href;
    const verifyRegistration = async (enabled: boolean) => host.script('firefox-registration.mjs', `
import assert from 'node:assert/strict';
import {loadPluginSnapshot} from ${JSON.stringify(moduleUrl('plugins/store.js'))};
import {activateBackendPlugins} from ${JSON.stringify(moduleUrl('plugins/backend.js'))};
import {resolveNativeTerminalSelection} from ${JSON.stringify(moduleUrl('native-terminal-selection.js'))};
const root=process.env.HELMSMAN_PLUGINS_DIR;
const runtime=await activateBackendPlugins({root,snapshot:await loadPluginSnapshot(root),usage:{query:async()=>{throw new Error('Unused fixture pricing');}}});
try {
assert.deepEqual(runtime.errors,[]);
const resolve=()=>resolveNativeTerminalSelection({root,registry:runtime.nativeTerminals,kind:'browser',defaultProviderId:'helmsman.terminal-cmux/cmux'});
if(${enabled})assert.equal(resolve().record.binding.providerId,${JSON.stringify(providerId)});
else assert.throws(resolve,/unavailable/);
}finally{await runtime.dispose();}`);
    await verifyRegistration(true);
    let origin = await host.start();
    expect((await request.get(`${origin}/api/plugins/catalog`)).ok()).toBe(true);
    await host.cli('disable', pluginId);
    expect(await selections()).toEqual(original);
    await verifyRegistration(false);
    origin = await host.start();
    expect((await request.get(`${origin}/api/plugins/catalog`)).ok()).toBe(true);
    expect(await selections()).toEqual(original);
    await host.cli('enable', pluginId);
    await host.start();
    await verifyRegistration(true);
    expect(await selections()).toEqual(original);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
