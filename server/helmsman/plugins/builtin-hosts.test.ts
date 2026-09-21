import { describe, expect, it } from 'vitest';
import { builtinExecutionHosts } from './builtin-hosts';

describe('builtin execution hosts', () => {
  it('publishes the local and Docker host-only catalogs with retained settings', () => {
    expect(builtinExecutionHosts.map(entry => entry.package.manifest.id)).toEqual([
      'helmsman.host-local',
      'helmsman.host-docker',
    ]);
    const [local, docker] = builtinExecutionHosts.map(entry => entry.package.backend);
    expect(local?.provides.map(value => value.localId)).toEqual(['detached', 'cmux', 'wezterm']);
    expect(local?.executionHosts).toEqual({
      detached: { access: ['execution'] },
      cmux: { access: ['execution'] },
      wezterm: { access: ['execution'] },
    });
    expect(local?.settings).toMatchObject({
      cmuxSocketPath: { default: '' },
      weztermBin: { default: 'wezterm' },
      weztermRunWorkspace: { default: 'helmsman-runs' },
    });
    expect(docker?.provides.map(value => value.localId)).toEqual(['docker']);
    expect(docker?.settings.image).toMatchObject({ default: 'helmsman-agent:latest', maxLength: 256 });
  });
});
