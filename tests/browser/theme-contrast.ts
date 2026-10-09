import { expect, type Locator } from '@playwright/test';

export async function expectReadableSurfaces(root: Locator, selectors: string[], minimum = 4.5) {
  const measured: { values: { selector: string; background: string; ratio: number }[] | null } = { values: null };
  await expect.poll(async () => {
    measured.values = await root.evaluate((node, selectors) => {
      if (!node.isConnected) return null;
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!channels || channels.length !== 3) throw new Error(`Unsupported color ${color}`);
        const linear = channels.map(value => { const channel = color.startsWith('color(srgb ') ? value : value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
        return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
      };
      const background = (element: Element): string => {
        const color = getComputedStyle(element).backgroundColor;
        return color === 'rgba(0, 0, 0, 0)' && element.parentElement ? background(element.parentElement) : color;
      };
      return selectors.map(selector => {
        const element = node.querySelector(selector);
        if (!element) throw new Error(`Missing contrast surface ${selector}`);
        const ink = luminance(getComputedStyle(element).color); const surface = background(element); const paper = luminance(surface);
        return { selector, background: surface, ratio: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) };
      });
    }, selectors);
    return measured.values !== null;
  }).toBe(true);
  for (const value of measured.values ?? []) expect(value.ratio, value.selector).toBeGreaterThanOrEqual(minimum);
  return measured.values ?? [];
}
