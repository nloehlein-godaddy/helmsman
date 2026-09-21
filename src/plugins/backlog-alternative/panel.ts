import type { PluginPanelModule, TaskReadTaskV1 } from '@helmsman/plugin-sdk';

const panel: PluginPanelModule = {
  mount(container, context) {
    const tasks = context.services.tasks;
    if (tasks?.version !== 1) throw new Error('Task table requires version 1 task reads');
    const service = tasks;
    let state = context.state;
    let disposed = false;
    let generation = 0;
    let request: AbortController | null = null;
    let pending: Promise<void> | null = null;
    let rows: { label: string; task: TaskReadTaskV1 }[] = [];
    let messages: string[] = [];
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
    function cancel() { generation++; request?.abort(); request = null; pending = null; }
    function draw() {
      if (disposed) return;
      const root = node('section'); root.className = 'alternative-backlog';
      root.append(node('style', '.alternative-backlog{font:14px var(--sans,sans-serif);color:var(--text);overflow:auto}.alternative-backlog table{border-collapse:collapse;width:100%}.alternative-backlog th,.alternative-backlog td{padding:9px;text-align:left;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.alternative-backlog a{color:var(--accent)}.alternative-backlog button{font:inherit;padding:6px;border:1px solid var(--line-strong);background:var(--face-hi);color:var(--text)}.alternative-backlog h2{font-size:15px}.alternative-backlog :is(a,button):focus-visible{outline:2px solid var(--accent);outline-offset:2px}'), node('h2', 'Ready task table'));
      const refresh = node('button', pending ? 'Reading tasks…' : 'Reload tasks'); refresh.type = 'button'; refresh.disabled = Boolean(pending); refresh.addEventListener('click', () => { void read(); }); root.append(refresh);
      for (const message of messages) { const status = node('p', message); status.setAttribute('role', 'status'); root.append(status); }
      const table = node('table'); const head = node('thead'); const headings = node('tr');
      for (const title of ['Task', 'Source', state.pirateMode ? 'Galleon' : 'Repository']) { const heading = node('th', title); heading.scope = 'col'; headings.append(heading); } head.append(headings); table.append(head);
      const body = node('tbody');
      for (const row of rows) {
        const tr = node('tr'); const title = node('td');
        if (row.task.url) { const link = node('a', `${row.task.displayKey}: ${row.task.title}`); link.href = row.task.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; title.append(link); }
        else title.textContent = `${row.task.displayKey}: ${row.task.title}`;
        tr.append(title, node('td', row.label), node('td', row.task.repo)); body.append(tr);
      }
      table.append(body); root.append(table);
      if (!rows.length) root.append(node('p', pending ? 'Reading ready tasks…' : 'No ready tasks returned.'));
      container.replaceChildren(root);
    }
    function read(): Promise<void> {
      if (disposed || !state.visible || !state.activity.active || state.activity.signal.aborted) return Promise.resolve();
      if (pending) return pending;
      const epoch = ++generation; const controller = new AbortController(); request = controller;
      const current = () => !disposed && epoch === generation && state.activity.active && !state.activity.signal.aborted;
      pending = Promise.resolve().then(async () => {
        const discovery = await service.discover(controller.signal); if (!current()) return;
        rows = []; messages = [];
        if (discovery.status === 'unavailable') { messages = [`Task discovery unavailable: ${discovery.reason}.`]; return; }
        const sources = discovery.value.galleons.flatMap(galleon => {
          if (galleon.sources.status === 'available') return galleon.sources.value;
          messages.push(`${galleon.repo}: ${galleon.sources.reason}.`); return [];
        });
        if (sources.length > 50) messages.push('The table includes the first 50 source views.');
        for (const source of sources.slice(0, 50)) {
          if (!current()) return;
          if (source.availability !== 'available') { messages.push(`${source.label}: ${source.availability}.`); continue; }
          const result = await service.list({ ...source, state: 'ready', cursor: null, limit: 25 }, controller.signal); if (!current()) return;
          if (result.status === 'unavailable') { messages.push(`${source.label}: ${result.reason}.`); continue; }
          rows.push(...result.value.items.map(task => ({ label: source.label, task })));
          if (result.value.nextCursor) messages.push(`${source.label}: showing the first 25 ready tasks.`);
        }
      }).catch(() => { if (current() && !controller.signal.aborted) messages = ['Task reads failed. Reload to retry.']; })
        .finally(() => { if (current()) { pending = null; request = null; draw(); } });
      draw(); return pending;
    }
    function dispose() {
      if (disposed) return; disposed = true; cancel(); context.signal.removeEventListener('abort', dispose); state.activity.signal.removeEventListener('abort', cancel);
    }
    context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true }); state.activity.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) dispose(); else { draw(); void read(); }
    return {
      update(next) {
        if (disposed) return;
        const previous = state; state = next;
        if (previous.activity.signal !== next.activity.signal) { previous.activity.signal.removeEventListener('abort', cancel); next.activity.signal.addEventListener('abort', cancel, { once: true }); }
        if (previous.activity.epoch !== next.activity.epoch || previous.repo !== next.repo) { cancel(); rows = []; messages = []; }
        if (!next.visible || !next.activity.active) cancel(); draw();
        if (next.visible && next.activity.active && (previous.activity.epoch !== next.activity.epoch || !previous.visible || !previous.activity.active)) void read();
      }, refresh: read, dispose,
    };
  },
};
export default panel;
