import type { CompositionLayoutV1, PanelLayoutInstanceV1, PanelScopeV1 } from '@helmsman/plugin-sdk';

export function moveStack(layout: CompositionLayoutV1, id: string, targetColumn: number, targetPosition: number): CompositionLayoutV1 {
  const sourceColumn = layout.columns.findIndex(column => column.some(stack => stack.instances.includes(id)));
  const sourcePosition = layout.columns[sourceColumn]?.findIndex(stack => stack.instances.includes(id)) ?? -1;
  if (sourcePosition < 0 || !Number.isInteger(targetColumn) || !Number.isInteger(targetPosition)
    || targetColumn < 0 || targetColumn >= layout.columns.length || targetPosition < 0 || targetPosition > (layout.columns[targetColumn]?.length ?? 0)) return layout;
  const position = targetPosition - (sourceColumn === targetColumn && sourcePosition < targetPosition ? 1 : 0);
  if (sourceColumn === targetColumn && sourcePosition === position) return layout;
  const stack = layout.columns[sourceColumn]?.[sourcePosition];
  if (!stack) return layout;
  const columns = layout.columns.map(column => [...column]);
  columns[sourceColumn]?.splice(sourcePosition, 1);
  columns[targetColumn]?.splice(position, 0, stack);
  return { ...layout, columns };
}

export function changeInstance(layout: CompositionLayoutV1, id: string, changes: Partial<Pick<PanelLayoutInstanceV1, 'contributionId' | 'hidden' | 'scope'>>): CompositionLayoutV1 {
  const instances = layout.instances.map(instance => instance.instanceId === id ? { ...instance, ...changes } : instance);
  const columns = changes.hidden === true ? layout.columns.map(column => column.map(stack => {
    const visible = stack.instances.find(candidate => instances.some(instance => instance.instanceId === candidate && !instance.hidden));
    return stack.activeInstanceId === id && visible ? { ...stack, activeInstanceId: visible } : stack;
  })) : layout.columns;
  return { ...layout, instances, columns };
}

export function removeInstance(layout: CompositionLayoutV1, id: string): CompositionLayoutV1 {
  return { ...layout, instances: layout.instances.filter(instance => instance.instanceId !== id), columns: layout.columns.map(column => column.flatMap(stack => {
    const instances = stack.instances.filter(instance => instance !== id);
    const visible = instances.find(candidate => layout.instances.some(instance => instance.instanceId === candidate && !instance.hidden));
    return instances.length ? [{ ...stack, instances, activeInstanceId: stack.activeInstanceId === id ? visible ?? instances[0]! : stack.activeInstanceId }] : [];
  })) };
}

export function addInstance(layout: CompositionLayoutV1, contributionId: string, scope: PanelScopeV1 = { kind: 'inherit' }): CompositionLayoutV1 {
  const instanceId = crypto.randomUUID();
  const columns = layout.columns.length ? layout.columns.map(column => [...column]) : [[]];
  columns[0]!.push({ instances: [instanceId], activeInstanceId: instanceId, collapsed: false });
  return { ...layout, instances: [...layout.instances, { instanceId, contributionId, hidden: false, scope, state: {} }], columns };
}

export function stackInstance(layout: CompositionLayoutV1, id: string, targetId: string): CompositionLayoutV1 {
  if (id === targetId || !layout.instances.some(instance => instance.instanceId === id) || !layout.instances.some(instance => instance.instanceId === targetId)) return layout;
  const detached = removeInstance(layout, id);
  return { ...detached, instances: layout.instances, columns: detached.columns.map(column => column.map(stack => stack.instances.includes(targetId)
    ? { ...stack, instances: [...stack.instances, id], activeInstanceId: id, collapsed: false } : stack)) };
}

export function moveInstance(layout: CompositionLayoutV1, id: string, direction: 'up' | 'down' | 'left' | 'right'): CompositionLayoutV1 {
  const columnIndex = layout.columns.findIndex(column => column.some(stack => stack.instances.includes(id)));
  const stackIndex = layout.columns[columnIndex]?.findIndex(stack => stack.instances.includes(id)) ?? -1;
  if (columnIndex < 0 || stackIndex < 0) return layout;
  const detached = removeInstance(layout, id);
  const columns = detached.columns.map(column => [...column]);
  const horizontal = direction === 'left' || direction === 'right';
  const targetColumn = horizontal ? Math.max(0, Math.min(3, columnIndex + (direction === 'left' ? -1 : 1))) : columnIndex;
  while (columns.length <= targetColumn) columns.push([]);
  const position = horizontal ? columns[targetColumn]!.length : Math.max(0, stackIndex + (direction === 'up' ? -1 : 1));
  columns[targetColumn]!.splice(position, 0, { instances: [id], activeInstanceId: id, collapsed: false });
  return { ...detached, instances: layout.instances, columns };
}
