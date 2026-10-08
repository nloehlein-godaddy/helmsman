import type { PluginJson } from '@helmsman/plugin-sdk';

export interface JiraLink { title: string; url: string; }
export interface NormalizedJiraIssue {
  externalId: string; displayKey: string; revision: string; title: string;
  state: 'ready' | 'in_progress' | 'review' | 'done' | 'blocked'; priority: number;
  requirements: { description: string; acceptanceCriteria: string[]; links: JiraLink[] };
  providerData: { version: 1; issueId: string; issueKey: string; statusId: string; statusName: string; assigneeAccountId: string | null;
    projectKey: string; contactHints: { assigneeId: string | null; reporterId: string | null } };
}
export function jiraRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) return null;
  }
  return value as Record<string, unknown>;
}
export function jiraText(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) throw new Error('Malformed or oversized Jira array');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) throw new Error('Malformed Jira array element');
  }
  return value;
}
export function jiraSafeUrl(value: unknown): string | null {
  if (!jiraText(value, 2048)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function bounded(value: string, maximum: number, label: string): string {
  if (new TextEncoder().encode(value).length > maximum || value.includes('\0')) throw new Error(`Jira ${label} exceeds its limit`);
  return value;
}
export function jiraRichText(value: unknown, links: JiraLink[] = []): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return bounded(value, 20_480, 'requirements');
  let nodes = 0;
  function render(input: unknown, depth: number): string {
    if (++nodes > 2000 || depth > 24) throw new Error('Jira rich-text structure exceeds its limit');
    const node = jiraRecord(input);
    if (!node || !jiraText(node.type, 64)) throw new Error('Malformed Jira rich-text node');
    const attrs = node.attrs === undefined ? null : jiraRecord(node.attrs);
    if (node.attrs !== undefined && !attrs) throw new Error('Malformed Jira rich-text attributes');
    if (node.type === 'text') {
      if (typeof node.text !== 'string') throw new Error('Malformed Jira text');
      let text = bounded(node.text, 20_480, 'text');
      for (const raw of node.marks === undefined ? [] : array(node.marks, 20)) {
        const mark = jiraRecord(raw);
        if (!mark || !jiraText(mark.type, 64)) throw new Error('Malformed Jira text mark');
        if (mark.type === 'link') {
          const url = jiraSafeUrl(jiraRecord(mark.attrs)?.href);
          if (url) { links.push({ title: text.slice(0, 240) || url, url }); text = `[${text}](${url})`; }
        }
      }
      return text;
    }
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'rule') return '\n---\n';
    if (node.type === 'mention') {
      if (jiraText(attrs?.text, 512)) return attrs.text;
      if (jiraText(attrs?.id, 320)) return `@${attrs.id}`;
      throw new Error('Malformed Jira mention');
    }
    if (node.type === 'emoji') {
      const text = attrs?.text ?? attrs?.shortName;
      if (!jiraText(text, 128)) throw new Error('Malformed Jira emoji');
      return text;
    }
    if (node.type === 'inlineCard' || node.type === 'blockCard') {
      const url = jiraSafeUrl(attrs?.url);
      if (!url) throw new Error('Invalid Jira requirement link');
      links.push({ title: url, url }); return url;
    }
    if (node.type === 'media' || node.type === 'mediaInline') {
      if ((attrs?.type !== 'file' && attrs?.type !== 'link') || !jiraText(attrs?.id, 512)) throw new Error('Malformed Jira media');
      if (node.content !== undefined) array(node.content, 0);
      const alt = attrs?.alt;
      if (alt !== undefined && (typeof alt !== 'string' || alt.length > 2048 || alt.includes('\0'))) throw new Error('Malformed Jira media alternative text');
      const label = typeof alt === 'string' ? alt.trim().replace(/[\\`*_[\]<>]/g, '\\$&') : '';
      return label ? `[Attachment: ${label}]` : '[Attachment]';
    }
    if (node.type === 'status' && jiraText(attrs?.text, 240)) return attrs.text;
    const children = node.content === undefined ? [] : array(node.content, 1000);
    if (!children.length && !['doc', 'paragraph', 'heading', 'codeBlock', 'tableCell', 'tableHeader'].includes(node.type)) throw new Error('Unsupported Jira requirement node');
    const rendered = children.map(child => render(child, depth + 1));
    const content = rendered.join('');
    if (node.type === 'codeBlock') {
      const language = typeof attrs?.language === 'string' && /^[a-z\d_-]{1,40}$/i.test(attrs.language) ? attrs.language : '';
      const longest = Math.max(2, ...[...content.matchAll(/~+/g)].map(match => match[0].length));
      const fence = '~'.repeat(longest + 1);
      return `\n${fence}${language}\n${content}\n${fence}\n`;
    }
    if (node.type === 'heading') return `\n${'#'.repeat(Number.isInteger(attrs?.level) && Number(attrs?.level) >= 1 && Number(attrs?.level) <= 6 ? Number(attrs?.level) : 2)} ${content}\n`;
    if (node.type === 'bulletList' || node.type === 'orderedList') return `\n${rendered.map((item, index) => `${node.type === 'bulletList' ? '-' : `${index + 1}.`} ${item.trim()}`).join('\n')}\n`;
    if (node.type === 'tableRow') return `${rendered.map(item => item.trim()).join(' | ')}\n`;
    if (node.type === 'blockquote') return `\n${content.trim().split('\n').map(line => `> ${line}`).join('\n')}\n`;
    return ['paragraph', 'doc', 'panel', 'table', 'expand', 'taskItem', 'decisionItem'].includes(node.type) ? `${content}\n` : content;
  }
  return bounded(render(value, 0).trim(), 20_480, 'requirements');
}
export function jiraPriority(value: unknown): number {
  if (!jiraText(value, 128)) return 3;
  const name = value.trim().toUpperCase();
  const explicit = /^P([0-4])\b/.exec(name)?.[1];
  if (explicit) return Number(explicit);
  if (name.includes('HIGHEST') || name === 'HIGH') return 1;
  if (name.includes('MEDIUM')) return 2;
  return name === 'LOWEST' ? 4 : 3;
}
function state(name: string, category: string): NormalizedJiraIssue['state'] {
  const lower = name.toLowerCase();
  if (lower.includes('blocked')) return 'blocked';
  if (lower.includes('review')) return 'review';
  if (lower.includes('progress')) return 'in_progress';
  if (category === 'done' || lower === 'done') return 'done';
  return category === 'indeterminate' ? 'in_progress' : 'ready';
}
export function normalizeJiraIssue(value: unknown): NormalizedJiraIssue {
  const issue = jiraRecord(value);
  const fields = jiraRecord(issue?.fields);
  const status = jiraRecord(fields?.status);
  const category = jiraRecord(status?.statusCategory);
  if (!issue || !fields || !jiraText(issue.id, 64) || !/^[1-9]\d*$/.test(issue.id) || !jiraText(issue.key, 128) || !/^[a-z][a-z\d_]*-\d+$/i.test(issue.key)
    || !jiraText(fields.summary, 240) || !jiraText(fields.updated, 128) || !Number.isFinite(Date.parse(fields.updated))
    || !jiraText(status?.id, 128) || !jiraText(status?.name, 240) || !jiraText(category?.key, 64)) throw new Error('Malformed Jira issue identity or state');
  const person = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const person = jiraRecord(value);
    if (!jiraText(person?.accountId, 320)) throw new Error('Malformed Jira account identity');
    return person.accountId;
  };
  const assignee = person(fields.assignee);
  const reporter = person(fields.reporter);
  const links: JiraLink[] = [];
  const description = jiraRichText(fields.description, links);
  const names = issue.names === undefined || issue.names === null ? {} : jiraRecord(issue.names);
  if (!names) throw new Error('Malformed Jira field names');
  const acceptanceCriteria: string[] = [];
  for (const [key, name] of Object.entries(names)) {
    if (typeof name !== 'string' || !/acceptance[\s_-]*criteria/i.test(name) || fields[key] === null || fields[key] === undefined) continue;
    const values = Array.isArray(fields[key]) ? array(fields[key], 32) : [fields[key]];
    for (const value of values) { const text = jiraRichText(value, links).trim(); if (text) acceptanceCriteria.push(bounded(text, 4096, 'acceptance criterion')); }
  }
  if (acceptanceCriteria.length > 32) throw new Error('Too many Jira acceptance criteria');
  for (const value of fields.attachment === undefined || fields.attachment === null ? [] : array(fields.attachment, 100)) {
    if (value === null) continue;
    const attachment = jiraRecord(value);
    const url = jiraSafeUrl(attachment?.content);
    if (!jiraText(attachment?.filename, 240) || !url) throw new Error('Malformed Jira attachment link');
    links.push({ title: attachment.filename, url });
  }
  const uniqueLinks = [...new Map(links.map(link => [link.url, link])).values()];
  if (uniqueLinks.length > 40) throw new Error('Too many Jira requirement links');
  const project = jiraRecord(fields.project)?.key;
  const projectKey = jiraText(project, 128) ? project : issue.key.slice(0, issue.key.lastIndexOf('-'));
  return { externalId: issue.id, displayKey: issue.key, revision: fields.updated, title: fields.summary.trim(), state: state(status.name, category.key), priority: jiraPriority(jiraRecord(fields.priority)?.name),
    requirements: { description, acceptanceCriteria, links: uniqueLinks },
    providerData: { version: 1, issueId: issue.id, issueKey: issue.key, statusId: status.id, statusName: status.name, assigneeAccountId: assignee, projectKey,
      contactHints: { assigneeId: assignee, reporterId: reporter } } };
}
export function normalizeJiraSubject(value: PluginJson): { accountId: string } {
  const body = jiraRecord(value);
  if (!jiraText(body?.accountId, 320) || body.active === false) throw new Error('Authenticated Jira subject is unavailable');
  return { accountId: body.accountId };
}
export function normalizeJiraCloudIdentity(value: PluginJson): { cloudId: string } | null {
  const body = jiraRecord(value);
  return jiraText(body?.cloudId, 128) && /^[a-z\d-]+$/i.test(body.cloudId) ? { cloudId: body.cloudId } : null;
}
