import type { Section } from '../app';
import { h } from '../dom';

/** Placeholder: implemented in a follow-up. */
export const historySection: Section = {
  id: 'history',
  title: 'History',
  mount(root) {
    root.append(h('div', { class: 'panel muted' }, 'History: coming soon'));
    return () => undefined;
  },
};
