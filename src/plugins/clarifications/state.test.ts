import { describe, expect, it, vi } from 'vitest';
import type { PanelOpaqueStateV1, PluginPanelContext } from '@helmsman/plugin-sdk';
import { empty, readState } from './state';
import { SavedState } from './saved-state';
const draft = { repo: 'org/a', runId: 'run', questionId: 'question', text: 'Original' };
const wrap = (value: unknown): PanelOpaqueStateV1 => ({ version: 1, value });
const result = { requestId: '00000000-0000-4000-8000-000000000001', repo: 'org/a', runId: 'run', questionId: 'question', answer: 'Yes', status: 'succeeded', reason: null };
function store(input: PanelOpaqueStateV1 | null = null) {
  let persisted = input;
  const write = vi.fn(async (_expected: PanelOpaqueStateV1 | null, next: PanelOpaqueStateV1 | null) => { persisted = next; });
  const context = { state: { savedState: input }, signal: new AbortController().signal, compareAndSetState: write } as unknown as PluginPanelContext;
  return { saved: new SavedState(context, readState, empty, vi.fn()), write, current: () => persisted };
}
describe('authored question saved state', () => {
  it('retains valid drafts/results and rejects unsupported, duplicate, coercive and excessive values', () => {
    expect(readState(wrap({ drafts: [draft], results: [result] }))).toEqual({ drafts: [draft], results: [result] });
    for (const input of [{ version: 2, value: empty() }, wrap({ drafts: [draft, draft], results: [] }), wrap({ drafts: [], results: [{ ...result, status: ['succeeded'] }] }), wrap({ drafts: [], results: Array(33).fill(result) }), wrap({ drafts: [{ ...draft, text: 'x'.repeat(4001) }], results: [] })]) expect(readState(input)).toBeNull();
  });
  it('never overwrites unsupported state', async () => {
    const f = store({ version: 9, value: { future: true } }); f.saved.edit(value => value.drafts.push(draft)); expect(await f.saved.save()).toBe(false); expect(f.write).not.toHaveBeenCalled();
  });
  it('uses the exact baseline and retains dirty edits on external conflict until explicit reload', async () => {
    const original = wrap({ drafts: [draft], results: [] }); const f = store(original);
    f.saved.edit(value => { value.drafts[0]!.text = 'Local'; });
    const external = wrap({ drafts: [{ ...draft, text: 'Other tab' }], results: [] }); f.saved.receive(external);
    expect(await f.saved.save()).toBe(false); expect(f.saved.value.drafts[0]?.text).toBe('Local'); expect(f.write).not.toHaveBeenCalled();
    f.saved.reload(); expect(f.saved.value.drafts[0]?.text).toBe('Other tab');
    f.saved.edit(value => { value.drafts[0]!.text = 'Reviewed'; }); expect(await f.saved.save()).toBe(true); expect(f.write).toHaveBeenCalledWith(external, wrap({ drafts: [{ ...draft, text: 'Reviewed' }], results: [] }));
  });
  it('serializes newer local edits behind an in-flight save without losing either baseline', async () => {
    const f = store(); let release!: () => void; f.write.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve; }));
    f.saved.edit(value => value.drafts.push({ ...draft })); const pending = f.saved.save();
    f.saved.receive(wrap({ drafts: [draft], results: [] }));
    f.saved.edit(value => { value.drafts[0]!.text = 'Newer'; }); release(); expect(await pending).toBe(true);
    expect(f.write).toHaveBeenCalledTimes(2); expect(f.write.mock.calls[1]?.[0]).toEqual(wrap({ drafts: [draft], results: [] })); expect(f.saved.value.drafts[0]?.text).toBe('Newer');
  });
  it('retains quota-failed edits for explicit retry', async () => {
    const f = store(); f.write.mockRejectedValueOnce(new Error('Quota')); f.saved.edit(value => value.drafts.push(draft));
    expect(await f.saved.save()).toBe(false); expect(f.saved.value.drafts).toEqual([draft]); expect(await f.saved.save()).toBe(true); expect(f.write.mock.calls[1]?.[0]).toBeNull();
  });
});

it('preserves the full public repository limit in draft and result identities', () => {
  const repo = 'o/' + 'r'.repeat(510); const value = { drafts: [{ ...draft, repo }], results: [{ ...result, repo }] };
  expect(readState(wrap(value))).toEqual(value); expect(readState(wrap({ ...value, drafts: [{ ...draft, repo: repo + 'x' }] }))).toBeNull();
});

it('conditionally verifies an unchanged namespace before reporting durable state', async () => {
  const original = wrap({ drafts: [draft], results: [result] }); const f = store(original);
  f.write.mockRejectedValueOnce(new Error('Stale baseline'));
  expect(await f.saved.save()).toBe(false); expect(f.write).toHaveBeenCalledWith(original, original);
  expect(f.saved.value.results).toEqual([result]);
});
