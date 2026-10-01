import { term } from './logic/terminology';
import { validRepo } from './logic/repo';

export function selectStartupRepo(root: HTMLElement, initial: readonly string[], signal: AbortSignal,
  reload: () => Promise<readonly string[]>): Promise<string | undefined> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(undefined); return; }
    let repos: readonly string[] = [];
    const section = document.createElement('section'); section.className = 'startup-scope';
    const title = document.createElement('h1'); title.textContent = term('selectRepository');
    const form = document.createElement('form');
    const label = document.createElement('label'); label.textContent = term('scopeByRepository');
    const select = document.createElement('select'); select.name = 'startupRepo'; select.required = true;
    const notice = document.createElement('p'); notice.setAttribute('role', 'status');
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Continue';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Refresh';
    label.append(select); form.append(label, submit, retry); section.append(title, notice, form); root.replaceChildren(section);
    const populate = (values: readonly string[]) => {
      repos = [...new Set(values.filter(value => validRepo(value)))].sort();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = term('selectRepository'); placeholder.disabled = true; placeholder.selected = true;
      select.replaceChildren(placeholder);
      for (const repo of repos) { const option = document.createElement('option'); option.value = repo; option.textContent = repo; select.append(option); }
      submit.disabled = !repos.length; select.disabled = !repos.length;
      notice.textContent = repos.length ? term('startupScopePrompt') : term('startupScopeUnavailable');
    };
    const finish = (repo?: string) => { signal.removeEventListener('abort', abort); section.remove(); resolve(repo); };
    const abort = () => finish();
    signal.addEventListener('abort', abort, { once: true });
    form.addEventListener('submit', event => { event.preventDefault(); if (repos.includes(select.value)) finish(select.value); });
    retry.addEventListener('click', () => {
      retry.disabled = true;
      void reload().then(values => { if (!signal.aborted && section.isConnected) populate(values); })
        .catch(() => { if (!signal.aborted && section.isConnected) populate([]); })
        .finally(() => { retry.disabled = false; });
    });
    populate(initial); select.focus();
  });
}
