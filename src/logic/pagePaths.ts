export const LEGACY_PAGE_PATHS = {
  dashboard: '/helm',
  triage: '/triage',
  cmux: '/terminal',
  bugs: '/bugs',
  prs: '/prs',
  config: '/config',
  runs: '/runs',
  todos: '/todos',
  campaigns: '/campaigns',
  clarifications: '/clarifications',
} as const;

export const LEGACY_PAGE_ALIASES = {
  '/': 'dashboard',
  '/pr': 'prs',
  '/cmux': 'cmux',
} as const;
