import type { Section } from '../app';
import { h } from '../dom';

/** Placeholder: implemented in a follow-up. */
export const preflightSection: Section = {
  id: 'preflight',
  title: 'Preflight',
  mount(root) {
    root.append(h('div', { class: 'panel muted' }, 'Preflight: coming soon'));
    return () => undefined;
  },
};
