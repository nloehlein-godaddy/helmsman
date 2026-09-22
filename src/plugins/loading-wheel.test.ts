import { afterEach, describe, expect, it } from 'vitest';
import { createLoadingWheelV1, loadingWheelStylesV1 } from './loading-wheel';

afterEach(() => { document.body.replaceChildren(); });

describe('public loading wheel', () => {
  it('renders a code-native accessible ship wheel with scoped reduced-motion styles', () => {
    const wheel = createLoadingWheelV1('Loading runs…');
    document.body.append(wheel);
    expect(wheel.getAttribute('role')).toBe('status');
    expect(wheel.getAttribute('aria-live')).toBe('polite');
    expect(wheel.getAttribute('aria-busy')).toBe('true');
    expect(wheel.textContent).toContain('Loading runs…');
    expect(wheel.querySelector('svg[aria-hidden="true"] line')).not.toBeNull();
    expect(wheel.querySelector('img')).toBeNull();
    expect(loadingWheelStylesV1).toContain('@media (prefers-reduced-motion:reduce)');
  });

  it('keeps its caller-provided status text safe when input is missing', () => {
    expect(createLoadingWheelV1('', { label: 'Loading saved runs…' }).textContent).toContain('Loading saved runs…');
    expect(createLoadingWheelV1('').textContent).toContain('Loading…');
  });
});
