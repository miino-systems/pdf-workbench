/**
 * Entry point. Everything runs in the browser; the only network request the
 * app makes is fetching its own static bundle (and PDF.js' bundled font
 * data from the same origin).
 */
import './ui/styles.css';
import { configurePdfjsWorker } from '@/pdf/reader';
import { AppController } from '@/state/app';
import { mountApp } from '@/ui/app';
import { sections } from '@/ui/sections';

configurePdfjsWorker();

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

const ctrl = new AppController();
mountApp(root, ctrl, sections);
