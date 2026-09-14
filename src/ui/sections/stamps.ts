import type { Section } from '../app';
import { h } from '../dom';

/** Placeholder: implemented in a follow-up. */
export const stampsSection: Section = {
  id: 'stamps',
  title: 'Stamps',
  mount(root) {
    root.append(h('div', { class: 'panel muted' }, 'Stamps: coming soon'));
    return () => undefined;
  },
};
