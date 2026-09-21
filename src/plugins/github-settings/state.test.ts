import { expect, it } from 'vitest';
import { parseGithubSettingsValuesV1 } from '../github-settings';
import { valuesReady } from './state';

it.each([
  ['', '', true],
  ['org/repo', 'dependabot[bot]', true],
  ['org/repo', 'valid-', true],
  ['org/.', 'person', false],
  ['org/..', 'person', false],
  ['org/repo', 'person[unknown]', false],
  ['org/' + 'a'.repeat(196), 'person', true],
  ['org/' + 'a'.repeat(197), 'person', false],
  ['org/repo', 'a'.repeat(101), false],
] as const)('keeps package and SDK validation aligned for %s / %s', (defaultRepo, author, valid) => {
  const values = { defaultRepo, author, reviewWatchEnabled: false };
  if (valid) expect(() => parseGithubSettingsValuesV1(values)).not.toThrow();
  else expect(() => parseGithubSettingsValuesV1(values)).toThrow();
  expect(valuesReady(values)).toBe(valid);
});
