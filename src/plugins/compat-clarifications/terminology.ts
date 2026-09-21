export function terms(pirate: boolean) {
  return { run: pirate ? 'Voyage' : 'Run', clarifications: 'Agent Questions', allRepositories: pirate ? 'All galleons' : 'All repositories' };
}
