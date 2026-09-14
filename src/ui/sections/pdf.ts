import type { Section } from '../app';
import { h } from '../dom';

/** Placeholder: implemented in a follow-up. */
export const pdfSection: Section = {
  id: 'pdf',
  title: 'PDF',
  mount(root) {
    root.append(h('div', { class: 'panel muted' }, 'PDF: coming soon'));
    return () => undefined;
  },
};
