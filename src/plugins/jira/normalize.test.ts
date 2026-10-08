import { describe, expect, it } from 'vitest';
import { jiraPriority, jiraRichText, normalizeJiraCloudIdentity, normalizeJiraIssue, normalizeJiraSubject } from './normalize';

import { jiraIssue } from './fixtures';

describe('Jira source normalization', () => {
  it('keeps immutable issue identity separate from display keys and non-secret contact evidence', () => {
    const old = normalizeJiraIssue(jiraIssue());
    const renamed = normalizeJiraIssue({ ...jiraIssue(), key: 'MOVED-99' });
    expect(renamed.externalId).toBe(old.externalId);
    expect(renamed.displayKey).toBe('MOVED-99');
    expect(old.providerData.contactHints).toEqual({ assigneeId: null, reporterId: 'reporter-id' });
    expect(old.priority).toBe(1);
  });
  it('preserves rich requirements, code, acceptance fields and attachment links while excluding unrelated private fields', () => {
    const issue = jiraIssue({ description: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Keep the ratio.', marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'return value;' }] },
    ] }, customfield_42: 'No distortion.', unrelated: 'private-field',
    attachment: [null, { filename: 'example.png', content: 'https://jira.example.com/attachment/1', author: { emailAddress: 'private@example.com' } }] });
    const result = normalizeJiraIssue({ ...issue, names: { customfield_42: 'Acceptance Criteria', unrelated: 'Private field' } });
    expect(result.requirements.description).toContain('[Keep the ratio.](https://example.com/spec)');
    expect(result.requirements.description).toContain('~~~ts\nreturn value;\n~~~');
    expect(result.requirements.acceptanceCriteria).toEqual(['No distortion.']);
    expect(result.requirements.links).toEqual([{ title: 'Keep the ratio.', url: 'https://example.com/spec' }, { title: 'example.png', url: 'https://jira.example.com/attachment/1' }]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([null, {}, { ...jiraIssue(), id: 'TASK-1' }, jiraIssue({ status: null }), jiraIssue({ summary: 'x'.repeat(241) }), jiraIssue({ updated: 'not-a-date' }), jiraIssue({ assignee: {} })])('rejects invalid identities or required source state', value => {
    expect(() => normalizeJiraIssue(value)).toThrow();
  });
  it('rejects malformed, sparse, accessor-bearing, and oversized requirements without truncation', () => {
    const sparse: unknown[] = []; sparse.length = 1;
    expect(() => jiraRichText({ type: 'doc', content: sparse })).toThrow();
    expect(() => jiraRichText({ type: 'doc', content: [{ get type() { throw new Error('Getter must not execute'); } }] })).toThrow('Malformed');
    expect(() => jiraRichText('😀'.repeat(5121))).toThrow('limit');
    expect(() => jiraRichText({ type: 'doc', content: [{ type: 'unsupported-media', attrs: { private: 'data' } }] })).toThrow('Unsupported');
    expect(() => normalizeJiraIssue(jiraIssue({ attachment: [{ filename: 'spec', content: 'javascript:alert(1)' }] }))).toThrow();
  });
  it('retains Jira media alternatives and attachment placeholders without constructing media URLs', () => {
    const result = normalizeJiraIssue(jiraIssue({ description: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Use this layout.' }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'media-1', collection: '', alt: 'Expected layout', localId: 'private-local-id', width: 640, height: 480 } }] },
      { type: 'mediaGroup', content: [{ type: 'media', attrs: { type: 'file', id: 'media-2', alt: '' } }] },
      { type: 'paragraph', content: [{ type: 'mediaInline', attrs: { type: 'link', id: 'media-3' } }] },
    ] }, attachment: [{ filename: 'layout.png', content: 'https://jira.example.com/attachment/1' }] }));
    expect(result.requirements.description).toContain('Use this layout.');
    expect(result.requirements.description).toContain('[Attachment: Expected layout]');
    expect(result.requirements.description.match(/\[Attachment\]/g)).toHaveLength(2);
    expect(result.requirements.links).toEqual([{ title: 'layout.png', url: 'https://jira.example.com/attachment/1' }]);
    expect(JSON.stringify(result)).not.toContain('media-');
    expect(JSON.stringify(result)).not.toContain('private-local-id');
  });
  it('renders media alternative text as a label rather than Markdown links', () => {
    const links: { title: string; url: string }[] = [];
    expect(jiraRichText({ type: 'media', attrs: { type: 'file', id: '1', alt: '[click](javascript:alert(1))' } }, links))
      .toBe('[Attachment: \\[click\\](javascript:alert(1))]');
    expect(links).toEqual([]);
  });
  it.each([
    { type: 'media' },
    { type: 'media', attrs: { type: 'file' } },
    { type: 'media', attrs: { type: 'unsupported', id: '1' } },
    { type: 'media', attrs: { type: 'file', id: '1', alt: {} } },
    { type: 'media', attrs: { type: 'file', id: '1', alt: 'x'.repeat(2049) } },
    { type: 'media', attrs: { type: 'file', id: '1', alt: '\0' } },
    { type: 'media', attrs: { type: 'file', id: '1' }, content: [{ type: 'text', text: 'unexpected' }] },
    { type: 'mediaGroup', content: [] },
  ])('rejects malformed or unsupported media instead of silently discarding it', value => {
    expect(() => jiraRichText(value)).toThrow();
  });
  it('normalizes priority and state using the existing Jira display policy', () => {
    expect(['P0 critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest', null].map(jiraPriority)).toEqual([0, 1, 1, 2, 3, 4, 3]);
    expect(normalizeJiraIssue(jiraIssue({ status: { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } } })).state).toBe('review');
    expect(normalizeJiraIssue(jiraIssue({ status: { id: '4', name: 'Blocked', statusCategory: { key: 'indeterminate' } } })).state).toBe('blocked');
  });
  it('requires an authenticated account and never treats base URL/server information as cloud authority', () => {
    expect(normalizeJiraSubject({ accountId: 'subject', emailAddress: 'private@example.com' })).toEqual({ accountId: 'subject' });
    expect(() => normalizeJiraSubject({ name: 'display-name' })).toThrow();
    expect(normalizeJiraCloudIdentity({ cloudId: 'cloud-123' })).toEqual({ cloudId: 'cloud-123' });
    expect(normalizeJiraCloudIdentity({ baseUrl: 'https://jira.example.com', serverTitle: 'Same title' })).toBeNull();
  });
});
