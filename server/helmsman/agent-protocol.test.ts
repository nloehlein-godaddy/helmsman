/** @vitest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgentProtocol, type ProtocolRecord } from './agent-protocol';

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });

function child(script: string) {
  const value = spawn(process.execPath, ['-e', `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); ${script} });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(value);
  return value;
}

describe('agent protocol connection', () => {
  it('settles codex responses, rejects provider requests and forwards notifications', async () => {
    const messages: ProtocolRecord[] = []; const failures: Error[] = [];
    const process_ = child(`
      if (message.method === 'ping') { send({ id: 'p-1', method: 'approve', params: {} }); send({ method: 'note', params: { n: 1 } }); send({ id: message.id, result: { pong: true } }); }
      if (message.id === 'p-1') send({ method: 'replied', params: { code: message.error.code } });
    `);
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: message => messages.push(message), onFailure: error => failures.push(error) });
    expect(await connection.rpc('ping', {}, { ms: 2000, error: () => new Error('late') })).toEqual({ pong: true });
    await expect.poll(() => messages.map(message => message.method)).toEqual(['note', 'replied']);
    expect(messages[1]).toMatchObject({ params: { code: -32601 } });
    expect(failures).toEqual([]);
  });

  it('forwards a claude replay before settling its request', async () => {
    const order: string[] = [];
    const process_ = child(`send({ type: 'user', uuid: message.uuid });`);
    const connection = connectAgentProtocol(process_, { protocol: 'claude-stream-json', onMessage: () => order.push('message'), onFailure: () => {} });
    await connection.request('u-1', { type: 'user', uuid: 'u-1' }, null).then(() => order.push('ack'));
    expect(order).toEqual(['message', 'ack']);
    expect(connection.pendingCount()).toBe(0);
  });

  it('times out, rejects pending requests and reports malformed output', async () => {
    const failures: Error[] = [];
    const process_ = child(`if (message.method === 'bad') process.stdout.write('"text"\\n');`);
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: () => {}, onFailure: error => failures.push(error) });
    await expect(connection.rpc('silent', {}, { ms: 20, error: () => new Error('timed out') })).rejects.toThrow('timed out');
    const held = connection.rpc('held', {}, null);
    expect(connection.pendingCount()).toBe(1);
    connection.rejectPending(new Error('gone'));
    await expect(held).rejects.toThrow('gone');
    connection.write({ method: 'bad' });
    await expect.poll(() => failures.map(error => error.message)).toEqual(['Malformed agent protocol output']);
  });

  it('refuses writes after the child exits', async () => {
    const process_ = child('');
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: () => {}, onFailure: () => {} });
    process_.kill('SIGKILL');
    await new Promise(resolve => process_.once('exit', resolve));
    expect(() => connection.write({})).toThrow('Agent connection is closed');
  });
});
