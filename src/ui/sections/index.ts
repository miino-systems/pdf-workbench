import type { Section } from '../app';
import { workspaceSection } from './workspace';
import { pdfSection } from './pdf';
import { stampsSection } from './stamps';
import { sequenceSection } from './sequence';
import { preflightSection } from './preflight';
import { historySection } from './history';
import { settingsSection } from './settings';

/** Sections in tab order. */
export const sections: Section[] = [
  workspaceSection,
  pdfSection,
  stampsSection,
  sequenceSection,
  preflightSection,
  historySection,
  settingsSection,
];
