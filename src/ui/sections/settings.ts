import type { Section } from '../app';
import { h } from '../dom';

/** Placeholder: implemented in a follow-up. */
export const settingsSection: Section = {
  id: 'settings',
  title: 'Settings',
  mount(root) {
    root.append(h('div', { class: 'panel muted' }, 'Settings: coming soon'));
    return () => undefined;
  },
};
