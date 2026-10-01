export function retainedRunTitle(taskJson: string | null | undefined): string | null {
  if (!taskJson) return null;
  try {
    const task: unknown = JSON.parse(taskJson);
    if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
    const title = (task as { title?: unknown }).title;
    if (typeof title !== 'string' || !title.trim() || /[\u0000-\u001f\u007f]/.test(title)) return null;
    return title.trim().slice(0, 512).replace(/[\uD800-\uDBFF]$/, '');
  } catch { return null; }
}
